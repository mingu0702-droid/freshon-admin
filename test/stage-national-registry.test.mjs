import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createStageNationalRegistrationSource,createStageNationalRegistryReader,readApprovedOsanRegistryRecovery,
  scopedNationalRegistryMembership,syncStageNationalRegistry,verifiedNationalRegistryMembership}
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

test('official night registrations need no orders and preserve the previous registry on failed validation',async()=>{
  let tick=Date.parse('2026-11-19T02:00:00Z'), head=null, etag=null, revision=0;
  const objects=new Map();
  const store={key:Buffer.alloc(32,9),async readHead(){return {value:structuredClone(head),sha:etag};},
    async writeHead(value,expected){assert.equal(expected,etag);head=structuredClone(value);etag=(++revision).toString(16).padStart(40,'0');},
    async readObject(id){return objects.get(id);},async writeObject(id,value){objects.set(id,value);}};
  const receipt=id=>({date:new Date(tick+9*3600000).toISOString().slice(0,10),runId:id.repeat(64)});
  const location={addressHash:customerRegistryAddressHash(row('osan').basicAddress),lat:37.5,lng:127,kind:'BUILDING'};
  const pending='S10004', added='S10005', unproven='S10006', omitted='S10007', stable='S10008',
    parcel='S10009', noAddress='S10010', retired='S10011', missingClass='S10012';
  const original={
    osan:[row('osan'),row('osan',{customerCode:omitted}),row('osan',{customerCode:retired,lifecycle:'DELETED'})],
    yeongnam:[row('yeongnam'),row('yeongnam',{customerCode:stable})],
    honam:[row('honam'),row('honam',{customerCode:pending})]
  };
  const scoped=new Map(Object.entries(original).flatMap(([center,rows])=>rows.map(r=>[r.customerCode,
    {center,addressHash:customerRegistryAddressHash(r.basicAddress)}])));
  const publish=await syncStageNationalRegistry({store,receipt:receipt('a'),now:()=>tick,
    readCenter:async center=>({center,complete:true,rows:original[center],total:original[center].length}),
    readOfficial:async()=>[{...row('osan'),verifiedLocation:location}]});
  tick+=day;
  const observations={
    osan:[row('osan',{basicAddress:'경기 합성시 새주소로 20'}),row('osan',{customerCode:added}),
      row('osan',{customerCode:unproven,dispatch:'3',dispatchName:'주간 CJ'}),
      row('osan',{customerCode:noAddress,basicAddress:''}),row('osan',{customerCode:retired})],
    yeongnam:[row('yeongnam',{customerCode:pending}),row('yeongnam',{customerCode:stable}),
      row('yeongnam',{customerCode:parcel,dispatch:'1',dispatchName:'택배배송'})],
    honam:[row('honam'),row('honam',{customerCode:codes.yeongnam}),
      row('honam',{customerCode:missingClass,dispatch:null,dispatchName:null})]
  };
  const env={RENDER_EXTERNAL_URL:STAGE_ORIGIN,RENDER_SERVICE_ID:STAGE_SERVICE,OPSMAP_STAGE_NATIONAL_REGISTRY_APPROVED:'1',
    FRESHON_COOKIE:'fixture',OPSMAP_STAGE_NATIONAL_REGISTRY_CONTRACT_JSON:JSON.stringify({method:'POST',mode:'PAGED',
      rowsKey:'data',totalField:'totalCnt',totalLocation:'BODY',centerField:'logCd',activeField:'useYn',addressField:'address'})};
  const prepareSource=async previous=>{
    const selection=verifiedNationalRegistryMembership(scoped,previous);
    const readCenter=createStageNationalRegistrationSource({env,...selection,fetchImpl:async(url,options)=>{
      assert.equal(url.pathname,'/bo/sm/standard/ciList');
      const query=new URLSearchParams(options.body);
      const center=Object.keys(centerIds).find(key=>centerIds[key]===query.get('logCd'));
      assert.equal(query.get('useYn'),'Y');
      const rows=observations[center];
      return Response.json({totalCnt:rows.length,data:rows.map(r=>({estCd:r.customerCode,estName:r.customerName,address:r.basicAddress,
        logCd:centerIds[center],useYn:'Y',baecha:r.dispatch===undefined?'2':r.dispatch,
        baechaName:r.dispatchName===undefined?'야간배송':r.dispatchName}))});
    }});
    return {...selection,readCenter};
  };
  const run=id=>syncStageNationalRegistry({store,receipt:receipt(id),now:()=>tick,prepareSource,
    confirmCenterMoves:async requested=>new Map(requested.includes(codes.yeongnam)?[[codes.yeongnam,'honam']]:[])});
  const result=await run('b');
  assert.deepEqual(result.changes,{admitted:2,addressChanged:1,centerMoved:1,centerMoveUnconfirmed:1});
  assert.equal(head.previous.version,publish.version);
  const published=async()=>new Map((await createStageNationalRegistryReader({store,now:()=>tick}).read()).rows.map(r=>[r.customerCode,r]));
  let admitted=await published();
  assert.equal(admitted.get(codes.osan).basicAddress,'경기 합성시 새주소로 20');
  assert.equal(admitted.get(codes.osan).verifiedLocation,undefined);
  assert.equal(admitted.get(codes.yeongnam).centerGroup,'honam');
  assert.equal(admitted.get(pending).centerGroup,'honam');
  assert.equal(admitted.get(omitted).lifecycle,'ACTIVE');
  assert.equal(admitted.get(added).lifecycle,'ACTIVE');
  assert.equal(admitted.get(noAddress).basicAddress,'');
  assert.equal(admitted.get(noAddress).verifiedLocation,undefined);
  assert.equal(admitted.get(retired).lifecycle,'DELETED');
  assert(!admitted.has(unproven)&&!admitted.has(parcel)&&!admitted.has(missingClass));

  tick+=day;
  observations.osan[1].basicAddress='경기 합성시 등록후이전로 51';
  observations.yeongnam[1].basicAddress='경기 합성시 제외로 99';
  observations.yeongnam[1].dispatch='3';
  observations.yeongnam[1].dispatchName='주간배송';
  const subsequent=await run('c');
  assert.deepEqual(subsequent.changes,{admitted:0,addressChanged:1,centerMoved:0,centerMoveUnconfirmed:1});
  admitted=await published();
  assert.equal(admitted.get(added).basicAddress,'경기 합성시 등록후이전로 51');
  assert.equal(admitted.get(stable).basicAddress,original.yeongnam[1].basicAddress);

  tick+=day;
  observations.honam.push(row('honam',{customerCode:added,dispatch:'1',dispatchName:'택배배송'}));
  await assert.rejects(run('d'),{code:'NATIONAL_REGISTRY_DUPLICATE_CUSTOMER'});
  assert.equal(head.current.version,subsequent.version);
});
