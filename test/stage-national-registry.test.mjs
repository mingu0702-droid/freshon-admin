import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createStageNationalRegistrationSource,createStageNationalRegistryReader,readApprovedOsanRegistryRecovery,scopedNationalRegistryMembership,syncStageNationalRegistry}
  from '../src/stageNationalRegistry.js';
import {customerRegistryAddressHash} from '../src/customerRegistry.js';
import {STAGE_ORIGIN,STAGE_SERVICE} from '../src/stageScope.js';
import {createStageSyncReaders} from '../src/stageVerificationEntry.js';
import {createStageShadowRuntime} from '../src/shadowCoverage/stageArchive.js';

const day=24*60*60_000;
const codes={osan:'S10001',yeongnam:'S10002',honam:'S10003'};
const centerIds={osan:'011',yeongnam:'012',honam:'013'};
const row=(center,overrides={})=>({customerCode:codes[center],customerName:'합성 매장',basicAddress:'경기 합성시 합성로 10',
  centerGroup:center,lifecycle:'ACTIVE',...overrides});

test('Stage can read all three sync stores when its archive token is excluded from the app environment',async()=>{
  const env={RENDER_EXTERNAL_URL:STAGE_ORIGIN,RENDER_SERVICE_ID:STAGE_SERVICE,
    OPSMAP_STAGE_SYNC_REMOTE_APPROVED:'1',OPSMAP_STAGE_NATIONAL_REGISTRY_APPROVED:'1',
    OPSMAP_STAGE_FIXED_MASTER_SYNC_APPROVED:'1',OPSMAP_STAGE_RECENT_OPERATIONS_SYNC_APPROVED:'1',
    OPSMAP_SHADOW_GITHUB_READ_TOKEN:'stage-reader-test',OPSMAP_SHADOW_POSTAL_ASSET_KEY_B64:Buffer.alloc(32,9).toString('base64')};
  assert.equal(createStageShadowRuntime(env).env.OPSMAP_SHADOW_GITHUB_READ_TOKEN,undefined);
  const paths=[];
  const readers=createStageSyncReaders({env,fetchImpl:async(input,options)=>{
    const url=new URL(input);
    assert.equal(url.origin,'https://api.github.com');
    assert.equal(options.method??'GET','GET');
    assert.equal(options.headers.Authorization,'Bearer stage-reader-test');
    if(!url.search)return Response.json({private:true});
    assert.equal(url.searchParams.get('ref'),'stage/opsmap-snapshots');
    paths.push(url.pathname.split('/contents/opsmap-stage/')[1]);
    return new Response(null,{status:404});
  }});
  assert.equal(await readers.recentOperations.read(),null);
  assert.deepEqual(await readers.nationalRegistry.readHead(),{sha:null,value:null});
  assert.equal(await readers.fixedMaster().loadBaseline(),null);
  assert.deepEqual(paths.sort(),['fixed-vehicle-projection-v1.json','recent-operations-v1/current.json','stage-national-registry-v1/head.json']);
  assert.equal(readers.recentOperations.write,undefined);
  assert.equal(readers.nationalRegistry.writeHead,undefined);
  assert.equal(readers.fixedMaster().write,undefined);
});

test('a signed daily candidate preserves missing rows, updates new or revised rows and requires an explicit inactive record',async()=>{
  let tick=Date.parse('2026-11-18T02:00:00Z'), head=null, etag=null, serial=0;
  const objects=new Map();
  const store={key:Buffer.alloc(32,9),async readHead(){return {value:structuredClone(head),sha:etag};},
    async writeHead(value,expected){assert.equal(expected,etag);head=structuredClone(value);etag=(++serial).toString(16).padStart(40,'0');},
    async readObject(id){return objects.get(id);},
    async writeObject(id,value){assert(!objects.has(id));objects.set(id,value);}};
  const original=row('yeongnam');
  const location={addressHash:customerRegistryAddressHash(original.basicAddress),lat:35.5,lng:128,kind:'BUILDING'};
  const known={...original,verifiedLocation:location};
  let rows={osan:[row('osan')],yeongnam:[row('yeongnam')],honam:[row('honam')]};
  let broken=null;
  const readCenter=async center=>({center,rows:rows[center],total:rows[center].length+(broken===center?1:0),complete:true});
  const publish=id=>syncStageNationalRegistry({store,receipt:{date:new Date(tick).toISOString().slice(0,10),runId:id.repeat(64)},
    readCenter,readOfficial:async()=>[known],now:()=>tick});
  const first=await publish('a');
  assert.equal(first.state,'PUBLISHED');
  assert.equal((await publish('b')).state,'ALREADY_VERIFIED');
  const initial=await createStageNationalRegistryReader({store,now:()=>tick}).read();
  assert.equal(initial.rows.find(r=>r.customerCode===codes.yeongnam).verifiedLocation.lat,location.lat);
  assert(!JSON.stringify([...objects.values()]).includes(original.basicAddress));
  tick+=day; broken='honam';
  await assert.rejects(publish('b'),{code:'NATIONAL_REGISTRY_CENTER_INCOMPLETE'});
  assert.equal((await createStageNationalRegistryReader({store,now:()=>tick}).read()).ref.version,first.version);
  assert.equal((await publish('b')).state,'ALREADY_ATTEMPTED');
  broken=null;
  rows={osan:[row('osan',{lifecycle:'DELETED'})],yeongnam:[row('yeongnam',{basicAddress:'경기 합성시 새로 20'})],
    honam:[row('honam',{customerCode:'S10004',customerName:'합성 신규'})]};
  const next=await publish('c');
  assert.equal(next.state,'PUBLISHED');
  assert.equal(head.previous.version,first.version);
  const saved=(await createStageNationalRegistryReader({store,now:()=>tick}).read()).rows;
  assert.deepEqual(saved.map(r=>[r.customerCode,r.lifecycle]),[
    ['S10001','DELETED'],['S10002','ACTIVE'],['S10003','ACTIVE'],['S10004','ACTIVE']]);
  assert(!saved[1].verifiedLocation);
  assert.equal(objects.size,2);
});

