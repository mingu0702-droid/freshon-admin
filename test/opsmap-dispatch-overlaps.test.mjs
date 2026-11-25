import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import {customerRegistryAddressHash} from '../src/customerRegistry.js';
import {createDispatchPostalEvidenceReader,createOpsmapDispatchOverlapsReader,mountOpsmapDispatchOverlaps}
  from '../src/opsmapDispatchOverlaps.js';
import {sealPostalAddressEvidence} from '../src/shadowCoverage/postalAddressEvidence.js';
import {STAGE_ORIGIN,STAGE_SERVICE} from '../src/stageScope.js';

const generation='b'.repeat(64);
const fixedVersion='c'.repeat(64);
const version='a'.repeat(64);
const customerCode=index=>'T'+String(10000+index);
function store(index,options={}){
  const basicAddress='경기도 오산시 검증로 '+index;
  return {customerCode:customerCode(index),customerName:'시험매장 '+index,basicAddress,
    addressHash:customerRegistryAddressHash(basicAddress),centerGroup:'osan',lifecycle:'ACTIVE',...options};
}

function fixture(){
  const rows=Array.from({length:43},(_,index)=>store(index));
  rows[0].verifiedLocation={addressHash:rows[0].addressHash,lat:37.15,lng:127.07,kind:'BUILDING'};
  rows.push(store(43,{lifecycle:'DELETED'}),store(44,{centerGroup:'yeongnam'}));
  const postal=new Map(rows.map((row,index)=>[row.customerCode,index<33?'06241':index<37?'06253':
    index<40?'06254':index<41?'6241':index<42?'06261':'06262']));
  const sources={
    registry:{ref:{version},rows},publication:{postalGeneration:generation,registry:new Map()},
    postalState:{registryVersion:version,postcodes:postal},fixedMeta:{basis:'FIXED_DISPATCH_PRIMARY',version:fixedVersion,stale:false}
  };
  const routeFor=index=>index<33?['101','208','용01'][index%3]:index<40?index%2?'101':'208':index===41?'오산신규':'101';
  const read=createOpsmapDispatchOverlapsReader({
    getPublication:()=>sources.publication,readRegistry:async()=>sources.registry,
    readFixed:async(codes)=>({ok:true,meta:sources.fixedMeta,data:codes.map(code=>({
      customerCode:code,baseVehicle:routeFor(Number(code.slice(1))-10000),baseVehicleGroup:'osan',
      baseVehicleState:'VERIFIED_MASTER',baseVehicleVersion:sources.fixedMeta.version,baseVehicleSource:'FIXED_DISPATCH_PRIMARY'
    }))}),
    readPostcodes:async()=>sources.postalState
  });
  return {read,sources};
}

test('full overlap list and versioned detail retain large groups and stores with unknown coordinates',async()=>{
  const {read}=fixture();
  const data=await read();
  assert.equal(data.state,'VERIFIED');
  assert.deepEqual(data.candidates.map(row=>[row.postalCode,row.routeCount,row.storeCount]),[
    ['06241',3,33],['06253',2,4],['06254',2,3]
  ]);
  assert(!Object.hasOwn(data.candidates[0],'stores'));
  const got=await read({postalCode:'06241',version:data.version});
  assert.deepEqual(got.candidate.routes,[{vehicle:'101',storeCount:11},{vehicle:'208',storeCount:11},{vehicle:'용01',storeCount:11}]);
  assert.equal(got.candidate.stores.length,33);
  assert.equal(got.candidate.stores.filter(row=>row.coordinateVerified).length,1);
  assert.deepEqual(got.candidate.stores[0],{customerCode:customerCode(0),customerName:'시험매장 0',vehicle:'101',
    lat:37.15,lng:127.07,coordinateVerified:true});
  assert(!got.candidate.stores.some(row=>Object.hasOwn(row,'basicAddress')||Object.hasOwn(row,'addressHash')));
});

test('rotated versions invalidate details and a missing or stale source cannot return a verified empty list',async()=>{
  const {read,sources}=fixture();
  const original=await read();
  sources.fixedMeta={...sources.fixedMeta,version:'d'.repeat(64)};
  await assert.rejects(read({postalCode:'06241',version:original.version}),{message:'DISPATCH_OVERLAPS_VERSION_CHANGED'});
  await assert.rejects(read({postalCode:'06255',version:(await read()).version}),{message:'DISPATCH_OVERLAPS_NOT_FOUND'});
  sources.fixedMeta={...sources.fixedMeta,stale:true};
  await assert.rejects(read(),{message:'DISPATCH_OVERLAPS_UNAVAILABLE'});
  sources.fixedMeta={...sources.fixedMeta,stale:false};
  sources.postalState={registryVersion:version,postcodes:new Map([[customerCode(0),'06241']])};
  assert.deepEqual((await read()).candidates,[]);
  sources.postalState={registryVersion:'e'.repeat(64),postcodes:sources.postalState.postcodes};
  await assert.rejects(read(),{message:'DISPATCH_OVERLAPS_UNAVAILABLE'});
});

