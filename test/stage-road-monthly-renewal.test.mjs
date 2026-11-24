import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {prepareRoadMonthlyRenewal} from '../scripts/prepare-opsmap-road-monthly-renewal.mjs';
import {createStageSharedRoadFreeOnly} from '../src/opsmap-abc/productionRoadBudget.js';

const key = 'synthetic-approved-route-account';
const accountHash = createHash('sha256').update(key).digest('hex');
const approvalId = 'synthetic-standing-approval';
const now = Date.parse('2026-12-01T00:15:00+09:00');
const old = () => ({schema:1,roadBudget:{
  accountHash, scope:'CUMULATIVE_APPROVED_ACCOUNT', policy:'FREE_ONLY', providerPaidDisabled:true,
  servicePermissionVerified:true, approvalId, expiresAt:'2026-11-30T15:00:00Z', limit:30_000, used:16,
  apis:{directions:{used:14},waypoints:{used:2}}, approvedApis:['directions'],
  monthlyApproval:{period:'2026-11',providerRejectsFreeOverage:true},
}});
const proof = () => ({
  source:'KAKAO_DEVELOPERS_CONSOLE', period:'2026-12', accountHash, observedAt:'2026-12-01T00:14:00+09:00',
  servicePermissionVerified:true, providerPaidDisabled:true, providerRejectsFreeOverage:true,
  monthlyQuota:{limit:3_000_000,used:10}, directionsDailyQuota:{limit:10_000,used:1},
});
const snapshot = value => {
  const previousBytes = Buffer.from(JSON.stringify(value));
  const previousSha = createHash('sha1').update('blob '+previousBytes.length+'\0').update(previousBytes).digest('hex');
  return {previousBytes, previousSha};
};

test('December preserves account scope, lifetime debits and the Stage grant under a new verified month', async () => {
  const stored = old();
  const original = snapshot(stored);
  const next = prepareRoadMonthlyRenewal({...original,evidence:proof(),now});
  assert.equal(next.previousSha,original.previousSha);
  assert.equal(next.carryForwardUsed,16);
  assert.equal(next.directionsFreeRemainingAtApproval,9999);
  assert.equal(next.expiresAt,'2026-12-31T15:00:00.000Z');
  const receipt = next.nextLedger.roadBudget;
  assert.deepEqual(receipt.monthlyApproval.usedBeforeWindow,{directions:14,waypoints:2});
  assert.deepEqual(receipt.monthlyApproval.dailyUsage,{});
  assert.equal(receipt.approvalId,approvalId);
  assert.equal(receipt.apis.waypoints.freeRemainingAtApproval,0);

  const budget = createStageSharedRoadFreeOnly({
    key,token:'synthetic-read-token',grant:JSON.stringify({approvalId,dailyLimit:2}),now:()=>now,
    async fetchImpl(url,options) {
      assert.equal(options.method,undefined);
      return url.includes('/contents/') ?
        Response.json({encoding:'base64',sha:'b'.repeat(40),content:Buffer.from(JSON.stringify(next.nextLedger)).toString('base64')}) :
        Response.json({private:true,permissions:{push:true}});
    },
  });
  assert.deepEqual((await budget.status()).apiRemaining,{directions:1,waypoints:0});
  assert.equal(stored.roadBudget.monthlyApproval.period,'2026-11');
});

test('future, stale, unsigned-account or paid evidence cannot prepare a renewal', () => {
  const base = snapshot(old());
  for (const [fields, code] of [
    [{observedAt:'2026-11-30T23:30:00+09:00'}, 'ROAD_RENEWAL_EVIDENCE_WINDOW'],
    [{observedAt:'2026-12-01T00:16:00+09:00'}, 'ROAD_RENEWAL_EVIDENCE_WINDOW'],
    [{period:'2027-01'}, 'ROAD_RENEWAL_EVIDENCE_INVALID'],
    [{accountHash:'b'.repeat(64)}, 'ROAD_RENEWAL_EVIDENCE_INVALID'],
    [{providerPaidDisabled:false}, 'ROAD_RENEWAL_EVIDENCE_INVALID'],
    [{providerRejectsFreeOverage:false}, 'ROAD_RENEWAL_EVIDENCE_INVALID'],
    [{monthlyQuota:{limit:20,used:4}}, 'ROAD_RENEWAL_NO_ALLOWANCE'],
    [{directionsDailyQuota:{limit:10_001,used:0}}, 'ROAD_RENEWAL_QUOTA_INVALID'],
  ]) assert.throws(() => prepareRoadMonthlyRenewal({...base,evidence:{...proof(),...fields},now}),{code});
  assert.throws(() => prepareRoadMonthlyRenewal({...base,previousSha:'1'.repeat(40),evidence:proof(),now}),
    {code:'ROAD_RENEWAL_BASELINE_SHA'});
});
