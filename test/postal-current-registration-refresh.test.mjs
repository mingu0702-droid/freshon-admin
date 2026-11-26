import assert from 'node:assert/strict';
import test from 'node:test';
import {customerRegistryAddressHash} from '../src/customerRegistry.js';
import {STAGE_ORIGIN,STAGE_SERVICE} from '../src/stageScope.js';
import {sealCurrentPostalRegistration,verifyCurrentPostalRegistration} from '../src/shadowCoverage/postalCurrentRegistrationAsset.js';
import {createStageCurrentPostalRefreshStore} from '../src/shadowCoverage/postalCurrentRegistrationStore.js';
import {refreshStageCurrentPostalRegistration} from '../src/shadowCoverage/postalCurrentRegistrationRefresh.js';

const key=Buffer.alloc(32,9), before='a'.repeat(64), after='b'.repeat(64);
const binding={boundary:'c'.repeat(64),release:'d'.repeat(64)};
const row=(customerCode,lng,lifecycle='ACTIVE')=>{
  const basicAddress='Synthetic registered building '+customerCode+' '+lng;
  const addressHash=customerRegistryAddressHash(basicAddress);
  return {customerCode,lifecycle,centerGroup:'osan',basicAddress,addressHash,
    verifiedLocation:{kind:'BUILDING',addressHash,lat:37.5,lng}};
};
const zone={id:22222,box:[126e6,37e6,127e6,38e6],
  rings:[Int32Array.from([126e6,37e6,127e6,37e6,127e6,38e6,126e6,38e6])]};
const conflict=()=>Object.assign(Error('conflict'),{code:'FIXED_STORE_CONFLICT'});

function fixture(){
  const previous=[row('S1',126.4),row('S2',125.5),row('S3',126.6)];
  const rows=[{...previous[0],customerName:'Renamed'},row('S2',126.5),row('S3',126.6,'DELETED'),row('S4',127)];
  const seed=sealCurrentPostalRegistration({binding:{...binding,registry:before},assignments:new Map([
    ['S1',{area:22222}],['S2',{area:11111}],['S3',{area:22222}]
  ])},key);
  const objects=new Map(), actions=[];
  let current=null, old=null, etag=null, version=after;
  const store={key,
    async readHead(){return {current,previous:old,etag};},
    async readObject(ref){return objects.get(ref.sha256);},
    async createObject(ref,bytes){
      if(objects.has(ref.sha256))throw conflict();
      actions.push('object');
      objects.set(ref.sha256,bytes);
    },
    async writeHead(next,prior,expected){
      if(etag!==expected)throw conflict();
      actions.push('pointer');
      current=next;old=prior;etag='1';
    }
  };
  const args={store,binding,
    readRegistry:async()=>({ref:{version:after},rows}),readRegistryVersion:async()=>version,
    readRegistryRows:async version=>{assert.equal(version,before);return previous;},
    readLegacyRegistration:async()=>new Set(['S9']),
    async *readDetailTiles(changed){
      actions.push('geometry');
      assert.deepEqual(changed.map(row=>row.customerCode),['S2','S4']);
      yield {box:[126,37,127,38],zones:[zone]};
    },
    fallback:async()=>seed
  };
  return {args,actions,objects,seed,changeVersion(next){version=next;}};
}

test('incremental refresh keeps only unchanged identical proofs, publishes once and retains previous',async()=>{
  const f=fixture();
  const result=await refreshStageCurrentPostalRegistration(f.args);
  assert.deepEqual(result,{state:'PUBLISHED',registry:after,matchedCount:2,reusedCount:1,changedCount:2,ambiguousCount:1,outsideCount:0});
  const head=await f.args.store.readHead();
  assert.equal(head.previous.sha256,f.seed.sha256);
  const current=verifyCurrentPostalRegistration(f.objects.get(head.current.sha256),head.current.sha256,key);
  assert.deepEqual(current.rows,[['S1',22222],['S2',22222]]);
  assert.deepEqual(f.actions,['geometry','object','object','pointer']);
  assert.equal((await refreshStageCurrentPostalRegistration({...f.args,readRegistryRows:()=>assert.fail(),fallback:()=>assert.fail()})).state,'VERIFIED_NOOP');
  assert.deepEqual(f.actions,['geometry','object','object','pointer']);
});

test('concurrent refreshers converge on one authenticated CAS pointer',async()=>{
  const f=fixture();
  const results=await Promise.all([refreshStageCurrentPostalRegistration(f.args),refreshStageCurrentPostalRegistration(f.args)]);
  assert.deepEqual(results.map(result=>result.state).sort(),['PUBLISHED','VERIFIED_NOOP']);
  assert.equal(f.actions.filter(action=>action==='pointer').length,1);
  const {previous}=await f.args.store.readHead();
  assert.equal(previous.registry,before);
  assert(f.objects.has(previous.sha256));
});

