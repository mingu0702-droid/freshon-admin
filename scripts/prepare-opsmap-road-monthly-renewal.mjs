import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const kstDay = timestamp => new Date(timestamp + 9 * 3600000).toISOString().slice(0, 10);
const monthKey = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const sha40 = /^[a-f0-9]{40}$/;
const sha64 = /^[a-f0-9]{64}$/;
const approvalId = /^[-A-Za-z0-9_]{8,100}$/;
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const fail = code => { throw Object.assign(Error(code), {code}); };

function quotaRemaining(quota, maximum) {
  if (!isCount(quota?.limit) || quota.limit < 1 || quota.limit > maximum ||
      !isCount(quota.used) || quota.used > quota.limit) fail('ROAD_RENEWAL_QUOTA_INVALID');
  return quota.limit - quota.used;
}

export function prepareRoadMonthlyRenewal({previousBytes, previousSha, evidence, now = Date.now()} = {}) {
  if (!Buffer.isBuffer(previousBytes) || !previousBytes.length || previousBytes.length > 32768 ||
      !sha40.test(previousSha || '') ||
      createHash('sha1').update('blob '+previousBytes.length+'\0').update(previousBytes).digest('hex') !== previousSha)
    fail('ROAD_RENEWAL_BASELINE_SHA');
  let previous;
  try { previous = JSON.parse(previousBytes.toString('utf8')); }
  catch { fail('ROAD_RENEWAL_BASELINE_INVALID'); }
  const b = previous?.roadBudget;
  const lastPeriod = b?.monthlyApproval?.period;
  if (previous?.schema !== 1 || b?.scope !== 'CUMULATIVE_APPROVED_ACCOUNT' ||
      b.policy !== 'FREE_ONLY' || b.providerPaidDisabled !== true || b.servicePermissionVerified !== true ||
      b.monthlyApproval?.providerRejectsFreeOverage !== true || !monthKey.test(lastPeriod || '') ||
      !sha64.test(b.accountHash || '') || !approvalId.test(b.approvalId || '') ||
      b.approvedApis?.length !== 1 || b.approvedApis[0] !== 'directions' ||
      !isCount(b.apis?.directions?.used) || !isCount(b.apis?.waypoints?.used) ||
      !isCount(b.limit) || b.limit > 30000 || !isCount(b.used) || b.used > b.limit ||
      b.apis.directions.used + b.apis.waypoints.used !== b.used)
    fail('ROAD_RENEWAL_BASELINE_INVALID');
  const observed = Date.parse(evidence?.observedAt);
  const expires = Date.parse(b.expiresAt);
  if (!Number.isFinite(observed) || observed > now || !Number.isFinite(expires) ||
      expires > now || kstDay(expires - 1).slice(0, 7) !== lastPeriod || kstDay(observed) !== kstDay(now))
    fail('ROAD_RENEWAL_EVIDENCE_WINDOW');
  const period = kstDay(now).slice(0, 7);
  if (lastPeriod >= period || evidence.period !== period || evidence.source !== 'KAKAO_DEVELOPERS_CONSOLE' ||
      evidence.accountHash !== b.accountHash || evidence.servicePermissionVerified !== true ||
      evidence.providerPaidDisabled !== true || evidence.providerRejectsFreeOverage !== true)
    fail('ROAD_RENEWAL_EVIDENCE_INVALID');
  const monthlyRemaining = quotaRemaining(evidence.monthlyQuota, 3000000);
  const dailyRemaining = quotaRemaining(evidence.directionsDailyQuota, 10000);
  const limit = Math.min(b.limit, monthlyRemaining);
  // The runtime counts lifetime debits against both ceilings. Preserve that
  // conservative contract and never inflate the provider's observed balance.
  if (limit <= b.used) fail('ROAD_RENEWAL_NO_ALLOWANCE');
  const [year, month] = period.split('-').map(Number);
  const expiresAt = new Date(Date.UTC(year, month, 1) - 9 * 3600000).toISOString();
  const usedBeforeWindow = {directions: b.apis.directions.used, waypoints: b.apis.waypoints.used};
  return {
    previousSha, previousPeriod: lastPeriod, period, expiresAt, carryForwardUsed: b.used,
    cumulativeAllowance: limit, directionsFreeRemainingAtApproval: dailyRemaining,
    nextLedger: {schema: 1, roadBudget: {
      accountHash: b.accountHash, scope: b.scope, policy: b.policy,
      providerPaidDisabled: true, servicePermissionVerified: true, approvalId: b.approvalId,
      verifiedAt: new Date(observed).toISOString(), expiresAt, limit, used: b.used,
      monthlyFreeRemainingAtApproval: monthlyRemaining, approvedApis: ['directions'],
      providerDailyUsedAtApproval: {directions: evidence.directionsDailyQuota.used},
      apis: {
        directions: {freeRemainingAtApproval: dailyRemaining, used: usedBeforeWindow.directions},
        waypoints: {freeRemainingAtApproval: 0, used: usedBeforeWindow.waypoints},
      },
      monthlyApproval: {period, providerRejectsFreeOverage: true, usedBeforeWindow, dailyUsage: {}},
      ...(typeof b.lastReservation === 'string' ? {lastReservation: b.lastReservation} : {}),
      ...(typeof b.updatedAt === 'string' ? {updatedAt: b.updatedAt} : {}),
    }},
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const [previousFile, previousSha, evidenceFile, output, ...rest] = process.argv.slice(2);
    if (!previousFile || !previousSha || !evidenceFile || !output || rest.length)
      fail('ROAD_RENEWAL_USAGE');
    const previousBytes = await readFile(previousFile);
    let evidence;
    try {
      const bytes = await readFile(evidenceFile);
      if (bytes.length > 16384) fail('ROAD_RENEWAL_EVIDENCE_INVALID');
      evidence = JSON.parse(bytes.toString('utf8'));
    } catch { fail('ROAD_RENEWAL_EVIDENCE_INVALID'); }
    const plan = prepareRoadMonthlyRenewal({previousBytes, previousSha, evidence});
    await writeFile(output, JSON.stringify(plan) + '\n', {flag: 'wx', mode: 0o600});
    const {nextLedger, ...summary} = plan;
    console.log(JSON.stringify(summary));
  } catch (error) {
    console.error(/^ROAD_RENEWAL_[A-Z_]+$/.test(error?.code || '') ? error.code : 'ROAD_RENEWAL_LOCAL_IO');
    process.exitCode = 1;
  }
}
