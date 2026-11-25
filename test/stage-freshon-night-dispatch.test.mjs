import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import {createStageFreshonNightDispatchReader} from '../src/stageFreshonNightDispatch.js';

const date='2026-11-25';
const previous='2026-11-24';
const fixedTime=Date.parse('2026-11-25T21:15:00.000Z');
const digest=value=>createHash('sha256').update(value).digest('hex');
const row=({day=date,center='011',customer='S1',vehicle='101',amount=11,total=1}={})=>({
  stockDate:day,logCd:center,isSum:false,estCd:customer,confirmCarSeq:vehicle,carSeq:'999',
  totalCnt:total,maechul:amount,baesongCnt:1
});
const subtotal=(amount,count=1)=>({stockDate:'',estCd:'',isSum:false,confirmCarSeq:'소계',
  totalCnt:0,maechul:amount,baesongCnt:count});
const response=records=>Response.json({status:200,data:records});
const create=fetchImpl=>createStageFreshonNightDispatchReader({
  login:async()=>({cookie:'fixture=1'}),fetchImpl,now:()=>fixedTime
});

test('all centers reuse one login and request only the exact official night scope',async()=>{
  let loginCount=0, active=0, peak=0;
  const query=[];
  const read=createStageFreshonNightDispatchReader({
    login:async({signal})=>{
      assert.equal(signal.aborted,false);
      loginCount++;
      return {cookie:'fixture=1'};
    },
    fetchImpl:async(url,options)=>{
      assert.equal(url,'https://mis.freshon.co.kr/bo/wm/dispatch/baecha_list');
      assert.equal(options.method,'POST');
      assert.equal(options.redirect,'error');
      assert.equal(options.headers.Cookie,'fixture=1');
      const form=new URLSearchParams(options.body);
      for (const [key,value] of Object.entries({
        calStartDate:date,calEndDate:date,baecha:'2',shipGbn:'1',size:'3000',page:'0',isPaging:'true',
        isCount:'true',sort:'stock_date,ASC',excelFileNm:'baecha_list'
      })) assert.equal(form.get(key),value);
      const center=form.get('logCd');
      query.push(center);
      peak=Math.max(peak,++active);
      await new Promise(resolve=>setImmediate(resolve));
      active--;
      return response([row({center}),subtotal(11)]);
    },
    now:()=>fixedTime
  });
  const results=await Promise.all(['osan','yeongnam','honam'].map(center=>read(date,center)));
  assert.deepEqual(query,['011','012','013']);
  assert.equal(loginCount,1);
  assert.equal(peak,1);
  assert.equal(results[0].detail,1);
  assert.deepEqual(results[0],{
    state:'VERIFIED',date,centerKey:'osan',observedAt:new Date(fixedTime).toISOString(),
    sourceSha256:digest(JSON.stringify({status:200,data:[row(),subtotal(11)]})),
    rows:[{customerCode:'S1',vehicles:['101']}]
  });
});

test('repeated source detail is counted and the projection deduplicates code and assigned routes',async()=>{
  const duplicate=row({total:4});
  const records=[duplicate,{...duplicate},subtotal(22,2),row({vehicle:'208호차',total:4}),subtotal(11),
    row({customer:'S2',vehicle:'',total:4}),subtotal(11)];
  const result=await create(async()=>response(records))(date,'osan');
  assert.equal(result.detail,4);
  assert.deepEqual(result.rows,[
    {customerCode:'S1',vehicles:['101','208']},
    {customerCode:'S2',vehicles:['미배정']}
  ]);
});

test('exact blank only verifies when the two-day range agrees with known neighbor detail',async()=>{
  const calls=[];
  const supported={date:previous,centerKey:'osan',detail:2};
  const dayRow=row({day:previous,total:2});
  const read=create(async(_url,options)=>{
    const form=new URLSearchParams(options.body);
    const start=form.get('calStartDate'),end=form.get('calEndDate');
    calls.push([start,end]);
    return start===end?response([]):response([dayRow,{...dayRow},subtotal(22,2)]);
  });
  assert.equal(await read(date,'osan'),null);
  const result=await read(date,'osan',{neighbor:supported});
  assert.deepEqual(calls,[[date,date],[date,date],[previous,date]]);
  assert.equal(result.state,'ZERO_VERIFIED');
  assert.equal(result.detail,0);
  assert.deepEqual(result.rows,[]);
  assert.match(result.sourceSha256,/^[a-f0-9]{64}$/);

  assert.equal(await read(date,'osan',{neighbor:{...supported,detail:3}}),null);
  const mixed=create(async(_url,options)=>{
    const form=new URLSearchParams(options.body);
    return form.get('calStartDate')===date?response([]):
      response([dayRow,row({total:2}),subtotal(22,2)]);
  });
  assert.equal(await mixed(date,'osan',{neighbor:supported}),null);
});

