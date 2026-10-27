import fs from 'node:fs';import vm from 'node:vm';import crypto from 'node:crypto';
export const clone=v=>JSON.parse(JSON.stringify(v));
export function hubHarness({rows,activeCodes=['S1000'],endDate='2026-10-23'}={}){
 const files=new Map(),props=new Map(),tables=new Map();let seq=0;const metrics={fileReads:0,sourceReads:0,sourceWrites:0,created:0};
 const headers=['customerCode','customerName','customerAddress','detailAddress','password','securityKey','generalKey','accessInfo','specialRemark','deliveryDays','updatedAt','deliveryDate','correctionVerified','deleted','clearedFields'];
 const records=rows||[{customerCode:'S1000',customerName:'합성 매장',customerAddress:'경기도 오산시 합성로 1',password:'INITIAL',securityKey:true,generalKey:false,updatedAt:'2026-10-22T10:00:00+09:00',deliveryDate:'2026-10-22'}];
 const locks={user:false,script:false};const lock=kind=>({tryLock(){if(locks[kind])return false;locks[kind]=true;return true;},releaseLock(){locks[kind]=false;}});
 const folder={getId:()=> 'private-folder',getSharingAccess:()=> 'PRIVATE',createFile(name,text){return newFile(name,text);}};
 function newFile(name,text,id='file-'+(++seq)){
  const f={id,name,text,private:true,modified:1700000000000,getId(){return id;},getSharingAccess(){return this.private?'PRIVATE':'PUBLIC';},getSize(){return Buffer.byteLength(this.text);},getLastUpdated(){return new Date(this.modified);},getBlob(){metrics.fileReads++;return {getDataAsString:()=>this.text};},setContent(v){if(id==='customer-source'){metrics.sourceWrites++;throw Error('SOURCE_WRITE_FORBIDDEN');}this.text=v;this.modified++;},getParents(){let has=true;return {hasNext:()=>has,next:()=>{has=false;return folder;}};}};
  files.set(id,f);metrics.created++;return f;
 }
 newFile('Customer','saved-source','customer-source');
 function setRows(next){tables.set('customers',[headers,...next.map(r=>headers.map(h=>r[h]??''))]);}
 setRows(records);
 const properties={getProperty:k=>props.get(k)??null,setProperty(k,v){props.set(k,String(v));return this;}};
 const context=vm.createContext({Date,JSON,Set,Map,Number,String,Math,Object,Array,Error,console,Buffer,
  HUB_DEFAULT_SOURCE_ID:'customer-source',HUB_STAFF_DETAIL_ARCHIVE:null,
  PropertiesService:{getScriptProperties:()=>properties},LockService:{getUserLock:()=>lock('user'),getScriptLock:()=>lock('script')},
  DriveApp:{Access:{PRIVATE:'PRIVATE'},getFolderById:id=>{if(id!=='private-folder')throw Error('NO_FOLDER');return folder;},getFileById:id=>{if(!files.has(id))throw Error('NO_FILE');return files.get(id);}},MimeType:{PLAIN_TEXT:'text/plain'},
  Utilities:{DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},computeDigest:(_a,text)=>[...crypto.createHash('sha256').update(text).digest()],newBlob:text=>({getBytes:()=>Buffer.from(text)}),formatDate:(date,_zone)=>new Date(date.getTime()+9*3600000).toISOString().slice(0,10)},
  SpreadsheetApp:{openById(id){if(id!=='customer-source')throw Error('NO_SOURCE');return {getSheetByName(name){if(!tables.has(name))return null;return {getLastRow:()=>tables.get(name).length,getLastColumn:()=>headers.length,getRange(row,_column,count,columns){metrics.sourceReads++;const values=tables.get(name).slice(row-1,row-1+count).map(a=>a.slice(0,columns));return {getValues:()=>values,getDisplayValues:()=>values.map(a=>a.map(String))};}};}};}},
  hubMapHttpValidateOnlyKeys_:(p,allowed)=>{if(Object.keys(p).some(k=>!allowed.includes(k)))throw Error('INVALID_PARAM');},hubMapHttpCustomerCode_:s=>{if(!/^[A-Z]\d+$/.test(s))throw Error('INVALID_CUSTOMER_CODE');return s;},hubMapHttpDate_:s=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||new Date(s).toISOString().slice(0,10)!==s)throw Error('INVALID_DATE');return s;}
 });
 for(const name of ['HubMapPackageStore.js','HubCustomerDetailContract.js','HubCustomerDetailStore.js','HubMapRoadBudget.js'])vm.runInContext(fs.readFileSync(new URL('../../integrations/hub/'+name,import.meta.url),'utf8'),context,{filename:name});
 // A real-format, private, SHA-verified published summary scope (synthetic rows).
 const publicRows=activeCodes.map(code=>[code,'합성 매장','경기도 오산시 합성로 1',37.15,127.07,'osan','101',['','','','','','',''],null,[[0,'101',1]]]);
 const chunk=context.hubMapPackageCreateFile_(folder,'public',publicRows,1572864);
 const manifest={schema:'map-public-package-v1',version:1,sourceGeneration:1,startDate:endDate,endDate,sourceObservedAt:'2026-10-23T00:00:00Z',publishedAt:'2026-10-23T01:00:00Z',customerCompletedThrough:endDate,coverage:{verifiedDates:[],unconfirmedDates:[endDate],proof:'UNCONFIRMED'},dependencies:{baseVehicle:null,coordinates:null,publicSource:null},chunks:[{key:'public-1',hash:chunk.hash,bytes:chunk.bytes,count:publicRows.length,visits:publicRows.length}],customerCount:publicRows.length,visitCount:publicRows.length};
 const root=context.hubMapPackageCreateFile_(folder,'root',{schema:1,version:1,manifest,public:{'public-1':{...chunk,count:publicRows.length,visits:publicRows.length}}},98304);
 props.set('PRODUCTION_MAP_PACKAGES_V1',JSON.stringify({schema:1,current:{...root,version:1},previous:null}));
 const run=()=>{const request=context.hubMapCustomerDetailsSyncRequest_({});if(request.data.phase==='NOOP')return clone(request.data);let result;for(let n=0;n<100;n++){result=context.hubMapCustomerDetailsContinue();if(!['BUILD','VERIFY'].includes(result.phase))return clone(result);}throw Error('HARNESS_MAX_ITERATIONS');};
 const read=(code='S1000',view='notes',requestedDate='2026-09-01')=>clone(context.hubMapCustomerDetailPrepared_({customerCode:code,view,requestedDate}));
 return {context,props,files,tables,headers,metrics,run,read,setRows,mutateSource(next){setRows(next);files.get('customer-source').modified++;},lock:locks};
}
