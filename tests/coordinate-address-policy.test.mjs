import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import path from'node:path';
import{coordinateDigest,buildingRecoveryProof,applyVerifiedCoordinateOverlay}from'../public/verified-coordinate-overlay.mjs';
const dir=process.env.OPSMAP_COORDINATE_POLICY_INPUT;
test('pinned real additions validate while existing2016 stay immutable',{skip:!dir},async()=>{
 const r=JSON.parse(fs.readFileSync(path.join(dir,'RECOVERY.addressless.json'))),projection=JSON.parse(fs.readFileSync(path.join(dir,'PROJECTION.addressless.json')));
 assert.equal(r.rows.length,152);assert.equal(r.rows.filter(p=>p.receipt.provider?.receipt.administrativeMatch).length,9);
 assert.equal(projection.data.filter(p=>Number.isFinite(p[3])).length,2027);assert.equal(new Set(projection.data.map(p=>p[0])).size,2036);
});
test('forged official relationship is rejected despite recomputed hashes',{skip:!dir},async()=>{
 const r=JSON.parse(fs.readFileSync(path.join(dir,'RECOVERY.addressless.json'))),p=structuredClone(r.rows.find(p=>p.receipt.provider?.receipt.administrativeMatch));
 const receipt=p.receipt.provider;receipt.receipt.administrativeMatch.sourceUrl='https://invalid.example/';receipt.receiptHash=await coordinateDigest(receipt.receipt);p.evidenceHash=await coordinateDigest(buildingRecoveryProof(p));
 const row=[p.customerCode,'synthetic identity','',null,null,'','',null,null,[]];p.customerNameHash=await coordinateDigest(row[1]);
 const base={date:r.base.date,sourceVersion:r.base.sourceVersion,sourceCandidateHash:r.base.sourceCandidateHash,dataHash:await coordinateDigest([row]),rowCount:1,existingCoordinateCount:0};p.receipt.collisionCheckedAgainst=base.dataHash;p.evidenceHash=await coordinateDigest(buildingRecoveryProof(p));
 const content={schema:r.schema,base,verification:r.verification,rows:[p]},overlay={...content,hash:await coordinateDigest(content)};
 await assert.rejects(applyVerifiedCoordinateOverlay({data:[row],meta:base},overlay,{expectedOverlayHash:overlay.hash,expectedSourceVersion:'40603'}),/COORDINATE_RECOVERY_PROVIDER/);
});
