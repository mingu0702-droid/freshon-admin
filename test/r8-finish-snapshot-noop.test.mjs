import test from 'node:test';
import assert from 'node:assert/strict';
import {createProductionSnapshotStore,snapshotProjection,materializeSnapshot} from '../src/productionSnapshotStore.js';
import {deliverySourceObservation,snapshotRefreshEvidence} from '../src/snapshotRefreshEvidence.js';
const env={OPSMAP_SNAPSHOT_STORE_ENABLED:'1',OPSMAP_PRODUCTION_CANDIDATE_ENABLED:'1',OPSMAP_SNAPSHOT_STORE_REPO:'mingu0702-droid/freshon-cache',OPSMAP_SNAPSHOT_STORE_BRANCH:'production/opsmap-snapshots'};
const snap=(name='SYNTHETIC')=>({version:'phase2b-map-snapshot-v1',rows:[{customerCode:'T900001',customerName:name,lat:37.5,lng:127,lastDeliveryDate:'2026-10-31'}],rowCount:1,startDate:'2026-09-01'});
function repository({failReadback=false}={}){
 let state=null,sha=null,puts=0;
 const fetchImpl=async(url,options={})=>{
  if(url.endsWith('/freshon-cache'))return new Response(JSON.stringify({private:true}));
  if(options.method==='PUT'){const data=JSON.parse(options.body);assert.equal(data.sha??null,sha);state=JSON.parse(Buffer.from(data.content,'base64'));sha=String(++puts).padStart(40,'0');return new Response('{}');}
  if(puts&&failReadback)return new Response('{}',{status:500});
  return state?new Response(JSON.stringify({sha,content:Buffer.from(JSON.stringify(state)).toString('base64')})):new Response('{}',{status:404});
 };
 return {fetchImpl,get puts(){return puts;},get state(){return state;}};
}
test('identical projected data is a persistent NOOP across clock changes and new processes',async()=>{
 const github=repository();let clock=Date.parse('2026-11-02T00:00:00Z');
 const create=()=>createProductionSnapshotStore({env,token:'SYNTHETIC_ONLY',fetchImpl:github.fetchImpl,now:()=>clock});
 const first=await create().save(snap());clock+=3600000;const restarted=create();
 const second=await restarted.save({...snap(),generatedAt:new Date(clock).toISOString()});
 assert.equal(second.sha256,first.sha256);assert.equal(second.revision,first.revision);assert.equal(github.puts,1);
 assert.equal(restarted.status().lastSaveState,'PROJECTION_NOOP');assert.equal(materializeSnapshot(second).sourceFreshness.automaticSyncVerified,false);
});
test('a real projected-field change writes once and keeps the previous verified record',async()=>{
 const github=repository(),store=createProductionSnapshotStore({env,token:'SYNTHETIC_ONLY',fetchImpl:github.fetchImpl});
 const first=await store.save(snap());const changed=await store.save(snap('SYNTHETIC UPDATED'));
 assert.equal(github.puts,2);assert.equal(changed.rows[0].customerName,'SYNTHETIC UPDATED');assert.equal(github.state.previous.sha256,first.sha256);assert.equal(store.status().lastSaveState,'STORED');
});
test('readback failure cannot report STORED or projection NOOP',async()=>{
 const github=repository({failReadback:true}),store=createProductionSnapshotStore({env,token:'SYNTHETIC_ONLY',fetchImpl:github.fetchImpl});
 await assert.rejects(store.save(snap()),{code:'FIXED_STORE_READ'});assert.equal(store.status().lastSaveState,'FAILED');
});
test('a current date observation cannot invent an unknown historical resume cursor',()=>{
 const date='2026-11-02',sourceObservation=deliverySourceObservation([{id:1,deliveryDate:date}],{date,complete:true,pages:1});
 const evidence=snapshotRefreshEvidence({targetDate:date,previousThrough:null,todayStatus:{date,sourceObservation}});
 assert.equal(evidence.refreshedThrough,null);assert.equal(evidence.refreshComplete,false);assert.equal(evidence.sourceFreshness.phase,'CHECKPOINT_UNVERIFIED');assert.equal(evidence.sourceFreshness.sourceDateVerified,true);assert.equal(evidence.sourceFreshness.automaticSyncVerified,false);
 assert.throws(()=>snapshotRefreshEvidence({targetDate:date,previousThrough:null,completedDates:['2026-11-01']}),/SNAPSHOT_CHECKPOINT_NOT_CONTIGUOUS/);
 const failed=snapshotRefreshEvidence({targetDate:date,previousThrough:null,sourceFailed:true});assert.equal(failed.sourceFreshness.phase,'SOURCE_FAILED');assert.equal(failed.refreshedThrough,null);
});
test('source versions remain exact strings and numeric approximations are not certified',()=>{
 const exact='18446744073709551615';const valid=snapshotProjection({...snap(),sourceFreshness:{sourceVersion:exact}});
 assert.equal(valid.sourceEvidence.sourceVersion,exact);
 const approximate=snapshotProjection({...snap(),sourceFreshness:{sourceVersion:Number(exact)}});assert.equal(approximate.sourceEvidence.sourceVersion,null);
});
