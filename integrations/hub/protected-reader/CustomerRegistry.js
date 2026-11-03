// Private metadata feed. Read-only Sheets scope; no Customer/Delivery/trigger writes.
// Incremental identity relies on the Customer writer updating updatedAt with metadata changes.
const PROTECTED_REGISTRY_={contract:'customer-registry-v1',prefix:'customer_registry_v1:',ttl:21600,maxRows:30000};
function protectedRegistryFail_(code){throw Error('REGISTRY_'+code);}
// Keep bulk index shards separate from HMAC nonce/rate-limit ScriptCache entries.
function protectedRegistryCache_(){return CacheService.getUserCache();}
function protectedRegistryKey_(version){return PROTECTED_REGISTRY_.prefix+'index:'+version;}
function protectedRegistryLoad_(version){
  if(!/^[a-f0-9]{64}$/.test(version||''))return null;
  const cache=protectedRegistryCache_(),raw=cache.get(protectedRegistryKey_(version));if(!raw)return null;
  let meta,rows=[],selections={};try{
    meta=JSON.parse(raw);if(meta.version!==version||!Array.isArray(meta.shards)||meta.shards.length>990)return null;
    const keys=meta.shards.map(function(h,i){return PROTECTED_REGISTRY_.prefix+version+':'+i;}),found=cache.getAll(keys);
    for(let i=0;i<keys.length;i++){const s=found[keys[i]];if(!s||protectedSearchHash_(s)!==meta.shards[i])return null;JSON.parse(s).forEach(function(v){rows.push(v.row);selections[v.row.customerCode]=v.selection;});}
    if(rows.length!==meta.sourceCount||protectedSearchHash_(JSON.stringify({sourceRows:meta.sourceRows,lifecycleField:meta.lifecycleField,rows:rows}))!==version)return null;
  }catch(_){return null;}
  return {version:version,sourceVersion:meta.sourceVersion,sourceRows:meta.sourceRows,sourceCount:rows.length,sourceUniqueCodes:meta.sourceUniqueCodes,exclusions:meta.exclusions,conflicts:meta.conflicts,lifecycleField:meta.lifecycleField,rows:rows,selections:selections};
}
function protectedRegistrySave_(index){
  const cache=protectedRegistryCache_(),parts=[],values={},rows=index.rows;let group=[],size=2;
  for(let i=0;i<rows.length;i++){const value={row:rows[i],selection:index.selections[rows[i].customerCode]},n=JSON.stringify(value).length+1;if(group.length&&size+n>24000){parts.push(JSON.stringify(group));group=[];size=2;}group.push(value);size+=n;}
  if(group.length)parts.push(JSON.stringify(group));if(parts.length>990)protectedRegistryFail_('CACHE_LIMIT');
  parts.forEach(function(s,i){values[PROTECTED_REGISTRY_.prefix+index.version+':'+i]=s;});if(parts.length)cache.putAll(values,PROTECTED_REGISTRY_.ttl);
  const meta={version:index.version,sourceVersion:index.sourceVersion,sourceRows:index.sourceRows,sourceCount:rows.length,sourceUniqueCodes:index.sourceUniqueCodes,exclusions:index.exclusions,conflicts:index.conflicts,lifecycleField:index.lifecycleField,shards:parts.map(protectedSearchHash_)};
  cache.put(protectedRegistryKey_(index.version),JSON.stringify(meta),PROTECTED_REGISTRY_.ttl);
}
function protectedRegistryLifecycle_(field,value){
  if(!field)return 'ACTIVE';
  if(field==='deletedAt'){if(value===''||value==null)return 'ACTIVE';if(protectedSearchTime_(value)!==null)return 'DELETED';}
  if(field==='isDeleted'){if(value===true||value===1||value==='true')return 'DELETED';if(value===false||value===0||value==='false'||value===''||value==null)return 'ACTIVE';}
  if(field==='lifecycle'&&(value==='ACTIVE'||value==='DELETED'))return value;
  protectedRegistryFail_('LIFECYCLE_VALUE');
}
function protectedRegistryColumn_(n){let s='';for(n++;n>0;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;}
function protectedRegistryMetadata_(id,field){
  const metadata=Sheets.Spreadsheets.get(id,{fields:'sheets.properties'}),item=(metadata.sheets||[]).filter(function(s){return s.properties.title==='customers';})[0];
  if(!item||item.properties.gridProperties.columnCount>128)protectedRegistryFail_('SOURCE_CONTRACT');
  const header=(Sheets.Spreadsheets.Values.get(id,"'customers'!1:1",{valueRenderOption:'UNFORMATTED_VALUE'}).values||[])[0]||[],required=['customerCode','customerName','customerAddress','updatedAt'].concat(field?[field]:[]),positions={};
  required.forEach(function(n){const i=header.indexOf(n);if(i<0||i!==header.lastIndexOf(n))protectedRegistryFail_('SOURCE_HEADERS');positions[n]=i;});
  const options={valueRenderOption:'UNFORMATTED_VALUE',dateTimeRenderOption:'SERIAL_NUMBER'},cap=Math.max(2,Math.min(PROTECTED_REGISTRY_.maxRows+2,item.properties.gridProperties.rowCount)),names=['customerCode','updatedAt'].concat(field?[field]:[]);
  const ranges=names.map(function(n){const c=protectedRegistryColumn_(positions[n]);return "'customers'!"+c+'2:'+c+cap;}),answer=Sheets.Spreadsheets.Values.batchGet(id,Object.assign({ranges:ranges},options));
  if(!answer.valueRanges||answer.valueRanges.length!==names.length)protectedRegistryFail_('SOURCE_INCOMPLETE');
  const columns=answer.valueRanges.map(function(r){return r.values||[];}),count=Math.max.apply(null,columns.map(function(c){return c.length;}));if(count>PROTECTED_REGISTRY_.maxRows)protectedRegistryFail_('SOURCE_LIMIT');
  const byCode=new Map(),blocked=new Set(),unique=new Set(),read=function(c,r){return columns[c]&&columns[c][r]&&columns[c][r][0]!=null?columns[c][r][0]:'';};let exclusions=0;
  for(let i=0;i<count;i++){
    const code=String(read(0,i)).trim().toUpperCase(),stamp=read(1,i);if(!code){if(stamp!==''||field&&read(2,i)!=='')exclusions++;continue;}
    unique.add(code);if(!/^[A-Z]\d{1,20}$/.test(code)){exclusions++;continue;}
    const time=protectedSearchTime_(stamp);if(time===null){exclusions++;blocked.add(code);continue;}
    let lifecycle;try{lifecycle=protectedRegistryLifecycle_(field,read(2,i));}catch(_){exclusions++;blocked.add(code);continue;}
    const old=byCode.get(code),candidate={index:i,time:time,lifecycle:lifecycle};
    if(!old||old.time<time)byCode.set(code,{time:time,candidates:[candidate]});else if(old.time===time)old.candidates.push(candidate);
  }
  blocked.forEach(function(code){byCode.delete(code);});if(!byCode.size)protectedRegistryFail_('SOURCE_EMPTY');
  return {sourceVersion:protectedSearchHash_(JSON.stringify({positions:positions,columns:columns})),sourceRows:count,sourceUniqueCodes:unique.size,exclusions:exclusions,positions:positions,byCode:byCode,options:options};
}
function protectedRegistryBuild_(id,field,meta,old){
  const oldRows=new Map((old?old.rows:[]).map(function(r){return [r.customerCode,r];})),rows=[],selections={},changed=[];
  meta.byCode.forEach(function(value,code){const selection=protectedSearchHash_(JSON.stringify(value.candidates));selections[code]=selection;if(old&&old.selections[code]===selection&&oldRows.has(code))rows.push(oldRows.get(code));else changed.push({code:code,candidates:value.candidates});});
  const selected=new Map(),columns=['customerName','customerAddress'];let exclusions=meta.exclusions,conflicts=0;
  if(!old){
    const ranges=columns.map(function(n){const c=protectedRegistryColumn_(meta.positions[n]);return "'customers'!"+c+'2:'+c+(meta.sourceRows+1);}),answer=Sheets.Spreadsheets.Values.batchGet(id,Object.assign({ranges:ranges},meta.options));
    if(!answer.valueRanges||answer.valueRanges.length!==2)protectedRegistryFail_('SOURCE_INCOMPLETE');
    changed.forEach(function(v){v.candidates.forEach(function(c){selected.set(c.index,answer.valueRanges.map(function(r){return r.values&&r.values[c.index]&&r.values[c.index][0]!=null?r.values[c.index][0]:'';}));});});
  }else{
    const positions=[];changed.forEach(function(v){v.candidates.forEach(function(c){positions.push(c.index);});});
    for(let i=0;i<positions.length;i+=50){const batch=positions.slice(i,i+50),ranges=[];batch.forEach(function(pos){columns.forEach(function(n){const c=protectedRegistryColumn_(meta.positions[n]);ranges.push("'customers'!"+c+(pos+2)+':'+c+(pos+2));});});const answer=Sheets.Spreadsheets.Values.batchGet(id,Object.assign({ranges:ranges},meta.options));
      if(!answer.valueRanges||answer.valueRanges.length!==ranges.length)protectedRegistryFail_('SOURCE_INCOMPLETE');batch.forEach(function(pos,j){selected.set(pos,[0,1].map(function(n){const v=answer.valueRanges[j*2+n].values;return v&&v[0]&&v[0][0]!=null?v[0][0]:'';}));});}
  }
  changed.forEach(function(v){let chosen=null,conflict=false,invalid=false;v.candidates.forEach(function(c){const values=selected.get(c.index),name=String(values[0]).normalize('NFKC').trim(),address=String(values[1]).normalize('NFKC').replace(/\s+/g,' ').trim();
    if(name.length>200||address.length>500||/[\u0000-\u001f]/.test(name)||/(?:01[016789])[- ]?\d{3,4}[- ]?\d{4}|비밀번호|보안키|bearer\s/i.test(name+' '+address)){invalid=true;return;}
    const row={customerCode:v.code,customerName:name,basicAddress:address,addressHash:protectedSearchHash_(protectedSearchText_(address).replace(/\s+/g,' ').trim()),sourceUpdatedAt:new Date(c.time).toISOString(),lifecycle:c.lifecycle};
    if(chosen&&JSON.stringify(chosen)!==JSON.stringify(row))conflict=true;chosen=row;});if(conflict){conflicts++;return;}if(invalid){exclusions+=v.candidates.length;return;}rows.push(chosen);});
  if(protectedRegistryMetadata_(id,field).sourceVersion!==meta.sourceVersion)protectedRegistryFail_('SOURCE_CHANGED');
  rows.sort(function(a,b){return a.customerCode<b.customerCode?-1:a.customerCode>b.customerCode?1:0;});if(!rows.length)protectedRegistryFail_('SOURCE_EMPTY');
  const version=protectedSearchHash_(JSON.stringify({sourceRows:meta.sourceRows,lifecycleField:field,rows:rows}));
  if(protectedReaderProfile_){protectedReaderProfile_.registryRows=meta.sourceRows;protectedReaderProfile_.registryChangedCodes=changed.length;protectedReaderProfile_.registryMetadataOnly=true;}
  return {version:version,sourceVersion:meta.sourceVersion,sourceRows:meta.sourceRows,sourceCount:rows.length,sourceUniqueCodes:meta.sourceUniqueCodes,exclusions:exclusions,conflicts:conflicts,lifecycleField:field,rows:rows,selections:selections};
}
function protectedRegistryCurrent_(){
  const props=PropertiesService.getScriptProperties(),id=props.getProperty('PROTECTED_CUSTOMER_ID'),field=props.getProperty('PROTECTED_CUSTOMER_LIFECYCLE_FIELD')||null;
  if(!id)protectedRegistryFail_('SOURCE_UNCONFIGURED');if(field&&!['lifecycle','isDeleted','deletedAt'].includes(field))protectedRegistryFail_('LIFECYCLE_FIELD');
  const cache=protectedRegistryCache_(),key=PROTECTED_REGISTRY_.prefix+'current:'+protectedSearchHash_(id+'\n'+field),raw=cache.get(key);let current=null,old=null;try{current=raw?JSON.parse(raw):null;old=current?protectedRegistryLoad_(current.version):null;}catch(_){}
  const poll=Math.max(60,Math.min(300,Number(props.getProperty('PROTECTED_CUSTOMER_REGISTRY_POLL_SECONDS'))||60));if(old&&Date.now()-current.checkedAt<poll*1000)return old;
  const meta=protectedRegistryMetadata_(id,field);let index=old&&old.sourceVersion===meta.sourceVersion?old:protectedRegistryBuild_(id,field,meta,old);
  protectedRegistrySave_(index);cache.put(key,JSON.stringify({version:index.version,checkedAt:Date.now()}),PROTECTED_REGISTRY_.ttl);return index;
}
function protectedRegistryCursor_(version,base,offset){const body=['r1',version,base||'-',offset].join('.'),secret=PropertiesService.getScriptProperties().getProperty(HUB_MAP_HTTP_API.SECRET_PROPERTY);return body+'.'+hubMapHttpHmac_('customerRegistry\n'+body,secret);}
function protectedRegistryParseCursor_(cursor){
  if(typeof cursor!=='string'||cursor.length>200||!/^r1\.[a-f0-9]{64}\.(?:[a-f0-9]{64}|-)\.(?:0|[1-9]\d{0,4})\.[A-Za-z0-9_-]{43}$/.test(cursor))protectedRegistryFail_('CURSOR_INVALID');
  const p=cursor.split('.');if(!hubMapHttpConstantTimeEqual_(cursor,protectedRegistryCursor_(p[1],p[2]==='-'?null:p[2],Number(p[3]))))protectedRegistryFail_('CURSOR_INVALID');return {version:p[1],base:p[2]==='-'?null:p[2],offset:Number(p[3])};
}
function protectedReaderRegistry_(params){
  const limit=params.limit===undefined?200:params.limit;if(!Number.isInteger(limit)||limit<1||limit>200)protectedRegistryFail_('PARAMS');
  if(params.afterVersion!==undefined&&(!/^[a-f0-9]{64}$/.test(params.afterVersion)||typeof params.afterVersion!=='string'))protectedRegistryFail_('PARAMS');if(params.cursor!==undefined&&params.afterVersion!==undefined)protectedRegistryFail_('PARAMS');
  let index,base=null,offset=0,baseline=null;
  if(params.cursor!==undefined){const c=protectedRegistryParseCursor_(params.cursor);index=protectedRegistryLoad_(c.version);base=c.base;offset=c.offset;if(!index)protectedRegistryFail_('CURSOR_EXPIRED');if(base){baseline=protectedRegistryLoad_(base);if(!baseline)protectedRegistryFail_('CURSOR_EXPIRED');}}
  else{index=protectedRegistryCurrent_();if(params.afterVersion===index.version)return protectedRegistryPage_(index,index.version,'NOOP',[],0,null,true,0,null);baseline=protectedRegistryLoad_(params.afterVersion);if(baseline)base=baseline.version;}
  const previous=new Map((baseline?baseline.rows:[]).map(function(r){return [r.customerCode,JSON.stringify(r)];})),changes=baseline?index.rows.filter(function(r){return previous.get(r.customerCode)!==JSON.stringify(r);}):index.rows;
  if(offset>changes.length)protectedRegistryFail_('CURSOR_INVALID');const rows=changes.slice(offset,offset+limit),next=offset+rows.length,complete=next===changes.length;
  return protectedRegistryPage_(index,base,baseline?'DELTA':'FULL',rows,offset,complete?null:protectedRegistryCursor_(index.version,base,next),complete,changes.length,params.cursor||null);
}
function protectedRegistryPage_(index,from,mode,rows,offset,next,complete,total,after){return {contract:PROTECTED_REGISTRY_.contract,version:index.version,sourceVersion:index.sourceVersion,sourceVersionKind:'CUSTOMER_METADATA_SHA256',fromVersion:from,mode:mode,rows:rows,offset:offset,afterCursor:after,nextCursor:next,complete:complete,total:total,sourceCount:index.sourceCount,sourceRows:index.sourceRows,sourceUniqueCodes:index.sourceUniqueCodes,exclusions:index.exclusions,conflicts:index.conflicts,deletionPolicy:'EXPLICIT_ONLY',lifecycleField:index.lifecycleField};}
