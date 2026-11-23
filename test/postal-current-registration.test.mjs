import test from 'node:test';
import assert from 'node:assert/strict';
import {customerRegistryAddressHash} from '../src/customerRegistry.js';
import {projectCurrentPostalRegistration} from '../src/shadowCoverage/postalCurrentRegistration.js';
import {createHash} from 'node:crypto';
import {sealCurrentPostalRegistration,verifyCurrentPostalRegistration,
  createCurrentPostalRegistrationReader,stageCurrentPostalRegistrationReader} from '../src/shadowCoverage/postalCurrentRegistrationAsset.js';
import {STAGE_ORIGIN,STAGE_SERVICE} from '../src/stageScope.js';

const makeRow=(customerCode,lng,{lat=37.5,centerGroup='osan',kind='BUILDING'}={})=>{
  const basicAddress='Synthetic Test Building '+customerCode;
  const addressHash=customerRegistryAddressHash(basicAddress);
  return {customerCode,basicAddress,addressHash,centerGroup,lifecycle:'ACTIVE',verifiedLocation:{kind,lat,lng,addressHash}};
};
const zone=(id,w,e)=>({id,box:[w*1e6,37e6,e*1e6,38e6],
  rings:[Int32Array.from([w*1e6,37e6,e*1e6,37e6,e*1e6,38e6,w*1e6,38e6])]});

test('current registration requires address-bound official proof and unique strict interior',async()=>{
  const bad=makeRow('S7',126.5);
  bad.verifiedLocation.addressHash='a'.repeat(64);
  const stale={...makeRow('S8',126.5),basicAddress:'Changed current address'};
  const rows=[makeRow('S1',126.5),makeRow('S2',126.75),makeRow('S3',127),makeRow('S4',128.5),
    makeRow('S5',126.51,{centerGroup:'unknown',kind:'ADDRESS'}),makeRow('S6',126.5,{kind:'PARCEL'}),
    bad,stale,makeRow('S9',126.5),{...makeRow('S10',126.5),lifecycle:'DELETED'}];
  const geometry=[
    {box:[126,37,127,38],zones:[zone(11111,126,127)]},
    {box:[126.6,37,127,38],zones:[zone(11112,126.6,127)]}
  ];
  const actual=await projectCurrentPostalRegistration(rows,new Set(['S9']),geometry);
  assert.deepEqual([...actual.assignments],[['S1',{area:11111,center:'osan'}],['S5',{area:11111,center:null}]]);
  assert.deepEqual(actual.counts,{alreadyScoped:1,missingProof:3,ambiguous:2,outside:1,matched:2});
});

test('rejects repeated current registration identity instead of choosing a row',async()=>{
  const row=makeRow('S1',126.5);
  await assert.rejects(()=>projectCurrentPostalRegistration([row,row],new Set(),[]),/POSTAL_CURRENT_REGISTRY_IDENTITY/);
});
const binding={registry:'a'.repeat(64),boundary:'b'.repeat(64),release:'c'.repeat(64)};
const key=Buffer.alloc(32,1);
const checked=(assignments=new Map([['S1',{area:11111}],['S2',{area:11111}]]))=>{
  const asset=sealCurrentPostalRegistration({binding,assignments},key);
  return verifyCurrentPostalRegistration(asset.bytes,asset.sha256,key);
};
const args={...binding,hasArea:id=>id===11111,hasLegacyCode:()=>false};

test('sealed assets bind SHA, authenticated contents, registry and postal release without carrying unnecessary fields',async()=>{
  const {bytes,sha256}=sealCurrentPostalRegistration({binding,assignments:new Map([['S1',{area:11111,name:'Unneeded'}]])},key);
  const data=verifyCurrentPostalRegistration(bytes,sha256,key);
  assert.deepEqual(data.rows,[['S1',11111]]);
  assert.deepEqual(data.binding,binding);
  assert.throws(()=>verifyCurrentPostalRegistration(bytes,sha256,Buffer.alloc(32,2)),/POSTAL_CURRENT_REGISTRATION_INVALID/);
  const changed=Buffer.from(bytes);changed[changed.length-1]^=1;
  assert.throws(()=>verifyCurrentPostalRegistration(changed,sha256,key),/POSTAL_CURRENT_REGISTRATION_INVALID/);
  assert.throws(()=>verifyCurrentPostalRegistration(changed,createHash('sha256').update(changed).digest('hex'),key),/POSTAL_CURRENT_REGISTRATION_INVALID/);
  assert.equal(stageCurrentPostalRegistrationReader({env:{OPSMAP_STAGE_CURRENT_POSTAL_REGISTRATION_APPROVED:'1'},readRegistry(){}}),null);
  const misconfigured=stageCurrentPostalRegistrationReader({env:{RENDER_SERVICE_ID:STAGE_SERVICE,RENDER_EXTERNAL_URL:STAGE_ORIGIN,
    OPSMAP_STAGE_CURRENT_POSTAL_REGISTRATION_APPROVED:'1'},readRegistry(){}});
  await assert.rejects(()=>misconfigured(),/POSTAL_CURRENT_REGISTRATION_INVALID/);
});

test('current counts and roster use latest verified identity, cache one verified asset and never imply history',async()=>{
  const rows=[{...makeRow('S1',126.5),customerName:'Current A'},
    {...makeRow('S2',126.5,{centerGroup:'unknown'}),customerName:'Current B'}];
  let fetches=0;
  const read=createCurrentPostalRegistrationReader({readRegistry:async()=>({ref:{version:binding.registry},rows}),
    readAsset:async()=>{fetches++;return checked();}});
  const [summary,roster]=await Promise.all([read(args),read({...args,area:11111,center:'osan'})]);
  assert.equal(fetches,1);
  assert.deepEqual(summary,{registry:binding.registry,additionalRegistered:2,counts:[[11111,2]]});
  assert.deepEqual(roster.members,[{code:'S1',name:'Current A',center:'osan'}]);
  await assert.rejects(()=>read({...args,boundary:'d'.repeat(64)}),/REGISTRATION_CHANGED/);
  await assert.rejects(()=>read({...args,release:'d'.repeat(64)}),/REGISTRATION_CHANGED/);
  await assert.rejects(()=>read({...args,registry:'d'.repeat(64)}),/REGISTRATION_CHANGED/);
});

test('a registry change while loading the asset returns no stale roster',async()=>{
  let version=binding.registry;
  const rows=[makeRow('S1',126.5),makeRow('S2',126.5)];
  const read=createCurrentPostalRegistrationReader({readRegistry:async()=>({ref:{version:binding.registry},rows}),
    readRegistryVersion:async()=>version,readAsset:async()=>{version='e'.repeat(64);return checked();}});
  await assert.rejects(()=>read(args),/REGISTRATION_CHANGED/);
});

test('current roster rejects deleted, drifted, duplicate, already-sealed or out-of-geometry identities',async()=>{
  const valid=[makeRow('S1',126.5),makeRow('S2',126.5)];
  const makeReader=rows=>createCurrentPostalRegistrationReader({readAsset:async()=>checked(),
    readRegistry:async()=>({ref:{version:binding.registry},rows})});
  for(const [rows,overrides] of [
    [[{...valid[0],lifecycle:'DELETED'},valid[1]],{}],
    [[{...valid[0],basicAddress:'This has moved'},valid[1]],{}],
    [[...valid,valid[0]],{}],
    [valid,{hasArea:()=>false}],
    [valid,{hasLegacyCode:code=>code==='S2'}],
  ]) await assert.rejects(()=>makeReader(rows)({...args,...overrides}),/REGISTRATION_INVALID/);
});
