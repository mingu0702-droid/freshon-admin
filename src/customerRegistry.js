import crypto from 'node:crypto';

const CONTRACT='customer-registry-v1',KIND='CUSTOMER_METADATA_SHA256',MAX=30000;
const fail=code=>{throw Object.assign(Error(code),{code});};
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value),'utf8').digest('hex');
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const integer=(v,min=0,max=MAX)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const clone=value=>structuredClone(value);
const rowFields=['customerCode','customerName','basicAddress','addressHash','sourceUpdatedAt','lifecycle'];
export function customerRegistryAddressHash(value){return crypto.createHash('sha256').update(String(value??'').normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' '),'utf8').digest('hex');}
function fields(value,keys){return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));}
function rowOf(row){
 if(!fields(row,rowFields)||typeof row.customerCode!=='string'||!/^[A-Z]\d{1,20}$/.test(row.customerCode)||typeof row.customerName!=='string'||row.customerName.length>200||typeof row.basicAddress!=='string'||row.basicAddress.length>500||/[\u0000-\u001f]/.test(row.customerName+row.basicAddress)||/(?:01[016789])[- ]?\d{3,4}[- ]?\d{4}|비밀번호|보안키|bearer\s/i.test(row.customerName+' '+row.basicAddress)||!hash(row.addressHash)||row.addressHash!==customerRegistryAddressHash(row.basicAddress)||typeof row.sourceUpdatedAt!=='string'||!Number.isFinite(Date.parse(row.sourceUpdatedAt))||new Date(row.sourceUpdatedAt).toISOString()!==row.sourceUpdatedAt||!['ACTIVE','DELETED'].includes(row.lifecycle))fail('REGISTRY_ROW_CONTRACT');
 return Object.fromEntries(rowFields.map(k=>[k,row[k]]));
}
function sortedRows(rows){
 if(!Array.isArray(rows)||rows.length>MAX)fail('REGISTRY_ROWS_CONTRACT');let previous='';
 return rows.map(input=>{const row=rowOf(input);if(row.customerCode<=previous)fail('REGISTRY_ROW_ORDER');previous=row.customerCode;return row;});
}
function lifecycleField(v){return v===null||['lifecycle','isDeleted','deletedAt'].includes(v);}
const pageFields=['contract','version','sourceVersion','sourceVersionKind','fromVersion','mode','rows','offset','afterCursor','nextCursor','complete','total','sourceCount','sourceRows','sourceUniqueCodes','exclusions','conflicts','deletionPolicy','lifecycleField'];
export function validateCustomerRegistryPage(value,{cursor=null,afterVersion=null}={}){
 if(!fields(value,pageFields)||value.contract!==CONTRACT||!hash(value.version)||!hash(value.sourceVersion)||value.sourceVersionKind!==KIND||value.fromVersion!==null&&!hash(value.fromVersion)||!['FULL','DELTA','NOOP'].includes(value.mode)||!integer(value.offset)||!integer(value.total)||!integer(value.sourceCount,1)||!integer(value.sourceRows,value.sourceCount)||!integer(value.sourceUniqueCodes,value.sourceCount,value.sourceRows)||!integer(value.exclusions)||!integer(value.conflicts)||value.deletionPolicy!=='EXPLICIT_ONLY'||!lifecycleField(value.lifecycleField)||value.afterCursor!==cursor||typeof value.complete!=='boolean'||!Array.isArray(value.rows)||value.rows.length>200)fail('REGISTRY_PAGE_CONTRACT');
 const rows=sortedRows(value.rows),end=value.offset+rows.length;
 if(!value.lifecycleField&&rows.some(r=>r.lifecycle==='DELETED')||value.total>value.sourceCount||end>value.total||value.exclusions>value.sourceRows||value.conflicts>value.sourceUniqueCodes||value.complete!==(end===value.total)||value.complete&&value.nextCursor!==null||!value.complete&&(!rows.length||typeof value.nextCursor!=='string'||value.nextCursor===cursor))fail('REGISTRY_PAGE_CONTRACT');
 if(value.mode==='FULL'&&(value.fromVersion!==null||value.total!==value.sourceCount)||value.mode==='DELTA'&&(!value.fromVersion||afterVersion&&value.fromVersion!==afterVersion)||value.mode==='NOOP'&&(cursor!==null||value.version!==afterVersion||value.fromVersion!==value.version||value.total!==0||value.offset!==0||!value.complete))fail('REGISTRY_PAGE_CONTRACT');
 if(!value.complete){const expected=`r1.${value.version}.${value.fromVersion||'-'}.${end}.`;if(value.nextCursor.length>200||!value.nextCursor.startsWith(expected)||!/^[A-Za-z0-9_-]{43}$/.test(value.nextCursor.slice(expected.length)))fail('REGISTRY_CURSOR_CONTRACT');}
 return {...value,rows};
}
const metaFields=['version','sourceVersion','sourceVersionKind','sourceRows','sourceCount','sourceUniqueCodes','exclusions','conflicts','lifecycleField'];
function metaOf(value){return Object.fromEntries(metaFields.map(k=>[k,value[k]]));}
function validateMeta(meta){
 if(!hash(meta.version)||!hash(meta.sourceVersion)||meta.sourceVersionKind!==KIND||!integer(meta.sourceCount,1)||!integer(meta.sourceRows,meta.sourceCount)||!integer(meta.sourceUniqueCodes,meta.sourceCount,meta.sourceRows)||!integer(meta.exclusions)||!integer(meta.conflicts)||!lifecycleField(meta.lifecycleField))fail('REGISTRY_STATE_CONTRACT');
}
function seal(state){const {sha256,...body}=state;return {...body,sha256:digest(body)};}
function emptyState(){return seal({schema:1,current:null,pending:null});}
export function validateCustomerRegistryState(value){
 if(!fields(value,['schema','current','pending','sha256'])||value.schema!==1||!hash(value.sha256))fail('REGISTRY_STATE_CONTRACT');const {sha256,...body}=value;if(digest(body)!==sha256)fail('REGISTRY_STATE_INTEGRITY');
 const c=value.current;if(c){if(!fields(c,[...metaFields,'checkedAt','rows'])||!Number.isFinite(Date.parse(c.checkedAt)))fail('REGISTRY_STATE_CONTRACT');validateMeta(c);sortedRows(c.rows);if(c.rows.length<c.sourceCount)fail('REGISTRY_STATE_CONTRACT');}
 const p=value.pending;if(p){
  if(!fields(p,[...metaFields,'mode','fromVersion','total','rows','nextCursor'])||!['FULL','DELTA'].includes(p.mode)||!integer(p.total,1)||!Array.isArray(p.rows)||!p.rows.length||p.rows.length>=p.total||typeof p.nextCursor!=='string'||p.nextCursor.length>200)fail('REGISTRY_PENDING_CONTRACT');
  validateMeta(p);sortedRows(p.rows);if(p.mode==='DELTA'&&p.fromVersion!==c?.version||p.mode==='FULL'&&(p.fromVersion!==null||p.total!==p.sourceCount))fail('REGISTRY_PENDING_CONTRACT');
  const prefix=`r1.${p.version}.${p.fromVersion||'-'}.${p.rows.length}.`;if(!p.nextCursor.startsWith(prefix)||!/^[A-Za-z0-9_-]{43}$/.test(p.nextCursor.slice(prefix.length)))fail('REGISTRY_CURSOR_CONTRACT');
 }
 return value;
}
function mergeRows(previous,incoming,{explicitLifecycle=false}={}){
 const merged=new Map((previous||[]).map(r=>[r.customerCode,r]));
 for(const row of incoming){const old=merged.get(row.customerCode);
  if(old&&row.sourceUpdatedAt<old.sourceUpdatedAt)continue;
  if(old?.lifecycle==='DELETED'&&row.lifecycle==='ACTIVE'&&!explicitLifecycle)continue;
  if(old&&row.sourceUpdatedAt===old.sourceUpdatedAt&&JSON.stringify(row)!==JSON.stringify(old))fail('REGISTRY_REVISION_CONFLICT');
  merged.set(row.customerCode,row);
 }
 if(merged.size>MAX)fail('REGISTRY_ROWS_LIMIT');return [...merged.values()].sort((a,b)=>a.customerCode<b.customerCode?-1:a.customerCode>b.customerCode?1:0);
}
// readState/writeState must target a dedicated private metadata file. No source writes.
// A successful page is durably checkpointed before its cursor can advance.
export function createCustomerRegistry({callHub,readPage,readState=async()=>null,writeState=async()=>{},now=Date.now,pageSize=200}={}){
 if(!integer(pageSize,1,200)||!readPage&&!callHub)fail('REGISTRY_CONFIGURATION');
 const source=readPage||((params,options)=>callHub('customerRegistry',params,{...options,useCache:false,privateRead:true,maxResponseBytes:524288}));
 let state=emptyState(),loaded=false,loading,refreshing,lastError=null,phase='IDLE';
 async function load(){if(loaded)return;if(!loading)loading=(async()=>{const stored=await readState();state=stored?clone(validateCustomerRegistryState(stored)):emptyState();loaded=true;})().finally(()=>{loading=null;});return loading;}
 async function save(value){const next=seal(value);validateCustomerRegistryState(next);await writeState(clone(next));state=next;}
 function status(){return {loaded,phase,lastError,version:state.current?.version||null,sourceVersion:state.current?.sourceVersion||null,sourceVersionKind:KIND,rowCount:state.current?.rows.length||0,sourceCount:state.current?.sourceCount||0,sourceUniqueCodes:state.current?.sourceUniqueCodes||0,exclusions:state.current?.exclusions||0,conflicts:state.current?.conflicts||0,checkedAt:state.current?.checkedAt||null,pendingRows:state.pending?.rows.length||0,pendingTotal:state.pending?.total||0,deletionPolicy:'EXPLICIT_ONLY'};}
 async function read(){await load();const c=state.current;return {contract:CONTRACT,version:c?.version||null,sourceVersion:c?.sourceVersion||null,sourceVersionKind:KIND,rows:clone(c?.rows||[]),mode:'FULL',afterCursor:null,nextCursor:null,complete:!!c,deletionPolicy:'EXPLICIT_ONLY',lifecycleField:c?.lifecycleField||null,sourceCount:c?.sourceCount||0,sourceRows:c?.sourceRows||0,sourceUniqueCodes:c?.sourceUniqueCodes||0,exclusions:c?.exclusions||0,conflicts:c?.conflicts||0,checkedAt:c?.checkedAt||null};}
 async function run({maxPages=4,signal,deadline=now()+60000}={}){
  if(!integer(maxPages,1,200)||!Number.isFinite(deadline))fail('REGISTRY_REFRESH_OPTIONS');await load();phase='READING';lastError=null;let restarted=false;
  try{for(let page=0;page<maxPages;page++){
   signal?.throwIfAborted();if(now()>=deadline)fail('REGISTRY_DEADLINE');
   const pending=state.pending,cursor=pending?.nextCursor||null,afterVersion=state.current?.version||null,params={limit:pageSize,...(cursor?{cursor}:afterVersion?{afterVersion}:{})};let response;
   try{response=await source(params,{signal,deadline,page});}catch(error){if(cursor&&!restarted&&/REGISTRY_CURSOR_EXPIRED/.test(error.code||error.message||'')){await save({...state,pending:null});restarted=true;page--;continue;}throw error;}
   signal?.throwIfAborted();if(now()>=deadline)fail('REGISTRY_DEADLINE');
   if(response?.ok!==true)fail('REGISTRY_SOURCE_CONTRACT');const value=validateCustomerRegistryPage(response.data,{cursor,afterVersion});
   if(pending&&(JSON.stringify(metaOf(pending))!==JSON.stringify(metaOf(value))||pending.mode!==value.mode||pending.fromVersion!==value.fromVersion||pending.total!==value.total||value.offset!==pending.rows.length)||!pending&&value.offset!==0){
    if(pending&&!restarted){await save({...state,pending:null});restarted=true;page--;continue;}fail('REGISTRY_PAGE_SEQUENCE');
   }
   if(value.mode==='NOOP'){if(!state.current)fail('REGISTRY_NOOP_WITHOUT_BASE');state=seal({...state,current:{...state.current,...metaOf(value),checkedAt:new Date(now()).toISOString()},pending:null});phase='NOOP';return status();}
   const rows=[...(pending?.rows||[]),...value.rows];sortedRows(rows);
   if(!value.complete){await save({...state,pending:{...metaOf(value),mode:value.mode,fromVersion:value.fromVersion,total:value.total,rows,nextCursor:value.nextCursor}});continue;}
   if(value.mode==='FULL'&&digest({sourceRows:value.sourceRows,lifecycleField:value.lifecycleField,rows})!==value.version)fail('REGISTRY_SOURCE_INTEGRITY');
   const current={...metaOf(value),checkedAt:new Date(now()).toISOString(),rows:mergeRows(state.current?.rows,rows,{explicitLifecycle:!!value.lifecycleField})};
   await save({...state,current,pending:null});phase='UPDATED';return status();
  }phase='PARTIAL';return status();}catch(error){if(/^CUSTOMER_REGISTRY_STORAGE_/.test(error.code||''))loaded=false;phase='FAILED';lastError=/^(?:REGISTRY|HUB|PRIVATE_READER|CUSTOMER_REGISTRY_STORAGE)_[A-Z_]+$/.test(error.code||error.message||'')?error.code||error.message:'REGISTRY_SOURCE_UNAVAILABLE';throw error;}
 }
 return {read,status,async get(customerCode){return (await read()).rows.find(r=>r.customerCode===customerCode)||null;},refresh(options){if(refreshing)return refreshing;refreshing=run(options).finally(()=>{refreshing=null;});return refreshing;}};
}