test('invalid neighbor scope leaves a blank unverified without another call',async()=>{
  let calls=0;
  const read=create(async()=>{calls++;return response([]);});
  assert.equal(await read(date,'osan',{neighbor:{date:previous,centerKey:'honam',detail:1}}),null);
  assert.equal(await read(date,'osan',{neighbor:{date:'2026-11-23',centerKey:'osan',detail:1}}),null);
  assert.equal(await read(date,'osan',{neighbor:{date:previous,centerKey:'osan',rows:[1]}}),null);
  assert.equal(calls,3);
});

test('truncated, mis-scoped and inconsistent provider results fail closed',async()=>{
  for (const [records,code] of [
    [Array(3000).fill(null),'PAGE'],
    [[row({total:2}),subtotal(11)],'COUNT'],
    [[row(),subtotal(12)],'SUBTOTAL'],
    [[row(),subtotal(11,2)],'SUBTOTAL'],
    [[row({center:'012'}),subtotal(11)],'SCOPE'],
    [[row({day:previous}),subtotal(11)],'SCOPE'],
    [[row(),subtotal(11),row(),subtotal(11)],'DETAIL']
  ]) {
    await assert.rejects(create(async()=>response(records))(date,'osan'),{code:'FRESHON_NIGHT_DISPATCH_'+code});
  }
  const mismatch=create(async()=>Response.json({data:[row(),subtotal(11)],totalCount:2}));
  await assert.rejects(mismatch(date,'osan'),{code:'FRESHON_NIGHT_DISPATCH_COUNT'});
  const contradict=create(async()=>Response.json({data:[],totalCnt:1200}));
  await assert.rejects(contradict(date,'osan'),{code:'FRESHON_NIGHT_DISPATCH_COUNT'});
  const providerFailure=create(async()=>Response.json({data:[],status:503}));
  await assert.rejects(providerFailure(date,'osan'),{code:'FRESHON_NIGHT_DISPATCH_PAGE'});
});

test('HTTP, response size, session and network failures publish only safe reason codes',async()=>{
  for (const [reply,code] of [
    [()=>new Response('private auth failure',{status:403}),'AUTH'],
    [()=>new Response('<html>signed out</html>',{headers:{'content-type':'text/html'}}),'RESPONSE'],
    [()=>new Response('{}',{headers:{'content-type':'application/json','content-length':String(9*1024*1024)}}),'RESPONSE_SIZE'],
    [()=>new Response(';',{headers:{'content-type':'application/json'}}),'RESPONSE'],
    [()=>{throw Error('private network failure');},'TRANSPORT']
  ]) {
    await assert.rejects(create(reply)(date,'osan'),error=>{
      assert.equal(error.message,'FRESHON_NIGHT_DISPATCH_'+code);
      assert.equal(error.cause,undefined);
      return true;
    });
  }
  let calls=0;
  const read=createStageFreshonNightDispatchReader({
    login:async()=>{throw Error('private credentials');},fetchImpl:async()=>{calls++;return response([]);}
  });
  await assert.rejects(read(date,'osan'),{code:'FRESHON_NIGHT_DISPATCH_AUTH'});
  await assert.rejects(read(date,'yeongnam'),{code:'FRESHON_NIGHT_DISPATCH_AUTH'});
  assert.equal(calls,0);
});

test('batch deadline and finite request budget prevent follow-up source calls',async()=>{
  let calls=0;
  const blocked=createStageFreshonNightDispatchReader({
    deadlineMs:12,login:async()=>({cookie:'fixture=1'}),
    fetchImpl:async()=>{calls++;return new Promise(()=>{});}
  });
  // AbortSignal.timeout uses an unref'ed timer.
  const keepAlive=setTimeout(()=>{},100);
  try {
    await assert.rejects(blocked(date,'osan'),{code:'FRESHON_NIGHT_DISPATCH_TIMEOUT'});
    await assert.rejects(blocked(date,'yeongnam'),{code:'FRESHON_NIGHT_DISPATCH_TIMEOUT'});
    assert.equal(calls,1);
  } finally {clearTimeout(keepAlive);}
  const capped=create(async()=>response([]));
  for (let index=0;index<6;index++) assert.equal(await capped(date,'osan'),null);
  await assert.rejects(capped(date,'osan'),{code:'FRESHON_NIGHT_DISPATCH_REQUEST_BUDGET'});
});
