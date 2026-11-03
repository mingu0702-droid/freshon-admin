import crypto from 'node:crypto';
import {prepareApprovedCoordinateSearch} from './opsmap-abc/opsmapAutoCoordinates.js';
const fail=code=>Object.assign(Error(code),{code});
export function customerRegistryPage(snapshot,{cursor=null,since='',limit=250,secret,rules={}}={}){
 if(!snapshot?.complete||!Array.isArray(snapshot.rows)||!secret)throw fail('CUSTOMER_REGISTRY_NOT_READY');
 snapshot={...snapshot,registryVersion:snapshot.version,version:crypto.createHash('sha256').update(JSON.stringify([snapshot.version,rules])).digest('hex')};
 let offset=0;const sign=body=>crypto.createHmac('sha256',secret).update(body).digest('base64url');
 if(cursor){const [body,signature,...rest]=String(cursor).split('.');if(rest.length||!body||!signature||signature!==sign(body))throw fail('CUSTOMER_REGISTRY_CURSOR_INVALID');let value;try{value=JSON.parse(Buffer.from(body,'base64url'));}catch{throw fail('CUSTOMER_REGISTRY_CURSOR_INVALID');}if(value.version!==snapshot.version)throw fail('CUSTOMER_REGISTRY_VERSION_CHANGED');if(!Number.isSafeInteger(value.offset)||value.offset<0||value.offset>snapshot.rows.length)throw fail('CUSTOMER_REGISTRY_CURSOR_INVALID');offset=value.offset;}
 const size=Math.max(1,Math.min(500,Number.isSafeInteger(limit)?limit:250)),noop=!cursor&&since===snapshot.version;
 const rows=noop?[]:snapshot.rows.slice(offset,offset+size).map(row=>{const coordinateSearch=prepareApprovedCoordinateSearch({customerCode:row.customerCode,originalAddress:row.basicAddress,rules});return{...row,...(coordinateSearch?{coordinateSearch}:{})};});
 const end=offset+rows.length,complete=noop||end>=snapshot.rows.length,body=Buffer.from(JSON.stringify({version:snapshot.version,offset:end})).toString('base64url');
 return{...snapshot,mode:noop?'NOOP':'FULL',rows,afterCursor:cursor,nextCursor:complete?null:body+'.'+sign(body),complete,total:snapshot.rows.length};
}
export function mountPrivateCustomerRegistry({app,requireStaff,registry,secret,readRules=async()=>({}),now=Date.now}){
 let pending=null,lastStarted=-Infinity;
 const refresh=()=>{if(pending||now()-lastStarted<60000)return pending;lastStarted=now();pending=registry.refresh({maxPages:100,deadline:now()+180000}).catch(()=>null).finally(()=>{pending=null;});return pending;};
 app.get('/api/map-phase2b/private/customer-registry',requireStaff,async(req,res)=>{
  res.set('Cache-Control','private, no-store');void refresh();
  try{const snapshot=await registry.read();if(!snapshot?.complete)return res.status(202).json({ok:false,error:'CUSTOMER_REGISTRY_PREPARING'});
   const page=customerRegistryPage(snapshot,{cursor:req.query.cursor||null,since:req.query.since||'',limit:Number(req.query.limit)||250,secret,rules:await readRules()});
   return requireStaff(req,res,()=>res.json({ok:true,data:page,meta:{...registry.status(),servedAt:new Date(now()).toISOString(),source:'CUSTOMER_REGISTRY_READ_ONLY'}}));
  }catch(error){const code=/^CUSTOMER_REGISTRY_[A-Z_]+$/.test(error.code||'')?error.code:'CUSTOMER_REGISTRY_UNAVAILABLE';return requireStaff(req,res,()=>res.status(/CURSOR_INVALID/.test(code)?400:/VERSION_CHANGED/.test(code)?409:503).json({ok:false,error:code}));}
 });
 const timer=setInterval(()=>void refresh(),60000);timer.unref?.();void refresh();return{refresh,stop:()=>clearInterval(timer)};
}
