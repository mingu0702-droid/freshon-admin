import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshotProjection,materializeSnapshot} from '../src/productionSnapshotStore.js';
import {phase2bSnapshotMeta} from '../src/phase2bOperations.js';

test('durable observed projection exposes its revision without inventing a completed-read date',()=>{
 const projection=snapshotProjection({version:'phase2b-map-snapshot-v1',rowCount:1,rows:[{customerCode:'T900001',lat:37.5,lng:127,lastDeliveryDate:'2026-10-31'}],sourceFreshness:{phase:'OBSERVED_ONLY'}});
 const meta=phase2bSnapshotMeta(materializeSnapshot(projection));
 assert.equal(meta.refreshedThrough,null);
 assert.equal(meta.stale,true);assert.equal(meta.sourceVerified,false);
 assert.deepEqual(meta.preservation,{source:'PRIVATE_GITHUB_CAS',version:projection.sha256,revision:1});
});
test('legacy observed date remains separate from verified source completion',()=>{
 const meta=phase2bSnapshotMeta({latestDate:'2026-11-02',generatedAt:new Date().toISOString(),rowCount:1});
 assert.equal(meta.sourceVerified,false);assert.equal(meta.stale,true);
 assert.equal(Object.hasOwn(meta,'preservation'),false);
});
