import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createHash,createHmac} from 'node:crypto';
import {OPSMAP_SCHEDULED_ROUTE,verifyOpsmapScheduleReceipt} from '../src/opsmapScheduledRun.js';
import {STAGE_ORIGIN} from '../src/stageScope.js';

const directory = new URL('../integrations/stage-fixed-master-clock/', import.meta.url);
const source = readFileSync(new URL('StageFixedMasterClock.js', directory), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('appsscript.json', directory), 'utf8'));
const handler = 'opsmapStageFixedMasterClockTick';
const triggerId = '4034124084959907503';
const owner = 'stage-fixture@example.invalid';
const executorHash = createHash('sha256').update(owner).digest('hex');
const secret = 'stage-fixture-secret-never-used-outside-test';
const tick = Date.parse('2026-11-13T15:02:00.000Z');
const url = STAGE_ORIGIN + OPSMAP_SCHEDULED_ROUTE;
const clockTrigger = (handlerName=handler,id=triggerId,source='CLOCK') => ({
  getHandlerFunction: () => handlerName,
  getUniqueId: () => id,
  getTriggerSource: () => source
});
const signedBytes = buffer => Array.from(buffer,byte => byte > 127 ? byte - 256 : byte);

function simulate({
  configured={enabled:true,triggerId,executorHash},key=secret,
  triggers=[clockTrigger()],event={triggerUid:triggerId},
  effectiveAccount=owner,time=tick,httpStatus=202,failFetch=false
}={}) {
  const calls=[], logs=[];
  class ClockDate extends Date {
    constructor() { super(time); }
  }
  const context = vm.createContext({
    Date: ClockDate,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: name => ({
          OPSMAP_STAGE_SYNC_DISPATCH_V1: configured && JSON.stringify(configured),
          OPSMAP_STAGE_SYNC_SCHEDULER_SECRET: key
        })[name]
      })
    },
    ScriptApp: {TriggerSource:{CLOCK:'CLOCK'},getProjectTriggers:() => triggers},
    Session: {getEffectiveUser:() => ({getEmail:() => effectiveAccount})},
    Utilities: {
      DigestAlgorithm:{SHA_256:'SHA_256'}, Charset:{UTF_8:'UTF_8'},
      computeDigest: (algorithm,value) => {
        assert.equal(algorithm,'SHA_256');
        return signedBytes(createHash('sha256').update(value).digest());
      },
      computeHmacSha256Signature: (value,hmac) => signedBytes(createHmac('sha256',hmac).update(value).digest()),
      formatDate: (date,zone,pattern) => {
        assert.equal(pattern,'yyyy-MM-dd');
        return new Intl.DateTimeFormat('sv-SE',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
      }
    },
    UrlFetchApp: {fetch: (target,options) => {
      calls.push({target,options});
      if (failFetch) throw Error(secret);
      return {getResponseCode:() => httpStatus};
    }},
    console: {log: value => logs.push(JSON.parse(value))}
  });
  vm.runInContext(source,context);
  context[handler](event);
  return {calls,logs};
}

test('one Stage-only CLOCK sends the receipt accepted by the existing verifier', () => {
  const {calls,logs}=simulate({effectiveAccount:'  STAGE-fixture@EXAMPLE.invalid  '});
  assert.equal(calls.length,1);
  const [{target,options}]=calls;
  assert.equal(target,url);
  assert.deepEqual(manifest.urlFetchWhitelist,[url]);
  assert.equal(options.method,'post');
  assert.equal(options.followRedirects,false);
  const receipt=JSON.parse(options.payload);
  assert.equal(receipt.date,'2026-11-14');
  const verified=verifyOpsmapScheduleReceipt(receipt,{secret,scheduleId:triggerId,executorHash,now:() => tick});
  assert.equal(verified.runId,logs[0].runId);
  assert.equal(logs[0].status,202);

  const sameSlot=JSON.parse(simulate({time:tick+60_000}).calls[0].options.payload);
  assert.equal(sameSlot.runId,receipt.runId);
  assert.notEqual(sameSlot.signature,receipt.signature);
  assert.throws(() => verifyOpsmapScheduleReceipt({...receipt,date:'2026-11-13'},{
    secret,scheduleId:triggerId,executorHash,now:() => tick
  }),/OPSMAP_SCHEDULE_RECEIPT/);
});

test('missing approval, manual invocation, duplicate triggers, Hub CLOCK and another executor cannot send', () => {
  const cases=[
    {configured:null},
    {configured:{enabled:false,triggerId,executorHash}},
    {event:null},
    {key:null},
    {event:{triggerUid:'999'}},
    {triggers:[clockTrigger(),clockTrigger(handler,'999')]},
    {triggers:[clockTrigger('hubProductionMapAutoTick')]},
    {triggers:[clockTrigger(handler,triggerId,'SPREADSHEETS')]},
    {effectiveAccount:'another@example.invalid'}
  ];
  for (const options of cases) assert.equal(simulate(options).calls.length,0);
});

test('a failed send is logged once without returning a key, principal or payload', () => {
  const {calls,logs}=simulate({failFetch:true});
  assert.equal(calls.length,1);
  assert.equal(logs[0].error,'OPSMAP_SCHEDULE_DISPATCH_FAILED');
  assert.ok(!JSON.stringify(logs).includes(secret));
  assert.ok(!JSON.stringify(logs).includes(executorHash));
  const rejected=simulate({httpStatus:403});
  assert.equal(rejected.calls.length,1);
  assert.equal(rejected.logs[0].status,403);
  assert.ok(!('signature' in rejected.logs[0]));
});
