import test from 'node:test';import assert from 'node:assert/strict';
import {createProductionSnapshotStore,snapshotProjection,materializeSnapshot} from '../src/productionSnapshotStore.js';
const production='srv-d87gc5rtqb8s7398t37g',stage='srv-da47hugu01pc73etpfa0';
const prodOrigin='https://freshon-admin-1.onrender.com',stageOrigin='https://freshon-admin-stage-preview-template.onrender.com';
const base={OPSMAP_SNAPSHOT_STORE_ENABLED:'1',OPSMAP_PRODUCTION_CANDIDATE_ENABLED:'1',OPSMAP_SNAPSHOT_STORE_REPO:'mingu0702-droid/freshon-cache'};
const synthetic={version:'phase2b-map-snapshot-v1',rowCount:1,startDate:'2026-07-22',latestDate:'2026-09-19',rows:[{customerCode:'T900001',customerName:'SYNTHETIC',lat:37.5,lng:127,lastDeliveryDate:'2026-09-19'}],sourceFreshness:{phase:'OBSERVED_ONLY'}};
const current=snapshotProjection(synthetic),state={schema:1,current,previous:null};
function reader(){const urls=[];return {urls,fetchImpl:async(url,options={})=>{assert.equal(options.method||'GET','GET');urls.push(url);return url.endsWith('/freshon-cache')?new Response(JSON.stringify({private:true})):new Response(JSON.stringify({sha:'1'.repeat(40),content:Buffer.from(JSON.stringify(state)).toString('base64')}));}};}
test('Stage same /opsmap application flag loads its isolated Stage branch and path',async()=>{
 const transport=reader(),env={...base,RENDER_SERVICE_ID:stage,RENDER_EXTERNAL_URL:stageOrigin,OPSMAP_SNAPSHOT_STORE_BRANCH:'stage/opsmap-snapshots'};
 const store=createProductionSnapshotStore({env,token:'SYNTHETIC_ONLY',fetchImpl:transport.fetchImpl});
 const value=await store.load(),snapshot=materializeSnapshot(value);assert.equal(snapshot.rows.length,1);assert.equal(snapshot.sourceFreshness.automaticSyncVerified,false);
 assert(transport.urls.at(-1).includes('/contents/opsmap-stage/map-snapshot-v1.json?ref=stage%2Fopsmap-snapshots'));assert(!transport.urls.some(x=>x.includes('/opsmap-production/')));
});
test('Stage cannot access Production snapshots even with Production UI enabled',()=>{
 assert.throws(()=>createProductionSnapshotStore({env:{...base,RENDER_SERVICE_ID:stage,RENDER_EXTERNAL_URL:stageOrigin,OPSMAP_SNAPSHOT_STORE_BRANCH:'production/opsmap-snapshots'},token:'SYNTHETIC_ONLY'}),{code:'SNAPSHOT_STORE_ENVIRONMENT'});
});
test('Production storage scope is determined by its service, not UI feature flag',async()=>{
 const transport=reader(),store=createProductionSnapshotStore({env:{...base,OPSMAP_PRODUCTION_CANDIDATE_ENABLED:'0',RENDER_SERVICE_ID:production,RENDER_EXTERNAL_URL:prodOrigin,OPSMAP_SNAPSHOT_STORE_BRANCH:'production/opsmap-snapshots'},token:'SYNTHETIC_ONLY',fetchImpl:transport.fetchImpl});
 await store.load();assert(transport.urls.at(-1).includes('/contents/opsmap-production/map-snapshot-v1.json?ref=production%2Fopsmap-snapshots'));
});
test('Production cannot access Stage snapshots',()=>{
 assert.throws(()=>createProductionSnapshotStore({env:{...base,RENDER_SERVICE_ID:production,RENDER_EXTERNAL_URL:prodOrigin,OPSMAP_SNAPSHOT_STORE_BRANCH:'stage/opsmap-snapshots'},token:'SYNTHETIC_ONLY'}),{code:'SNAPSHOT_STORE_ENVIRONMENT'});
});
test('service and exact origin mismatch fails before any transport request',()=>{
 for(const extra of [{RENDER_SERVICE_ID:stage,RENDER_EXTERNAL_URL:prodOrigin},{RENDER_SERVICE_ID:'srv-unknown',RENDER_EXTERNAL_URL:stageOrigin},{RENDER_SERVICE_ID:stage,RENDER_EXTERNAL_URL:'https://unrelated.example'},{RENDER_SERVICE_ID:stage,RENDER_EXTERNAL_URL:stageOrigin+'/opsmap/'},{RENDER_SERVICE_ID:stage,RENDER_EXTERNAL_URL:stageOrigin+'/?q=1'}])assert.throws(()=>createProductionSnapshotStore({env:{...base,...extra,OPSMAP_SNAPSHOT_STORE_BRANCH:'stage/opsmap-snapshots'},token:'SYNTHETIC_ONLY'}),{code:'SNAPSHOT_STORE_ENVIRONMENT'});
});
test('exact Stage origin is sufficient when Render service ID is not supplied',()=>{
 const store=createProductionSnapshotStore({env:{...base,RENDER_EXTERNAL_URL:stageOrigin+'/',OPSMAP_SNAPSHOT_STORE_BRANCH:'stage/opsmap-snapshots'},token:'SYNTHETIC_ONLY'});assert.equal(store.kind,'PRIVATE_GITHUB_CAS');
});
test('local isolated processes retain existing explicit branch contract',()=>{
 assert.equal(createProductionSnapshotStore({env:{...base,OPSMAP_SNAPSHOT_STORE_BRANCH:'production/opsmap-snapshots'},token:'SYNTHETIC_ONLY'}).kind,'PRIVATE_GITHUB_CAS');
 assert.equal(createProductionSnapshotStore({env:{...base,OPSMAP_PRODUCTION_CANDIDATE_ENABLED:'0',OPSMAP_SNAPSHOT_STORE_BRANCH:'stage/opsmap-snapshots'},token:'SYNTHETIC_ONLY'}).kind,'PRIVATE_GITHUB_CAS');
 assert.throws(()=>createProductionSnapshotStore({env:{...base,OPSMAP_SNAPSHOT_STORE_BRANCH:'stage/opsmap-snapshots'},token:'SYNTHETIC_ONLY'}),{code:'SNAPSHOT_STORE_ENVIRONMENT'});
});
