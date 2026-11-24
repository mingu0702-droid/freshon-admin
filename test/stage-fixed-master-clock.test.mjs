import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createHash,createHmac} from 'node:crypto';
import {OPSMAP_SCHEDULED_ROUTE,OPSMAP_WMS_NIGHT_SCHEDULED_ROUTE,verifyOpsmapScheduleReceipt} from '../src/opsmapScheduledRun.js';
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
const nightUrl = STAGE_ORIGIN + OPSMAP_WMS_NIGHT_SCHEDULED_ROUTE;
const profile='STAGE_HOURLY_WMS_V1';
const clockTrigger = (handlerName=handler,id=triggerId,source='CLOCK') => ({
  getHandlerFunction: () => handlerName,
  getUniqueId: () => id,
  getTriggerSource: () => source
});
const signedBytes = buffer => Array.from(buffer,byte => byte > 127 ? byte - 256 : byte);

function simulate({
  configured={enabled:true,triggerId,executorHash},key=secret,
  triggers=[clockTrigger()],event={triggerUid:triggerId},
  effectiveAccount=owner,time=tick,httpStatus=202,failFetch=false,properties=new Map(),lockAvailable=true
}={}) {
  const calls=[], logs=[];
  class ClockDate extends Date {
    constructor() { super(time); }
  }
  const context = vm.createContext({
    Date: ClockDate,
    PropertiesService: {
      getScriptProperties: () => ({
        setProperty:(name,value)=>properties.set(name,value),
        getProperty: name => (properties.get(name) ?? ({
          OPSMAP_STAGE_SYNC_DISPATCH_V1: configured && JSON.stringify(configured),
          OPSMAP_STAGE_SYNC_SCHEDULER_SECRET: key
        })[name])
      })
    },
    LockService:{getScriptLock:()=>({tryLock:()=>lockAvailable,releaseLock(){}})},
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
  return {calls,logs,status:context.opsmapStageClockStatus};
}

test('one Stage-only CLOCK sends the receipt accepted by the existing verifier', () => {
  const {calls,logs}=simulate({effectiveAccount:'  STAGE-fixture@EXAMPLE.invalid  '});
  assert.equal(calls.length,1);
  const [{target,options}]=calls;
  assert.equal(target,url);
  assert.deepEqual(manifest.urlFetchWhitelist,[url,nightUrl]);
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

test('experimental hourly Stage clock sends only 06 daily and 20/21 purpose-bound WMS signals',()=>{
  const configured={enabled:true,triggerId,executorHash,profile};
  const timeAt=hours=>Date.parse('2026-11-24T'+hours+'+09:00');
  for(const inactive of ['05:59:59','07:00:00','14:30:00','19:59:59','22:00:00']){
    assert.equal(simulate({configured,time:timeAt(inactive)}).calls.length,0);
  }
  for(const [at,target,purpose] of [['06:34:00',url,false],['20:33:00',nightUrl,true],['21:35:00',nightUrl,true]]){
    const time=timeAt(at);
    const {calls}=simulate({configured,time});
    assert.equal(calls.length,1);
    const [{target:actual,options}]=calls;
    assert.equal(actual,target);
    const receipt=JSON.parse(options.payload);
    const opts={secret,scheduleId:triggerId,executorHash,now:()=>time,night:purpose};
    assert.equal(verifyOpsmapScheduleReceipt(receipt,opts).runId,receipt.runId);
    assert.throws(()=>verifyOpsmapScheduleReceipt(receipt,{...opts,night:!purpose}),/OPSMAP_SCHEDULE_RECEIPT/);
  }
});

test('script lock and accepted hour/purpose marker avoid repeated signed calls',()=>{
  const configured={enabled:true,triggerId,executorHash,profile};
  const cache=new Map();
  const time=Date.parse('2026-11-24T20:20:00+09:00');
  const opts={configured,time,properties:cache};
  assert.equal(simulate({...opts,lockAvailable:false}).calls.length,0);
  const failed=simulate({...opts,httpStatus:503});
  const accepted=simulate({...opts,time:time+60_000});
  assert.equal(failed.calls.length,1);
  assert.equal(accepted.calls.length,1);
  assert.equal(failed.logs[0].runId,accepted.logs[0].runId);
  assert.equal(simulate({...opts,time:time+120_000}).calls.length,0);
  assert.equal(simulate({...opts,time:time+3600_000}).calls.length,1,'next hour can wake the same server checkpoint');
  assert.equal(simulate({...opts,time:time+3600_000+60000}).calls.length,0);
});

test('status reads a single Stage CLOCK identity without exposing executor or credentials',()=>{
  const configured={enabled:false,triggerId,executorHash,profile};
  const {status,calls}=simulate({configured});
  const data=JSON.parse(JSON.stringify(status()));
  assert.deepEqual(data,{enabled:false,profile,triggerCount:1,clockTriggerId:triggerId,
    triggerMatched:true,executorMatched:true,secretConfigured:true});
  assert.equal(calls.length,0);
  assert(!JSON.stringify(data).includes(executorHash));
  assert(!JSON.stringify(data).includes(secret));
});