test('only the approved active Osan recovery set enters the scheduled registration membership',async()=>{
  const addressHash=customerRegistryAddressHash(row('osan').basicAddress);
  const recovery=Array.from({length:374},(_,i)=>row('osan',{customerCode:'S'+(20000+i),addressHash}));
  const text=JSON.stringify({schema:1,approval:'FRESHON_OSAN_RECOVERY_20261125',rows:recovery.map(r=>[r.customerCode,addressHash])});
  const digest=createHash('sha256').update(text).digest('hex');
  const env={RENDER_EXTERNAL_URL:STAGE_ORIGIN,RENDER_SERVICE_ID:STAGE_SERVICE,
    OPSMAP_STAGE_NATIONAL_REGISTRY_APPROVED:'1',OPSMAP_OSAN_REGISTRY_RECOVERY_SHA256:digest};
  const readRegistry=async()=>({ref:{version:'a'.repeat(64)},rows:recovery});
  const readManifest=async()=>text;
  const available=await readApprovedOsanRegistryRecovery({env,readRegistry,readManifest});
  assert.equal(available.length,374);
  const extra=Array.from({length:24},(_,i)=>row('osan',{customerCode:'S'+(24000+i),addressHash}));
  const cutover=JSON.stringify({schema:1,approval:'FRESHON_OSAN_CUTOVER_20261125',
    rows:[...recovery,...extra].map(r=>[r.customerCode,addressHash])});
  const cutoverEnv={...env,OPSMAP_OSAN_REGISTRY_RECOVERY_SHA256:createHash('sha256').update(cutover).digest('hex')};
  assert.equal((await readApprovedOsanRegistryRecovery({env:cutoverEnv,readManifest:async()=>cutover,
    readRegistry:async()=>({ref:{version:'a'.repeat(64)},rows:[...recovery,...extra]})})).length,398);
  await assert.rejects(readApprovedOsanRegistryRecovery({env:cutoverEnv,readRegistry,readManifest:async()=>cutover}),/RECOVERY_SCOPE/);
  const original=Object.entries(codes).map(([center,code])=>[code,center,addressHash]);
  const membership=scopedNationalRegistryMembership(original,[],available);
  assert.equal(membership.size,377);
  assert.deepEqual(membership.get(recovery[0].customerCode),{center:'osan',addressHash});
  assert.equal(membership.has('S29999'),false);
  assert.equal(scopedNationalRegistryMembership([...original,available[0]],[],available).size,377);
  await assert.rejects(readApprovedOsanRegistryRecovery({env,readRegistry,readManifest:async()=>text+' '}),/RECOVERY_SCOPE/);
  await assert.rejects(readApprovedOsanRegistryRecovery({env,readManifest,
    readRegistry:async()=>({...await readRegistry(),rows:recovery.slice(1)})}),/RECOVERY_SCOPE/);
  recovery[0].lifecycle='DELETED';recovery[1].addressHash='b'.repeat(64);recovery[2].centerGroup='honam';
  assert.equal((await readApprovedOsanRegistryRecovery({env,readRegistry,readManifest})).length,371);
  assert.deepEqual(await readApprovedOsanRegistryRecovery({env:{}}),[]);
  const held={customerCode:'S29999',legacyVersion:'c'.repeat(64),state:'SOURCE_INACTIVE_UNCONFIRMED'};
  const includingHeld=JSON.stringify({...JSON.parse(text),held});
  const heldEnv={...env,OPSMAP_OSAN_REGISTRY_RECOVERY_SHA256:createHash('sha256').update(includingHeld).digest('hex')};
  const activeOnly=await readApprovedOsanRegistryRecovery({env:heldEnv,readRegistry,readManifest:async()=>includingHeld});
  assert(!activeOnly.some(([code])=>code===held.customerCode));
  const invalid=JSON.stringify({...JSON.parse(text),held:{...held,customerCode:recovery[0].customerCode}});
  const invalidEnv={...env,OPSMAP_OSAN_REGISTRY_RECOVERY_SHA256:createHash('sha256').update(invalid).digest('hex')};
  await assert.rejects(readApprovedOsanRegistryRecovery({env:invalidEnv,readRegistry,readManifest:async()=>invalid}),/RECOVERY_SCOPE/);
});

