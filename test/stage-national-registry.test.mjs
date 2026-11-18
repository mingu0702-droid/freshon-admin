import test from 'node:test';
import assert from 'node:assert/strict';
import {createStageNationalRegistrationSource,createStageNationalRegistryReader,syncStageNationalRegistry}
  from '../src/stageNationalRegistry.js';
import {customerRegistryAddressHash} from '../src/customerRegistry.js';
import {STAGE_ORIGIN,STAGE_SERVICE} from '../src/stageScope.js';

const day=24*60*60_000;
const codes={osan:'S10001',yeongnam:'S10002',honam:'S10003'};
const centerIds={osan:'011',yeongnam:'012',honam:'013'};
const row=(center,overrides={})=>({customerCode:codes[center],customerName:'합성 매장',basicAddress:'경기 합성시 합성로 10',
  centerGroup:center,lifecycle:'ACTIVE',...overrides});

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

test('the registration transport reads only the exact FreshOn master, rejects incomplete or unrelated pages and never calls Delivery Admin',async()=>{
  const env={RENDER_EXTERNAL_URL:STAGE_ORIGIN,RENDER_SERVICE_ID:STAGE_SERVICE,OPSMAP_STAGE_NATIONAL_REGISTRY_APPROVED:'1',
    FRESHON_COOKIE:'isolated-fixture-only',OPSMAP_STAGE_NATIONAL_REGISTRY_CONTRACT_JSON:JSON.stringify({method:'POST',mode:'FULL',
      rowsKey:'data',totalField:'totalCnt',totalLocation:'BODY',centerField:'logCd',activeField:'useYn',addressField:'address'})};
  let conflict=false;const calls=[];
  const source=createStageNationalRegistrationSource({env,fetchImpl:async(url,options)=>{
    assert.equal(url.href,'https://mis.freshon.co.kr/bo/sm/standard/ciList');
    assert.equal(options.method,'POST');
    const {logCd,useYn}=Object.fromEntries(new URLSearchParams(options.body));
    calls.push([logCd,useYn]);
    const item={estCd:codes.yeongnam,estName:'합성 매장',address:'경기 합성시 합성로 10',
      logCd:conflict?centerIds.honam:logCd,useYn};
    return Response.json(useYn==='Y'?{totalCnt:1,data:[item]}:{totalCnt:0,data:[]});
  }});
  const checked=await source('yeongnam');
  assert.equal(checked.rows[0].centerGroup,'yeongnam');
  assert.deepEqual(calls,[['012','Y'],['012','N']]);
  conflict=true;
  await assert.rejects(source('yeongnam'),{code:'NATIONAL_REGISTRY_SOURCE_SCOPE'});
  await assert.rejects(source('osanColdStorage'),{code:'NATIONAL_REGISTRY_SOURCE_SCOPE'});
});