test('a version change during geometry and a corrupt previous proof both block publication',async()=>{
  const f=fixture();
  const geometry=f.args.readDetailTiles;
  await assert.rejects(()=>refreshStageCurrentPostalRegistration({...f.args,async *readDetailTiles(rows){
    yield* geometry(rows);f.changeVersion('e'.repeat(64));
  }}),/POSTAL_REGISTRATION_REFRESH_REGISTRY_CHANGED/);
  assert.equal(f.actions.filter(action=>action==='pointer').length,0);
  assert.equal(f.objects.size,0);
  f.changeVersion(after);
  await assert.rejects(()=>refreshStageCurrentPostalRegistration({...f.args,
    readRegistryRows:async()=>[row('S1',126.4)]}),/POSTAL_REGISTRATION_REFRESH_PREVIOUS_REGISTRY/);
  assert.equal(f.objects.size,0);
});

test('a bulk postal loss leaves both the previous asset and pointer intact',async()=>{
  const f=fixture();
  const prior=Array.from({length:12},(_,i)=>row('S'+(20+i),126.4));
  const seed=sealCurrentPostalRegistration({binding:{...binding,registry:before},
    assignments:new Map(prior.map(({customerCode})=>[customerCode,{area:22222}]))},key);
  await assert.rejects(refreshStageCurrentPostalRegistration({...f.args,
    readRegistry:async()=>({ref:{version:after},rows:prior.map(({verifiedLocation,...saved})=>saved)}),
    readRegistryRows:async()=>prior,fallback:async()=>seed}),/POSTAL_REGISTRATION_REFRESH_BULK_LOSS/);
  assert.equal(f.objects.size,0);
  assert.deepEqual(f.actions,[]);
});

test('Stage store gates write separately, confines paths and rejects a tampered signed head',async()=>{
  const archiveEnv={RENDER_SERVICE_ID:STAGE_SERVICE,RENDER_EXTERNAL_URL:STAGE_ORIGIN,
    OPSMAP_STAGE_SYNC_REMOTE_APPROVED:'1',OPSMAP_STAGE_SYNC_PUBLISH_APPROVED:'1',
    OPSMAP_STAGE_CURRENT_POSTAL_REFRESH_APPROVED:'1',GITHUB_TOKEN:'stage-reader',
    OPSMAP_STAGE_SYNC_WRITE_TOKEN:'stage-writer',OPSMAP_SHADOW_POSTAL_ASSET_KEY_B64:key.toString('base64')};
  assert.equal(createStageCurrentPostalRefreshStore({env:archiveEnv,write:true}),null);
  assert.equal(createStageCurrentPostalRefreshStore({env:{...archiveEnv,RENDER_EXTERNAL_URL:'https://prod.example'}}),null);
  const known={...binding,registry:after,sha256:'e'.repeat(64)};
  const files=new Map(), calls=[];
  const fetchImpl=async(input,options)=>{
    const url=new URL(input),name=url.pathname.split('/').at(-1),method=options.method||'GET';
    calls.push({href:url.href,method,auth:options.headers.Authorization});
    if(name==='freshon-cache')return Response.json({private:true});
    assert(url.pathname.startsWith('/repos/mingu0702-droid/freshon-cache/contents/opsmap-stage/postal-v1/'));
    if(method==='PUT'){
      const payload=JSON.parse(options.body);
      assert.equal(payload.branch,'stage/opsmap-postal-v1');
      files.set(name,JSON.parse(Buffer.from(payload.content,'base64')));
      return new Response(null,{status:201});
    }
    assert.equal(url.searchParams.get('ref'),'stage/opsmap-postal-v1');
    return files.has(name)?Response.json(files.get(name)):new Response(null,{status:404});
  };
  const store=createStageCurrentPostalRefreshStore({env:{...archiveEnv,OPSMAP_STAGE_CURRENT_POSTAL_REFRESH_WRITE_APPROVED:'1'},write:true,fetchImpl});
  const reader=createStageCurrentPostalRefreshStore({env:archiveEnv,fetchImpl});
  await store.createObject(known,Buffer.from('synthetic sealed bytes'));
  await store.writeHead(known,null,null);
  assert.deepEqual(await reader.readHead(),{current:known,previous:null});
  assert.equal((await reader.readObject(known)).toString(),'synthetic sealed bytes');
  assert(calls.filter(call=>call.method==='PUT').every(call=>call.auth==='Bearer stage-writer'));
  const head=files.get('current-registration-head-v1.json');
  head.current.registry=before;
  await assert.rejects(()=>reader.readHead(),/POSTAL_REGISTRATION_STORE_INVALID/);
});