test('the registration transport reads only the exact FreshOn master, rejects incomplete or unrelated pages and never calls Delivery Admin',async()=>{
  const env={RENDER_EXTERNAL_URL:STAGE_ORIGIN,RENDER_SERVICE_ID:STAGE_SERVICE,OPSMAP_STAGE_NATIONAL_REGISTRY_APPROVED:'1',
    FRESHON_COOKIE:'isolated-fixture-only',OPSMAP_STAGE_NATIONAL_REGISTRY_CONTRACT_JSON:JSON.stringify({method:'POST',mode:'FULL',
      rowsKey:'data',totalField:'totalCnt',totalLocation:'BODY',centerField:'logCd',activeField:'useYn',addressField:'address'})};
  let conflict=false, missingAddress=false;
  const calls=[];
  const source=createStageNationalRegistrationSource({env,fetchImpl:async(url,options)=>{
    assert.equal(url.href,'https://mis.freshon.co.kr/bo/sm/standard/ciList');
    assert.equal(options.method,'POST');
    const {logCd,useYn}=Object.fromEntries(new URLSearchParams(options.body));
    calls.push([logCd,useYn]);
    const item={estCd:codes.yeongnam,estName:'합성 매장',address:'경기 합성시 합성로 10',
      logCd:conflict?centerIds.honam:logCd,useYn};
    if (missingAddress) delete item.address;
    return Response.json(useYn==='Y'?{totalCnt:1,data:[item]}:{totalCnt:0,data:[]});
  }});
  const checked=await source('yeongnam');
  assert.equal(checked.rows[0].centerGroup,'yeongnam');
  assert.deepEqual(calls,[['012','Y'],['012','N']]);
  conflict=true;
  await assert.rejects(source('yeongnam'),{code:'NATIONAL_REGISTRY_SOURCE_SCOPE'});
  conflict=false;
  missingAddress=true;
  await assert.rejects(source('yeongnam'),{code:'NATIONAL_REGISTRY_SOURCE_CONTRACT'});
  await assert.rejects(source('osanColdStorage'),{code:'NATIONAL_REGISTRY_SOURCE_SCOPE'});
});

test('Stage registry accepts only known customer, center and address combinations from the broader active master',async()=>{
  const address=row('osan').basicAddress;
  const current=[['S10001','osan',customerRegistryAddressHash(address)]];
  const regional=[row('yeongnam'),row('honam')];
  const membership=scopedNationalRegistryMembership(current,regional);
  assert.throws(()=>scopedNationalRegistryMembership(current,[row('osan'),...regional]),/SCOPE_UNAVAILABLE/);
  const env={RENDER_EXTERNAL_URL:STAGE_ORIGIN,RENDER_SERVICE_ID:STAGE_SERVICE,OPSMAP_STAGE_NATIONAL_REGISTRY_APPROVED:'1',
    FRESHON_COOKIE:'isolated-fixture-only',OPSMAP_STAGE_NATIONAL_REGISTRY_CONTRACT_JSON:JSON.stringify({method:'POST',mode:'PAGED',
      rowsKey:'data',totalField:'totalCnt',totalLocation:'FIRST_ROW',centerField:'logCdName',activeField:'useYn',addressField:'address'})};
  const incoming=[
    {estCd:'S10001',address},
    {estCd:'S10002',address},
    {estCd:'S99999',address:'경기 합성시 미승인로 31'}
  ];
  const read=createStageNationalRegistrationSource({env,membership,fetchImpl:async(_url,options)=>{
    const query=new URLSearchParams(options.body);
    assert.equal(query.get('useYn'),'Y');
    assert.equal(query.get('logCd'),'011');
    assert.equal(query.get('sort'),'est_cd,ASC');
    return Response.json({data:incoming.map(row=>({...row,estName:'새 이름',useYn:'Y',logCdName:'오산물류센터',totalCnt:3}))});
  }});
  const selected=await read('osan');
  assert.equal(selected.complete,true);
  assert.deepEqual(selected.rows.map(row=>row.customerCode),['S10001']);
  incoming[0].address='경기 합성시 주소변경로 20';
  assert.deepEqual((await read('osan')).rows,[]);
});
