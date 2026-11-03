import test from 'node:test';
import assert from 'node:assert/strict';
import {createDeliveryAdminPhotoSource} from '../src/opsmapDeliveryPhotos.js';
import {createDeliveryAdminPhotoTransport, DELIVERY_ADMIN_PHOTO_CATEGORY_MAP, DELIVERY_ADMIN_PHOTO_HOSTS} from '../src/opsmapDeliveryAdminTransport.js';

const identity={customerCode:'S990001',date:'2026-11-04',deliveryId:'990001'};
const attachment={typeText:'냉장고 문은 잘 닫았나요?',images:[{url:'https://static.chabyulhwa.com/synthetic.jpg?signature=DO_NOT_DISCLOSE'}]};
const parent=()=>({id:identity.deliveryId,customer:{erpCode:identity.customerCode},carrier:{enteringDatedAt:identity.date}});
const record=()=>({id:'1990001',taskId:identity.deliveryId,createdAt:'2026-11-05T01:00:00+09:00',taskAttachments:[attachment]});
function fixture({records=()=>[record()],getParent=parent,enabled=true}={}){
  const paths=[];let medias=0;
  const transport=createDeliveryAdminPhotoTransport({hasApprovedSession:()=>true,approvedRequest:async(path,options)=>{
    paths.push(path);assert.equal(options.method,'GET');assert(options.signal instanceof AbortSignal);assert.equal(options.maxResponseBytes,65536);
    return Response.json({data:path.endsWith('/status-record')?records():getParent()});
  },imageFetch:async()=>{medias++;return new Response(new Uint8Array([1]),{headers:{'content-type':'image/jpeg'}});}});
  return {paths,medias:()=>medias,source:createDeliveryAdminPhotoSource({...transport,categoryMap:DELIVERY_ADMIN_PHOTO_CATEGORY_MAP,allowedImageHosts:DELIVERY_ADMIN_PHOTO_HOSTS,readTaskStatusRecords:enabled})};
}
test('operational attachments bind to the exact parent first and status-record ID/createdAt remain separate from task identity',async()=>{
  const f=fixture();const rows=await f.source.list(identity);assert.equal(rows[0].status,'READY');assert.equal(rows[0].photos.length,1);
  assert.deepEqual(f.paths,['/api/bali/task/990001','/api/bali/task/990001/status-record']);assert.match(rows[0].photos[0].ref.recordFingerprint,/^[a-f0-9]{64}$/);
  const media=await f.source.openMedia(identity,rows[0].photos[0].ref);assert.equal(media.status,200);assert.equal(f.medias(),1);await media.arrayBuffer();
});
test('an unverified parent never triggers a status-record GET and legacy mode retains its single-task attachment contract',async()=>{
  const f=fixture({getParent:()=>({...parent(),customer:{erpCode:'S990002'}})});await assert.rejects(f.source.list(identity),{code:'DELIVERY_IDENTITY_MISMATCH'});assert.equal(f.paths.length,1);
  const old=fixture({enabled:false,getParent:()=>({...parent(),taskAttachments:[attachment]})});assert.equal((await old.source.list(identity))[0].photos.length,1);assert.deepEqual(old.paths,['/api/bali/task/990001']);
});
test('explicit task IDs, customers and delivery dates on status records must match their parent',async()=>{
  for(const change of [{taskId:'990002'},{task:{id:'990002'}},{customerCode:'S990002'},{customer:{erpCode:'S990002'}},{deliveryDate:'2026-11-03'},{task:{carrier:{enteringDatedAt:'2026-11-03'}}}]){
    const f=fixture({records:()=>[{...record(),...change}]});await assert.rejects(f.source.list(identity),{code:'DELIVERY_IDENTITY_MISMATCH'});assert.equal(f.medias(),0);
  }
});
test('array/single record and explicit empty are accepted; nullable/missing/unrecognized attachment shapes stay unverified',async()=>{
  assert.equal((await fixture({records:record}).source.list(identity))[0].status,'READY');
  for(const records of [()=>[],()=>[{...record(),taskAttachments:[]}]])assert.equal((await fixture({records}).source.list(identity))[0].status,'EMPTY');
  for(const records of [()=>null,()=>({items:[record()]}),()=>[{...record(),taskAttachments:null}],()=>[{id:'1990001'}],()=>[null]])await assert.rejects(fixture({records}).source.list(identity),{code:'PHOTO_ATTACHMENTS_INVALID'});
});
test('media revalidation binds both the status-record source fingerprint and the image asset fingerprint',async()=>{
  for(const mutate of [value=>({...value,id:'1990002'}),value=>({...value,taskAttachments:[{...attachment,images:[{url:'https://static.chabyulhwa.com/different.jpg'}]}]})]){
    let changed=false;const f=fixture({records:()=>[changed?mutate(record()):record()]});const rows=await f.source.list(identity);changed=true;
    await assert.rejects(f.source.openMedia(identity,rows[0].photos[0].ref),{code:'PHOTO_NOT_FOUND'});assert.equal(f.medias(),0);
  }
});
test('aborted status-record requests cancel late bodies and do not continue to media',async()=>{
  let resolveLate,observed,cancelled=false;const pending=new Promise(r=>{resolveLate=r;});
  const transport=createDeliveryAdminPhotoTransport({hasApprovedSession:()=>true,approvedRequest:async(path,options)=>{
    if(!path.endsWith('/status-record'))return Response.json({data:parent()});observed=options.signal;return pending;
  }});
  const source=createDeliveryAdminPhotoSource({...transport,readTaskStatusRecords:true,categoryMap:DELIVERY_ADMIN_PHOTO_CATEGORY_MAP,allowedImageHosts:DELIVERY_ADMIN_PHOTO_HOSTS});
  const controller=new AbortController(),result=source.list(identity,{signal:controller.signal});
  for(let i=0;i<50&&!observed;i++)await new Promise(r=>setTimeout(r,2));controller.abort();await assert.rejects(result,{code:'PHOTO_TIMEOUT'});assert(observed.aborted);
  resolveLate(new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}}));await new Promise(r=>setTimeout(r,5));assert(cancelled);
});
test('transport whitelist accepts only exact task/status-record GET paths',async()=>{
  let calls=0;const transport=createDeliveryAdminPhotoTransport({hasApprovedSession:()=>true,approvedRequest:async()=>{calls++;return Response.json([]);}});
  for(const path of ['/api/bali/task/990001/status-record?extra=1','/api/bali/task/990001/attachments','/api/bali/task/990001/status-record/','/api/bali/task/990001/status-record/1'])await assert.rejects(transport.requestJson(path),{code:'INVALID_PHOTO_REQUEST'});
  assert.equal(calls,0);
});
