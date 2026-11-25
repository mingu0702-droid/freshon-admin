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
  assert.deepEqual(summary,{registry:binding.registry,registeredScope:2,registered:2,additionalRegistered:2,counts:[[11111,2]]});
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

test('current roster combines safe legacy and added identities while old holds and conflicts stay unlinked',async()=>{
  const rows=[makeRow('S1',126.5),makeRow('S2',126.5),makeRow('S3',126.5),makeRow('S4',126.5),makeRow('S5',126.5)];
  const read=createCurrentPostalRegistrationReader({readRegistry:async()=>({ref:{version:binding.registry},rows}),readAsset:async()=>checked()});
  const legacy=[
    {code:'S3',id:11111,address:rows[2].basicAddress,center:'osan'},
    {code:'S4',id:11111,address:'Old address',center:'osan'},
    {code:'S5',id:null,address:rows[4].basicAddress,center:'osan'},
    {code:'S6',id:11111,address:'Preserved signed base address',center:'honam'}
  ];
  const params={...args,readLegacy:async()=>legacy};
  const summary=await read(params);
  assert.deepEqual(summary,{registry:binding.registry,registeredScope:6,registered:4,additionalRegistered:2,counts:[[11111,4]]});
  const roster=await read({...params,area:11111});
  assert.deepEqual(roster.members.map(row=>row.code),['S3','S6','S1','S2']);
  assert.deepEqual(Object.keys(roster).sort(),['area','members','next','offset','registered','registry']);
  const assignments=await read.dispatchPostcodes(params);
  assert.equal(assignments.registryVersion,binding.registry);
  assert.deepEqual([...assignments.postcodes],[['S3','11111'],['S1','11111'],['S2','11111']]);
});

test('dispatch density uses verified current points and excludes legacy mismatches and address-only links',async()=>{
  const rows=[makeRow('S1',126.5,{centerGroup:'yeongnam'}),makeRow('S2',126.51),
    makeRow('S3',126.52),makeRow('S4',126.53),makeRow('S5',126.54,{centerGroup:'honam'})];
  delete rows[3].verifiedLocation;
  const read=createCurrentPostalRegistrationReader({readRegistry:async()=>({ref:{version:binding.registry},rows}),
    readAsset:async()=>checked(new Map([['S1',{area:11111}]]))});
  const legacy=[
    {code:'S2',id:11111,address:rows[1].basicAddress,center:'osan',lat:37.5,lng:126.51},
    {code:'S3',id:11111,address:rows[2].basicAddress,center:'osan',lat:37.5,lng:126.53},
    {code:'S4',id:11111,address:rows[3].basicAddress,center:'osan',lat:37.5,lng:126.53},
    {code:'S5',id:11111,address:rows[4].basicAddress,center:'osan',lat:37.5,lng:126.54}
  ];
  const input={...args,readLegacy:async()=>legacy};
  const density=await read.dispatchDensityAssignments(input);
  assert.equal((await read(input)).registered,4);
  assert.deepEqual([...density.assignments],[['S2',{area:11111,center:'osan'}],['S1',{area:11111,center:'yeongnam'}]]);
  await assert.rejects(()=>read.dispatchDensityAssignments({...input,registry:'d'.repeat(64)}),/REGISTRATION_CHANGED/);
});

test('remote read is immutable, read-only and checked against independent head',async()=>{
  const {bytes,sha256}=sealCurrentPostalRegistration({binding,assignments:new Map([['S1',{area:11111}]])},key);
  const ref='f'.repeat(40),approvedRelease={ref,sha256};
  const env={RENDER_SERVICE_ID:STAGE_SERVICE,RENDER_EXTERNAL_URL:STAGE_ORIGIN,
    OPSMAP_SHADOW_POSTAL_ASSET_KEY_B64:key.toString('base64'),GITHUB_TOKEN:'verified-postal-token',
    OPSMAP_SHADOW_GITHUB_READ_TOKEN:'other-read-scope'};
  const endpoint='https://api.github.com/repos/mingu0702-droid/freshon-cache/contents/opsmap-stage/postal-v1/current-registration-v1.sealed?ref='+ref;
  for(const [settings,preferred] of [[env,env.GITHUB_TOKEN],
    [{...env,OPSMAP_SNAPSHOT_STORE_TOKEN:'dedicated-postal-token'},'dedicated-postal-token']]){
    const calls=[];
    const read=stageCurrentPostalRegistrationReader({env:settings,approvedRelease,
      readRegistry:async()=>({ref:{version:binding.registry},rows:[makeRow('S1',126.5)]}),
      readRegistryVersion:async()=>binding.registry,fetchImpl:async(url,options)=>{
        calls.push({url,method:options.method,redirect:options.redirect});
        assert.equal(options.headers.Authorization,'Bearer '+preferred);
        return new Response(bytes);
      }});
    assert.equal((await read({...args,registry:undefined})).registered,1);
    assert.deepEqual(calls,[{url:endpoint,method:'GET',redirect:'error'}]);
  }
  assert.equal(stageCurrentPostalRegistrationReader({env:{...env,OPSMAP_STAGE_CURRENT_POSTAL_REGISTRATION_APPROVED:'0'},approvedRelease}),null);
  assert.equal(stageCurrentPostalRegistrationReader({env:{...env,RENDER_EXTERNAL_URL:'https://prod.example'},approvedRelease}),null);
});

test('same-runtime reads can recover when a newer pin appears after a temporary mismatch',async()=>{
  let version=binding.registry,available=binding.registry,calls=0;
  const row=makeRow('S1',126.5);
  const read=createCurrentPostalRegistrationReader({
    readRegistry:async()=>({ref:{version},rows:[row]}),
    readRegistryVersion:async()=>version,
    readAsset:async()=>{
      calls++;
      const asset=checked(new Map([['S1',{area:11111}]]));
      return {...asset,binding:{...asset.binding,registry:available}};
    }
  });
  assert.equal((await read({...args,registry:undefined})).registry,version);
  const old=version;
  version='e'.repeat(64);
  await assert.rejects(()=>read({...args,registry:undefined}),/REGISTRATION_CHANGED/);
  available=version;
  assert.equal((await read({...args,registry:undefined})).registry,version);
  await assert.rejects(()=>read({...args,registry:old}),/REGISTRATION_CHANGED/);
  assert.equal(calls,3);
});