test('private summary and detail reject query changes, duplicate parameters, and expired staff access',async t=>{
  const {read}=fixture();
  const app=express();
  let staffAvailable=true;
  const requireStaff=(req,res,next)=>req.get('x-test-staff')==='ok'&&staffAvailable?next():res.sendStatus(401);
  mountOpsmapDispatchOverlaps(app,{requireStaff,async read(query){
    const value=await read(query);
    if(reqCount===1)staffAvailable=false;
    return value;
  }});
  let reqCount=0;
  const server=app.listen(0,'127.0.0.1');
  t.after(()=>{server.closeAllConnections();server.close();});
  await new Promise(resolve=>server.once('listening',resolve));
  const endpoint='http://127.0.0.1:'+server.address().port+'/api/map-phase2b/private/dispatch-reference-overlaps';
  const headers={'x-test-staff':'ok'};
  assert.equal((await fetch(endpoint)).status,401);
  assert.equal((await fetch(endpoint+'?date=2026-11-23',{headers})).status,400);
  assert.equal((await fetch(endpoint+'?__proto__=unknown',{headers})).status,400);
  assert.equal((await fetch(endpoint+'?postalCode=06241&postalCode=06253&version='+version,{headers})).status,400);
  const list=await fetch(endpoint,{headers});
  assert.equal(list.status,200);
  assert.match(list.headers.get('cache-control'),/no-store/);
  const {version:current}=await list.json();
  reqCount++;
  assert.equal((await fetch(endpoint+'?postalCode=06241&version='+current,{headers})).status,401);
});

test('pinned address-only proof contributes a missing registered store without adding a coordinate',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'dispatch-postal-fixture-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const filename=path.join(directory,'postal.sealed.json');
  let registry={ref:{version},rows:[store(0),store(1),store(2),store(3)]};
  const key=Buffer.alloc(32,8);
  const source={issuer:'MOIS_JUSO_BUILDING_DB',edition:'2026-10',datasetSha256:'7'.repeat(64),reviewSha256:'8'.repeat(64)};
  const candidate=sealPostalAddressEvidence({registry,source,rows:[{
    customerCode:customerCode(1),addressSha256:registry.rows[1].addressHash,
    buildingManagementNo:'1'.repeat(25),postalCode:'06241'
  }]},key);
  await writeFile(filename,JSON.stringify({schema:'opsmap-local-sealed-postal-address-evidence-v1',
    reference:candidate.reference,sealed:candidate.bytes.toString('base64')}));
  const env={RENDER_EXTERNAL_URL:STAGE_ORIGIN,RENDER_SERVICE_ID:STAGE_SERVICE,
    OPSMAP_DISPATCH_POSTAL_ADDRESS_EVIDENCE_APPROVED:'1',
    OPSMAP_DISPATCH_POSTAL_ADDRESS_EVIDENCE_FILE:filename,
    OPSMAP_DISPATCH_POSTAL_ADDRESS_EVIDENCE_SHA256:candidate.reference.sha256,
    OPSMAP_SHADOW_POSTAL_ASSET_KEY_B64:key.toString('base64')};
  assert.equal(createDispatchPostalEvidenceReader({env:{...env,OPSMAP_DISPATCH_POSTAL_ADDRESS_EVIDENCE_APPROVED:'0'}}),undefined);
  const evidence=createDispatchPostalEvidenceReader({env});
  const publication={postalGeneration:generation};
  const officialPostcodes=new Map([[customerCode(0),'06241'],[customerCode(2),'06253'],[customerCode(3),'06253']]);
  const read=createOpsmapDispatchOverlapsReader({
    getPublication:()=>publication,readRegistry:async()=>registry,readPostalEvidence:evidence,
    readFixed:async codes=>({ok:true,meta:{basis:'FIXED_DISPATCH_PRIMARY',version:fixedVersion,stale:false},
      data:codes.map((code,index)=>({customerCode:code,baseVehicle:index%2?'208':'101',baseVehicleGroup:'osan',
        baseVehicleState:'VERIFIED_MASTER',baseVehicleVersion:fixedVersion,baseVehicleSource:'FIXED_DISPATCH_PRIMARY'}))}),
    readPostcodes:async()=>({registryVersion:registry.ref.version,postcodes:new Map(officialPostcodes)})
  });
  const output=await read();
  assert.equal(output.candidates[0].storeCount,2);
  assert.equal((await read({postalCode:'06241',version:output.version})).candidate.stores[1].coordinateVerified,false);
  registry={...registry,ref:{version:'f'.repeat(64)}};
  const current=await read();
  assert.deepEqual(current.candidates.map(row=>[row.postalCode,row.storeCount]),[['06241',2],['06253',2]]);
  await assert.rejects(read({postalCode:'06241',version:output.version}),{message:'DISPATCH_OVERLAPS_VERSION_CHANGED'});
  const rebound=await evidence(registry);
  assert.equal(rebound.registry,registry.ref.version);
  assert.equal(rebound.lookup(customerCode(1)).postalCode,'06241');
  assert.equal((await evidence({...registry,ref:{version:'e'.repeat(64)}})).count,1);
  const wrongCenter={ref:{version:'d'.repeat(64)},rows:[store(0),store(1,{centerGroup:'yeongnam'}),store(2),store(3)]};
  assert.equal((await evidence(wrongCenter)).count,0);
  officialPostcodes.set(customerCode(1),'06253');
  const official=await read();
  assert.deepEqual(official.candidates.map(row=>[row.postalCode,row.storeCount]),[['06253',3]]);
  assert.equal((await read({postalCode:'06253',version:official.version})).candidate.stores
    .find(row=>row.customerCode===customerCode(1)).coordinateVerified,false);
  const corrupt=Buffer.from(candidate.bytes);
  corrupt[30]^=1;
  await writeFile(filename,JSON.stringify({schema:'opsmap-local-sealed-postal-address-evidence-v1',
    reference:candidate.reference,sealed:corrupt.toString('base64')}));
  await assert.rejects(evidence(registry),{message:'POSTAL_ADDRESS_EVIDENCE_INVALID'});
  await assert.rejects(createDispatchPostalEvidenceReader({env})({...registry,ref:{version}}),{message:'POSTAL_ADDRESS_EVIDENCE_INVALID'});
});
