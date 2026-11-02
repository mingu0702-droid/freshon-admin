// Search only non-secret Customer metadata. Never read memo/key/detail columns.
function protectedSearchText_(value){return String(value==null?'':value).normalize('NFKC').trim().toLowerCase();}
function protectedSearchAddress_(value){
  let s=protectedSearchText_(value).replace(/\([^)]*\)/g,'').replace(/\s+/g,'');
  const aliases=[['서울특별시','서울'],['서울시','서울'],['부산광역시','부산'],['대구광역시','대구'],['인천광역시','인천'],['광주광역시','광주'],['대전광역시','대전'],['울산광역시','울산'],['세종특별자치시','세종'],['경기도','경기'],['강원특별자치도','강원'],['강원도','강원'],['충청북도','충북'],['충청남도','충남'],['전북특별자치도','전북'],['전라북도','전북'],['전라남도','전남'],['경상북도','경북'],['경상남도','경남'],['제주특별자치도','제주'],['제주도','제주']];
  for(let i=0;i<aliases.length;i++)if(s.indexOf(aliases[i][0])===0){s=aliases[i][1]+s.slice(aliases[i][0].length);break;}
  return s;
}
function protectedSearchContains_(value,query){if(!query)return false;const p=value.indexOf(query);return p>=0&&(!/\d$/.test(query)||!/[\d-]/.test(value.charAt(p+query.length)));}
function protectedSearchHash_(value){return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,value,Utilities.Charset.UTF_8).map(function(n){return ('0'+((n+256)%256).toString(16)).slice(-2);}).join('');}
function protectedSearchTime_(value){const t=typeof value==='number'?Date.UTC(1899,11,30)+Math.round(value*86400000)-9*3600000:Date.parse(value);return isFinite(t)?t:null;}
function protectedReaderSearch_(params){
  const q=String(params.q||'').normalize('NFKC').trim(),limit=Number(params.limit||50);
  if(q.length<2||q.length>200||!Number.isInteger(limit)||limit<1||limit>50)hubMapHttpRaise_('INVALID_PARAMS','Invalid customer search.',400,false);
  const id=PropertiesService.getScriptProperties().getProperty('PROTECTED_CUSTOMER_ID');if(!id)throw Error('SEARCH_SOURCE_UNCONFIGURED');
  const metadata=Sheets.Spreadsheets.get(id,{fields:'sheets.properties'}),item=(metadata.sheets||[]).filter(function(s){return s.properties.title==='customers';})[0];
  if(!item||item.properties.gridProperties.columnCount>128)throw Error('SEARCH_SOURCE_CONTRACT');
  const title="'customers'!",column=function(n){let s='';for(n++;n>0;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;};
  const header=Sheets.Spreadsheets.Values.get(id,title+'1:1',{valueRenderOption:'UNFORMATTED_VALUE'}).values[0],names=['customerCode','customerName','customerAddress','updatedAt'];
  const indices=names.map(function(n){return header.indexOf(n);});if(indices.some(function(n){return n<0;}))throw Error('SEARCH_SOURCE_HEADERS');
  const options={valueRenderOption:'UNFORMATTED_VALUE',dateTimeRenderOption:'SERIAL_NUMBER'};
  const cap=Math.min(300001,item.properties.gridProperties.rowCount),codeValues=cap<2?[]:(Sheets.Spreadsheets.Values.get(id,title+column(indices[0])+'2:'+column(indices[0])+cap,options).values||[]);
  if(codeValues.length>30000)throw Error('SEARCH_SOURCE_LIMIT');
  const count=codeValues.length,range=function(i){return title+column(i)+'2:'+column(i)+(count+1);};
  let columns=[];if(count){const answer=Sheets.Spreadsheets.Values.batchGet(id,Object.assign({ranges:indices.map(range)},options));if(!answer.valueRanges||answer.valueRanges.length!==4)throw Error('SEARCH_SOURCE_INCOMPLETE');columns=answer.valueRanges.map(function(v){return v.values||[];});
    const check=Sheets.Spreadsheets.Values.batchGet(id,Object.assign({ranges:[title+column(indices[0])+'2:'+column(indices[0])+cap,range(indices[3])]},options));if(!check.valueRanges||check.valueRanges.length!==2||JSON.stringify(check.valueRanges[0].values||[])!==JSON.stringify(columns[0])||JSON.stringify(check.valueRanges[1].values||[])!==JSON.stringify(columns[3]))throw Error('SEARCH_SOURCE_CHANGED');}
  const read=function(i,r){return columns[i]&&columns[i][r]&&columns[i][r][0]||'';},byCode=new Map();let invalid=0;
  for(let i=0;i<count;i++){const code=String(read(0,i)).trim().toUpperCase();if(!code)continue;const time=protectedSearchTime_(read(3,i));if(!/^[A-Z]\d{1,20}$/.test(code)||time===null){invalid++;continue;}
    const row={customerCode:code,customerName:String(read(1,i)),address:String(read(2,i)),time:time},old=byCode.get(code);
    if(!old||old.time<time)byCode.set(code,row);else if(old.time===time&&(old.customerName!==row.customerName||old.address!==row.address))old.conflict=true;}
  const needle=protectedSearchText_(q).replace(/\s+/g,''),address=protectedSearchAddress_(q),rows=[];let conflicts=0;
  byCode.forEach(function(row){if(row.conflict){conflicts++;return;}const code=row.customerCode.toLowerCase(),name=protectedSearchText_(row.customerName).replace(/\s+/g,'');
    const matched=code===needle?'CODE':name.indexOf(needle)>=0?'NAME':protectedSearchContains_(protectedSearchAddress_(row.address),address)?'ADDRESS':null;
    if(matched)rows.push({customerCode:row.customerCode,customerName:row.customerName,addressHash:protectedSearchHash_(protectedSearchText_(row.address).replace(/\s+/g,' ').trim()),matchedBy:matched,sourceUpdatedAt:new Date(row.time).toISOString()});});
  rows.sort(function(a,b){return (a.matchedBy==='CODE'?-1:0)-(b.matchedBy==='CODE'?-1:0)||a.customerCode.localeCompare(b.customerCode);});
  if(protectedReaderProfile_){protectedReaderProfile_.searchRows=count;protectedReaderProfile_.searchMetadataOnly=true;}
  return {contract:'customer-search-v1',queryHash:protectedSearchHash_(q),rows:rows.slice(0,limit),complete:invalid===0&&conflicts===0,truncated:rows.length>limit,totalMatches:rows.length,invalidRows:invalid,conflicts:conflicts,sourceRows:count};
}
