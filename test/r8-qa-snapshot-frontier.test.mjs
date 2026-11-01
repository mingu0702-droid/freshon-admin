import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshotProjection,mergePreservedSnapshot,materializeSnapshot,validateSnapshotProjection} from '../src/productionSnapshotStore.js';
const row=(code,date)=>({customerCode:code,lastDeliveryDate:date,lat:37.5,lng:127});
const snapshot=(rows,checkedThrough,targetDate='2026-11-02')=>({version:'phase2b-map-snapshot-v1',rowCount:rows.length,rows,sourceFreshness:{targetDate,checkedThrough,phase:'PARTIAL',sourceDateVerified:false,sourceReadComplete:false}});

test('independent QA: stale writer cannot move a saved cursor backwards while adding new customers',()=>{
 const previous=snapshotProjection(snapshot([row('T900001','2026-10-31')],'2026-10-31'));
 const merged=mergePreservedSnapshot(previous,snapshot([row('T900002','2026-11-02')],'2026-08-24'));
 assert.equal(merged.rowCount,2);
 assert.equal(merged.checkpointDate,'2026-10-31');
 assert.equal(merged.sourceEvidence.checkedThrough,merged.checkpointDate);
 assert.equal(materializeSnapshot(merged).refreshedThrough,'2026-10-31');
 assert.equal(materializeSnapshot(merged).sourceFreshness.automaticSyncVerified,false);
 validateSnapshotProjection(merged);
});

test('independent QA: older selected-date metadata cannot replace a newer observation, and forward cursor advances',()=>{
 const previous=snapshotProjection(snapshot([row('T900001','2026-11-02')],'2026-10-31'));
 const merged=mergePreservedSnapshot(previous,snapshot([row('T900002','2026-10-30')],'2026-10-30','2026-10-30'));
 assert.equal(merged.sourceEvidence.targetDate,'2026-11-02');
 assert.equal(merged.checkpointDate,'2026-10-31');
 const advanced=mergePreservedSnapshot(merged,snapshot([row('T900003','2026-11-02')],'2026-11-01'));
 assert.equal(advanced.checkpointDate,'2026-11-01');
 assert.equal(advanced.sourceEvidence.checkedThrough,'2026-11-01');
 assert.equal(advanced.rowCount,3);
 validateSnapshotProjection(advanced);
});
