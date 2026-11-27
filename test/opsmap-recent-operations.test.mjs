import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import express from 'express';
import {STAGE_ORIGIN,STAGE_SERVICE} from '../src/stageScope.js';
import {createStageRecentOrdersReader} from '../src/stageRecentOrders.js';
import {
  createRecentOperationsReader,createStageRecentOperationsStore,mergeRecentOperations,mountRecentOperations,normalizeRecentOperations,openRecentOperations,
  projectRecentOperations,RECENT_OPERATIONS_ROUTE,recentOperationsKey,recoverArchivedOsanDispatch,recoverSealedRecentOrders,
  sealRecentOperations,syncStageRecentOperations
} from '../src/stageRecentOperations.js';

const initialStart='2026-08-20', initialEnd='2026-11-17';
const makeDay=(date,source,coverage,codes=[],centerKey='osan')=>({date,source,centerKey,coverage,
  rows:codes.map(customerCode=>({customerCode,evidence:{
    freshon_orders:'order_confirmed',wms_dispatch:'dispatch_confirmed',delivery_admin:'delivery_completed'
  }[source]}))});
const ledger=(...days)=>normalizeRecentOperations({startDate:initialStart,endDate:initialEnd,days});
const makeNightOrderDay=(date,centerKey,codes)=>({date,centerKey,source:'freshon_orders',coverage:'partial',
  rows:codes.map(customerCode=>({customerCode,evidence:'order_confirmed',nightOrder:true}))});

test('sealed order recovery adds only exact partial orders and verifies the CAS readback',async()=>{
  const date='2026-11-19', sha='b'.repeat(40), latest='2026-11-23';
  const existing=makeDay(date,'delivery_admin','partial',['A1']);
  const before=mergeRecentOperations(ledger(),latest,[existing]);
  let ledgerValue=before, writes=0;
  const orders=['osan','yeongnam','honam'].map((center,index)=>
    makeDay(date,'freshon_orders','partial',['A'+(index+1)],center));
  const key=recentOperationsKey(Buffer.alloc(32,6).toString('base64'));
  const bytes=Buffer.from(JSON.stringify(await sealRecentOperations(mergeRecentOperations(ledger(),date,orders),key)));
  const store={async read(){return {ledger:ledgerValue,sha};},async write(next,expected){
    assert.equal(expected,sha);ledgerValue=next;writes++;
  }};
  const options={date,approvedDate:date,approvedSha256:createHash('sha256').update(bytes).digest('hex'),
    key,store,readArchive:async()=>bytes,now:()=>Date.parse('2026-11-24T14:00Z')};
  assert.equal((await recoverSealedRecentOrders(options)).state,'VERIFIED_PREVIEW');
  assert.equal(writes,0);
  await assert.rejects(recoverSealedRecentOrders({...options,approvedSha256:'f'.repeat(64)}),/EVIDENCE_INVALID/);
  assert.equal((await recoverSealedRecentOrders({...options,publish:true})).state,'PUBLISHED');
  assert.equal(ledgerValue.endDate,latest);
  assert.deepEqual(ledgerValue.days.find(day=>day.source==='delivery_admin'),existing);
  assert.equal((await recoverSealedRecentOrders({...options,publish:true})).state,'VERIFIED_NOOP');
  assert.equal(writes,1);
});

test('an explicitly approved one-center archive previews only its verified night orders',async()=>{
  const date='2026-11-20', sha='a'.repeat(40);
  const key=recentOperationsKey(Buffer.alloc(32,6).toString('base64'));
  const before=mergeRecentOperations(ledger(),'2026-11-23',[makeDay(date,'delivery_admin','partial',['A1'])]);
  const bytes=Buffer.from(JSON.stringify(await sealRecentOperations(mergeRecentOperations(ledger(),date,
    [makeNightOrderDay(date,'yeongnam',['A2'])]),key)));
  const request={date,approvedDate:date,approvedCenter:'yeongnam',approvedSha256:createHash('sha256').update(bytes).digest('hex'),
    key,store:{read:async()=>({ledger:before,sha})},readArchive:async()=>bytes,now:()=>Date.parse('2026-11-24T14:00Z')};
  const result=await recoverSealedRecentOrders(request);
  assert.equal(result.state,'VERIFIED_PREVIEW');
  assert.deepEqual(result.after,{osan:{delivery_admin:1},yeongnam:{freshon_orders:1},honam:{}});
  await assert.rejects(recoverSealedRecentOrders({...request,approvedCenter:'honam'}),/EVIDENCE_INVALID/);
  await assert.rejects(recoverSealedRecentOrders({...request,approvedCenter:undefined}),/EVIDENCE_INVALID/);
});

test('archived recovery changes only one exact Osan dispatch day with CAS and keeps evidence partial',async()=>{
  const date='2026-11-23', sha='a'.repeat(40), now=()=>Date.parse('2026-11-24T00:00:00Z');
  const existing=makeDay('2026-11-22','delivery_admin','partial',['B2'],'honam');
  let current=mergeRecentOperations(ledger(),existing.date,[existing]);
  const archive={date,center:'osan',source:'WMS_CONFIRMED_DISPATCH_EXPORT',vehicles:[
    {vehicle:'101',details:[{customerCode:'A1',amount:123}]},
    {vehicle:'102',details:[{customerCode:'A1'},{customerCode:'A2'}]},
    {vehicle:'미배정',details:[{customerCode:'A3'}]}
  ]};
  const store={async read(){return {ledger:current,sha};},async write(next,expected){assert.equal(expected,sha);current=next;}};
  const request={store,date,approvedDate:date,now,readArchive:async selected=>{assert.equal(selected,date);return archive;}};
  await assert.rejects(recoverArchivedOsanDispatch({...request,approvedDate:existing.date}),/RECOVERY_SCOPE/);
  await assert.rejects(recoverArchivedOsanDispatch({...request,now:()=>Date.parse('2026-11-23T14:59:59Z'),
    store:{async read(){assert.fail('Do not read a current pointer before Seoul day closes');}},
    readArchive:async()=>assert.fail('Do not read the archive before Seoul day closes')}),/RECOVERY_SCOPE/);
  await assert.rejects(recoverArchivedOsanDispatch({...request,readArchive:async()=>({...archive,center:'yeongnam'})}),/EVIDENCE_INVALID/);
  assert.equal((await recoverArchivedOsanDispatch(request)).state,'VERIFIED_PREVIEW');
  assert.deepEqual(current.days,[existing]);
  const publish={...request,publish:true};
  assert.deepEqual(await recoverArchivedOsanDispatch(publish),{
    state:'PUBLISHED',date,centerKey:'osan',source:'wms_dispatch',assignmentCount:3,customerCount:2,endDate:date
  });
  assert.deepEqual(current.days,[existing,makeDay(date,'wms_dispatch','partial',['A1','A2'])]);
  assert.equal((await recoverArchivedOsanDispatch(publish)).state,'VERIFIED_NOOP');
  for (const days of [7,30,60,90]) {
    const report=projectRecentOperations(current,{days,summaryOnly:true});
    assert.deepEqual(report.centers.osan.calendar.at(-1),{
      date,state:'PARTIAL',sources:{wms_dispatch:{coverage:'partial',customerCount:2,evidence:['dispatch_confirmed']}}
    });
    assert.equal(report.centers.yeongnam.calendar.at(-1).state,'NOT_OBSERVED');
    assert.deepEqual(report.centers.osan.confirmedDays,[]);
  }
  current=ledger();
  assert.equal((await recoverArchivedOsanDispatch({...publish,store:{...store,async write(){
    throw Object.assign(Error('conflict'),{code:'FIXED_STORE_CONFLICT'});
  }}})).state,'BUSY');
  assert.deepEqual(current.days,[]);
  await assert.rejects(recoverArchivedOsanDispatch({...publish,store:{...store,async write(){}}}),/STORAGE_READBACK/);
});

test('projects verified positives and distinguishes source observations from complete dates',()=>{
  const result=projectRecentOperations(ledger(
    makeDay('2026-10-03','delivery_admin','partial',['A1','A2']),
    makeDay('2026-10-03','freshon_orders','complete',['A1']),
    makeDay('2026-10-03','wms_dispatch','complete',['A1']),
    makeDay('2026-11-05','freshon_orders','partial',['B1'],'honam'),
    makeDay('2026-11-05','wms_dispatch','complete',[],'yeongnam')
  ));
  assert.equal(result.centers.osan.activeCount,2);
  assert.deepEqual(result.centers.osan.confirmedDays,['2026-10-03']);
  assert.deepEqual(result.centers.yeongnam.confirmedDays,[]);
  assert.deepEqual(result.centers.yeongnam.observedDates,['2026-11-05']);
  assert.deepEqual(result.rows.find(row=>row.customerCode==='B1'),
    {customerCode:'B1',centerKey:'honam',date:'2026-11-05',evidence:'order_confirmed'});
  assert.equal(result.rows.find(row=>row.customerCode==='A1').evidence,'delivery_completed');
  assert.throws(()=>ledger(makeDay(initialEnd,'delivery_admin','complete')),/EVIDENCE_INVALID/);
  assert.throws(()=>ledger(makeDay(initialEnd,'wms_dispatch','partial',['A1','A1'])),/EVIDENCE_INVALID/);
});

test('selected rolling periods use their own evidence and expose unpublished dates without customer data',async()=>{
  const before=ledger(
    makeDay('2026-08-25','delivery_admin','partial',['A1']),
    makeDay('2026-09-25','delivery_admin','partial',['A2']),
    makeDay('2026-10-25','delivery_admin','partial',['A3']),
    makeDay('2026-11-16','delivery_admin','partial',['A4']),
    makeDay(initialEnd,'freshon_orders','complete',['A5']),
    makeDay(initialEnd,'wms_dispatch','complete',['A5']));
  let count=0;
  const read=createRecentOperationsReader({now:()=>Date.parse('2026-11-20T00:10:00Z'),store:{
    async read(){count++;return {ledger:before};}
  }});
  const summaries=await Promise.all([7,30,60,90].map(days=>read({days,summaryOnly:true})));
  assert.equal(count,1);
  assert.deepEqual(summaries.map(result=>result.centers.osan.activeCount),[2,3,4,5]);
  for (const result of summaries) {
    assert.equal(result.endDate,'2026-11-19');
    assert.equal(result.publishedThrough,initialEnd);
    assert.equal(Object.hasOwn(result,'rows'),false);
    const tail=result.centers.osan.calendar.slice(-4).map(({date,state})=>[date,state]);
    assert.deepEqual(tail,[['2026-11-16','PARTIAL'],['2026-11-17','COMPLETE'],['2026-11-18','NOT_PUBLISHED'],['2026-11-19','NOT_PUBLISHED']]);
    assert.equal(result.centers.yeongnam.calendar.at(-3).state,'NOT_OBSERVED');
    assert.equal(result.centers.osan.calendar.at(-3).sources.wms_dispatch.customerCount,1);
  }
  assert.equal((await read()).endDate,initialEnd,'default employee map keeps the published range');
});

test('retains earlier confirmed data on a partial input, expires old dates and separates centers',()=>{
  const base=ledger(makeDay(initialStart,'wms_dispatch','complete',['Z1']),
    makeDay(initialEnd,'freshon_orders','complete',['A1']),makeDay(initialEnd,'delivery_admin','partial',['B1'],'honam'));
  const next=mergeRecentOperations(base,'2026-11-18',[
    makeDay(initialEnd,'freshon_orders','partial',['X1']),
    makeDay('2026-11-18','wms_dispatch','complete',['A1'],'yeongnam')
  ]);
  const result=projectRecentOperations(next);
  assert.equal(result.startDate,'2026-08-21');
  assert.deepEqual(result.rows.map(row=>[row.centerKey,row.customerCode]).sort(),[
    ['honam','B1'],['osan','A1'],['yeongnam','A1']
  ]);
});

test('encrypts evidence, rejects a different key and retains prior memory if publication fails',async()=>{
  const original=ledger(makeDay(initialEnd,'freshon_orders','complete',['A1']));
  const key=Buffer.alloc(32,4);
  const value=await sealRecentOperations(original,key);
  assert.throws(()=>JSON.parse(Buffer.from(value.packed,'base64').toString('utf8')));
  assert.deepEqual(await openRecentOperations(value,key),original);
  await assert.rejects(openRecentOperations(value,Buffer.alloc(32,7)));
  let clock=Date.parse('2026-11-18T10:00:00Z'), count=0;
  const read=createRecentOperationsReader({readSeed:async()=>original,now:()=>clock,store:{
    async read(){ if (count++) throw Error('RECENT_OPERATIONS_STORAGE_SCOPE');return null; }
  }});
  const [first,second]=await Promise.all([read(),read()]);
  assert.equal(first,second);
  clock+=65000;
  assert.equal(await read(),first);
  assert.equal(count,2);
});

test('incremental publication adds only the last closed day, retains on missing input and reads back',async()=>{
  const original=ledger(makeDay(initialStart,'delivery_admin','partial',['A1']));
  const latest=makeDay('2026-11-18','wms_dispatch','complete',['B1'],'yeongnam');
  let current={ledger:null,sha:null}, available=false, writes=0;
  const store={
    read:async()=>current,readDay:async(date)=>{assert.equal(date,latest.date);return available?[latest]:null;},
    async write(next,sha){assert.equal(sha,current.sha);writes++;current={ledger:next,sha:'test'};}
  };
  const opts={store,receipt:{runId:'a'.repeat(64),date:'2026-11-19'},readSeed:async()=>original,
    now:()=>Date.parse('2026-11-19T03:00:00Z')};
  assert.equal((await syncStageRecentOperations(opts)).state,'SOURCE_UNAVAILABLE');
  assert.equal(writes,0);
  available=true;
  assert.equal((await syncStageRecentOperations(opts)).state,'PUBLISHED');
  assert.equal((await syncStageRecentOperations(opts)).state,'VERIFIED_NOOP');
  assert.deepEqual(projectRecentOperations(current.ledger).rows.map(row=>row.customerCode),['B1']);
  assert.equal(writes,1);
});

test('a signed first run publishes and verifies an identical protected seed before reporting no change',async()=>{
  const source=makeDay('2026-11-18','delivery_admin','partial',['A1']);
  const seed=normalizeRecentOperations({startDate:'2026-08-21',endDate:source.date,days:[source]});
  let current={ledger:null,sha:null},reads=0,writes=0;
  const store={async read(){reads++;return current;},readDay:async()=>[source],
    async write(value,sha){
      assert.equal(sha,current.sha);
      assert.deepEqual(value,seed);
      writes++;
      current={ledger:value,sha:'initial-publication'};
    }};
  const options={store,receipt:{runId:'a'.repeat(64),date:'2026-11-19'},readSeed:async()=>seed,
    now:()=>Date.parse('2026-11-19T03:00:00Z')};
  assert.deepEqual(await syncStageRecentOperations(options),{state:'PUBLISHED',endDate:source.date});
  assert.equal(reads,2);
  assert.deepEqual(await syncStageRecentOperations(options),{state:'VERIFIED_NOOP',endDate:source.date});
  assert.equal(writes,1);
});

test('a new closed day combines sealed orders with explicit live delivery evidence once',async()=>{
  const before=ledger(makeDay(initialEnd,'freshon_orders','partial',['A1']));
  const date='2026-11-18';
  const saved=[makeDay(date,'freshon_orders','partial',['A1']),makeDay(date,'delivery_admin','partial',['B1'],'honam')];
  let current={ledger:before,sha:'before'}, reads=0, writes=0;
  const store={read:async()=>current,readDay:async()=>saved,async write(next,sha){
    assert.equal(sha,'before');
    current={ledger:next,sha:'new'};
    writes++;
  }};
  const options={store,receipt:{runId:'a'.repeat(64),date:'2026-11-19'},now:()=>Date.parse('2026-11-18T21:10Z'),
    async readLatestDay(day,existing,orders){
      assert.equal(day,date);
      assert.deepEqual([...existing],['honam']);
      assert.deepEqual([...orders],['osan']);
      reads++;
      return [makeDay(day,'delivery_admin','partial',['A2'])];
    }};
  assert.equal((await syncStageRecentOperations(options)).state,'PUBLISHED');
  assert.equal((await syncStageRecentOperations(options)).state,'VERIFIED_NOOP');
  assert.equal(reads,1);
  assert.equal(writes,1);
  assert.equal(saved.length,2);
  assert.deepEqual(projectRecentOperations(current.ledger).centers.osan.confirmedDays,[]);
});

test('source order reads require an exact day, center, confirmed rows and complete line totals',async()=>{
  const date='2026-11-18', fetched=[], diagnostics=[];
  const good={stockDate:date,logCdName:'오산물류센터',dcOutDate:'확정',baechaName:'야간배송',estCd:'S1',dlvyEstCd:'S1',
    orderNo:'O100',seq:1,orderQty:2,totalCnt:1};
  const read=createStageRecentOrdersReader({env:{RENDER_EXTERNAL_URL:STAGE_ORIGIN,RENDER_SERVICE_ID:STAGE_SERVICE,
    OPSMAP_STAGE_RECENT_OPERATIONS_ORDERS_APPROVED:'1',FRESHON_COOKIE:'fixture'},
    onDiagnostic:diagnostic=>diagnostics.push(diagnostic),async fetchImpl(url,opt){
    assert.equal(url,'https://mis.freshon.co.kr/bo/sm/order/orderInfoList');
    assert.equal(opt.method,'POST');
    const query=new URLSearchParams(opt.body);
    assert.equal(query.get('stockDateS'),date);
    assert.equal(query.get('stockDateE'),date);
    assert.equal(query.get('dcOutDate'),'1');
    assert.equal(query.get('baecha'),'2');
    assert.equal(query.get('deliveGbn'),'');
    assert.equal(query.get('sortType'),'3');
    const center=query.get('logCd');
    fetched.push(center);
    if(center==='011') return Response.json({data:[good,{stockDate:'소계'}]});
    if(center==='012') return Response.json({data:[{...good,logCdName:'영남센터',totalCnt:2}]});
    return Response.json({data:[{...good,logCdName:'호남센터',dcOutDate:'미확정'}]});
  }});
  assert.deepEqual(await read(date),[makeNightOrderDay(date,'osan',['S1'])]);
  assert.deepEqual(fetched,['011','012','013']);
  assert.deepEqual(await read(date,new Set(['osan'])),[]);
  assert.deepEqual(fetched,['011','012','013','012','013']);
  assert.deepEqual(diagnostics,[
    {date,centerKey:'osan',state:'VERIFIED'},
    {date,centerKey:'yeongnam',state:'COUNT_UNVERIFIED'},
    {date,centerKey:'honam',state:'ROW_NOT_CONFIRMED'},
    {date,centerKey:'osan',state:'ALREADY_OBSERVED'},
    {date,centerKey:'yeongnam',state:'COUNT_UNVERIFIED'},
    {date,centerKey:'honam',state:'ROW_NOT_CONFIRMED'}
  ]);
});

test('order diagnostics distinguish empty, unsafe and inaccessible source results without row fields',async()=>{
  const date='2026-11-20', env={RENDER_EXTERNAL_URL:STAGE_ORIGIN,RENDER_SERVICE_ID:STAGE_SERVICE,
    OPSMAP_STAGE_RECENT_OPERATIONS_ORDERS_APPROVED:'1',FRESHON_COOKIE:'fixture'};
  const row={stockDate:date,logCdName:'오산물류센터',logCd:'011',dcOutDate:'확정',baechaName:'야간배송',estCd:'S1',dlvyEstCd:'S1',
    orderNo:'private-fixture-order',seq:1,orderQty:2,totalCnt:1};
  const cases=[
    ['SOURCE_EMPTY',[]],['RESPONSE_INVALID',null],
    ['ROW_DATE_MISMATCH',[{...row,stockDate:'2026-11-19'}]],
    ['ROW_CENTER_MISMATCH',[{...row,logCd:'012'}]],
    ['ROW_DISPATCH_SCOPE_MISMATCH',[{...row,baechaName:'주간 CJ'}]],
    ['ROW_DISPATCH_SCOPE_MISMATCH',[{...row,baecha:'1'}]],
    ['ROW_DISPATCH_SCOPE_MISMATCH',[{...row,baechaName:undefined}]],
    ['ROW_CUSTOMER_INVALID',[{...row,dlvyEstCd:'S2'}]],
    ['ROW_ORDER_KEY_INVALID',[{...row,seq:0.5}]],
    ['ROW_DUPLICATE',[{...row,totalCnt:2},row]],
    ['ROW_QUANTITY_INVALID',[{...row,orderQty:0}]]
  ];
  const onlyOsan=new Set(['yeongnam','honam']);
  for (const [state,data] of cases) {
    const diagnostics=[];
    const read=createStageRecentOrdersReader({env,fetchImpl:async()=>Response.json({data}),
      onDiagnostic:diagnostic=>diagnostics.push(diagnostic)});
    assert.deepEqual(await read(date,onlyOsan),[]);
    assert.deepEqual(diagnostics[0],{date,centerKey:'osan',state});
  }
  for (const [state,fetchImpl] of [
    ['SOURCE_FORBIDDEN',async()=>new Response(null,{status:403,headers:{'Content-Type':'text/html'}})],
    ['HTTP_REJECTED',async()=>new Response(null,{status:503})],
    ['READ_FAILED',async()=>{throw Error('private-fixture-error');}],
    ['AUTH_UNAVAILABLE',async()=>new Response(null,{status:401})]
  ]) {
    const diagnostics=[];
    const read=createStageRecentOrdersReader({env,fetchImpl,onDiagnostic:diagnostic=>diagnostics.push(diagnostic)});
    assert.deepEqual(await read(date,onlyOsan),[]);
    assert.deepEqual(diagnostics[0],{date,centerKey:'osan',state});
  }
  const read=createStageRecentOrdersReader({env,fetchImpl:async()=>Response.json({data:[row]}),
    onDiagnostic:()=>{throw Error('fixture diagnostic failure');}});
  assert.deepEqual(await read(date,onlyOsan),[makeNightOrderDay(date,'osan',['S1'])]);
});

test('unpaged night orders with an absent count require the same first line and declared total from the official paged request',async()=>{
  const date='2026-11-20', env={RENDER_EXTERNAL_URL:STAGE_ORIGIN,RENDER_SERVICE_ID:STAGE_SERVICE,
    OPSMAP_STAGE_RECENT_OPERATIONS_ORDERS_APPROVED:'1',FRESHON_COOKIE:'fixture'};
  const row={stockDate:date,logCdName:'영남센터',logCd:'012',dcOutDate:'확정',baechaName:'야간배송',estCd:'S1',dlvyEstCd:'S1',
    orderNo:'O100',seq:1,orderQty:2,totalCnt:0};
  const requests=[], diagnostics=[];
  let firstLine='O100';
  const read=createStageRecentOrdersReader({env,onDiagnostic:signal=>diagnostics.push(signal),async fetchImpl(_,options){
    const p=new URLSearchParams(options.body);
    requests.push([p.get('baecha'),p.get('logCd'),p.get('stockDateS'),p.get('isPaging'),p.get('size')]);
    return p.get('isPaging')==='true'?
      Response.json({status:200,data:[{...row,orderNo:firstLine,totalCnt:2}]}):
      Response.json({status:200,data:[row,{...row,seq:2},{stockDate:'소계'}]});
  }});
  const otherCenters=new Set(['osan','honam']);
  assert.deepEqual(await read(date,otherCenters),[makeNightOrderDay(date,'yeongnam',['S1'])]);
  assert.deepEqual(requests,[['2','012',date,'false','1000'],['2','012',date,'true','1']]);
  firstLine='DIFFERENT';
  assert.deepEqual(await read(date,otherCenters),[]);
  assert.equal(diagnostics.filter(item=>item.centerKey==='yeongnam').at(-1).state,'COUNT_UNVERIFIED');
});

test('streamed orders validate fragmented UTF-8, row/scope counts, and the complete envelope before accepting evidence',async()=>{
  const date='2026-11-20', diagnostics=[];
  const env={RENDER_EXTERNAL_URL:STAGE_ORIGIN,RENDER_SERVICE_ID:STAGE_SERVICE,
    OPSMAP_STAGE_RECENT_OPERATIONS_ORDERS_APPROVED:'1',FRESHON_COOKIE:'fixture'};
  const detail={stockDate:date,logCdName:'영남센터',dcOutDate:'확정',baechaName:'야간배송',estCd:'S1',dlvyEstCd:'S1',
    orderNo:'O100',seq:1,orderQty:2,totalCnt:1,extra:'한글 " \\ } ] : , '.repeat(6_000)};
  const body=JSON.stringify({other:{data:[1,{text:'[[]]'}]},data:[detail,{stockDate:'소계'}],ok:true});
  let responseText=body, cancelCount=0;
  const read=createStageRecentOrdersReader({env,onDiagnostic:value=>diagnostics.push(value),async fetchImpl(){
    const bytes=new TextEncoder().encode(responseText);
    let cursor=0;
    return new Response(new ReadableStream({
      pull(controller) {
        if(cursor>=bytes.length) {controller.close();return;}
        const next=cursor+113;
        controller.enqueue(bytes.subarray(cursor,next));cursor=next;
      },
      cancel(){cancelCount++;}
    }),{headers:{'content-type':'application/json; charset=utf-8'}});
  }});
  const skip=new Set(['osan','honam']);
  assert.deepEqual(await read(date,skip),[makeNightOrderDay(date,'yeongnam',['S1'])]);
  for (const [invalid,state] of [
    [body.replace('"ok":true','"ok":false'),'RESPONSE_INVALID'],
    [body.replace('"ok":true','"status":500'),'RESPONSE_INVALID'],
    [body.slice(0,-1)+',"data":[]}','READ_FAILED'],
    [body.slice(0,-1),'READ_FAILED'],
    [body+' invalid','READ_FAILED'],
    [body.replace('"totalCnt":1','"totalCnt":2'),'COUNT_UNVERIFIED'],
    [body.replace('"logCdName":"영남센터"','"logCdName":"호남센터"'),'ROW_CENTER_MISMATCH']
  ]) {
    responseText=invalid;
    assert.deepEqual(await read(date,skip),[]);
    assert.equal(diagnostics.filter(d=>d.centerKey==='yeongnam').at(-1).state,state);
  }
  assert.equal(cancelCount,0);
});

test('large Osan order exports stream within a bounded byte limit',async()=>{
  const date='2026-11-26', onlyOsan=new Set(['yeongnam','honam']), diagnostics=[];
  const env={RENDER_EXTERNAL_URL:STAGE_ORIGIN,RENDER_SERVICE_ID:STAGE_SERVICE,
    OPSMAP_STAGE_RECENT_OPERATIONS_ORDERS_APPROVED:'1',FRESHON_COOKIE:'fixture'};
  const count=16_474;
  const row={stockDate:date,logCdName:'오산물류센터',logCd:'011',dcOutDate:'확정',
    baechaName:'야간배송',estCd:'S1',dlvyEstCd:'S1',orderNo:'O1',orderQty:2,totalCnt:count,
    extra:'a'.repeat(3_100)};
  let emitted=0, tooLarge=false;
  const read=createStageRecentOrdersReader({env,onDiagnostic:value=>diagnostics.push(value),fetchImpl:async()=>{
    let seq=0;
    const headers={'content-type':'application/json'};
    if(tooLarge)headers['content-length']=String(64*1024*1024+1);
    return new Response(new ReadableStream({pull(controller){
      if(seq>count){controller.close();return;}
      const text=seq===0?'{"data":[':JSON.stringify({...row,seq})+(seq===count?']}':',');
      const bytes=Buffer.from(text);
      emitted+=bytes.length;
      controller.enqueue(bytes);
      seq++;
    }}),{headers});
  }});
  assert.deepEqual(await read(date,onlyOsan),[makeNightOrderDay(date,'osan',['S1'])]);
  assert.ok(emitted>48*1024*1024);
  assert.ok(emitted<64*1024*1024);
  tooLarge=true;
  assert.deepEqual(await read(date,onlyOsan),[]);
  assert.equal(diagnostics.filter(d=>d.centerKey==='osan').at(-1).state,'READ_FAILED');
});

test('a newly sourced day is saved and verified before advancing the operating ledger',async()=>{
  const date='2026-11-18', before=ledger(makeDay(initialEnd,'freshon_orders','partial',['S1']));
  const incoming=makeDay(date,'freshon_orders','partial',['S2']);
  let current={ledger:before,sha:'before'}, file, corrupt=true;
  const store={read:async()=>current,readDay:async()=>file,async writeDay(day,items){
    assert.equal(day,date);
    file=corrupt?[]:normalizeRecentOperations({startDate:'2026-08-21',endDate:day,days:items}).days;
  },async write(next,sha){assert.equal(sha,'before');assert.deepEqual(file,[incoming]);current={ledger:next,sha:'after'};}};
  const options={store,receipt:{runId:'a'.repeat(64),date:'2026-11-19'},now:()=>Date.parse('2026-11-18T21:10Z'),
    readLatestDay:async()=>[incoming]};
  await assert.rejects(syncStageRecentOperations(options),/RECENT_OPERATIONS_STORAGE_READBACK/);
  assert.equal(current.ledger,before);
  corrupt=false;
  file=undefined;
  assert.equal((await syncStageRecentOperations(options)).state,'PUBLISHED');
  assert.equal((await syncStageRecentOperations(options)).state,'VERIFIED_NOOP');
});

test('retries selected closed dates without scanning the entire window or assuming missing dates are empty',async()=>{
  const original=ledger(makeDay(initialEnd,'freshon_orders','partial',['A1']));
  const readDates=[];
  let current={ledger:original,sha:'initial'};
  const store={read:async()=>current,async readDay(date){
    readDates.push(date);
    return date==='2026-10-31'?[makeDay(date,'wms_dispatch','partial',['B1'],'honam')]:null;
  },async write(next,sha){
    assert.equal(sha,current.sha);
    current={ledger:next,sha:'written'};
  }};
  const options={store,receipt:{runId:'b'.repeat(64),date:'2026-11-19'},
    now:()=>Date.parse('2026-11-19T03:00:00Z'),retryDates:['2026-10-31','2026-10-31','2026-08-20']};
  assert.deepEqual(await syncStageRecentOperations(options),{state:'PUBLISHED',endDate:initialEnd});
  assert.deepEqual(readDates,['2026-11-18','2026-10-31']);
  assert.deepEqual(projectRecentOperations(current.ledger).centers.honam.confirmedDays,[]);
  assert.equal((await syncStageRecentOperations(options)).state,'VERIFIED_NOOP');
  await assert.rejects(syncStageRecentOperations({...options,retryDates:['2026-11-19']}),/EVIDENCE_INVALID/);
});

test('the scheduled run can recover one explicitly selected gap behind a published newer day',async()=>{
  const endDate='2026-11-21', missingDate='2026-11-20';
  const currentDay=makeDay(endDate,'freshon_orders','partial',['A1']);
  const recovered=makeDay(missingDate,'freshon_orders','partial',['B1'],'honam');
  const before=normalizeRecentOperations({startDate:'2026-08-24',endDate,days:[currentDay]});
  const files=new Map([[endDate,[currentDay]]]), fetched=[];
  let current={ledger:before,sha:'initial'};
  const store={read:async()=>current,readDay:async date=>files.get(date),
    async writeDay(date,days){
      assert.equal(date,missingDate);
      assert(!files.has(date));
      files.set(date,normalizeRecentOperations({startDate:before.startDate,endDate,days}).days);
    },
    async write(next,sha){assert.equal(sha,current.sha);assert.deepEqual(files.get(missingDate),[recovered]);
      current={ledger:next,sha:'updated'};}};
  const options={store,receipt:{runId:'b'.repeat(64),date:'2026-11-22'},
    now:()=>Date.parse('2026-11-21T21:45Z'),retryDates:[missingDate,'2026-11-19'],
    async readLatestDay(date,delivery,orders){
      fetched.push(date);
      assert.equal(delivery.size+orders.size,0);
      return date===missingDate?[recovered]:[];
    }};
  assert.deepEqual(await syncStageRecentOperations({...options,retryDates:[]}),{state:'VERIFIED_NOOP',endDate});
  assert.deepEqual(fetched,[]);
  assert.deepEqual(await syncStageRecentOperations(options),{state:'PUBLISHED',endDate});
  assert.deepEqual(fetched,[missingDate]);
  const coverage=projectRecentOperations(current.ledger).centers.honam;
  assert.deepEqual(coverage.observedDates,[missingDate]);
  assert.deepEqual(coverage.confirmedDays,[]);
  assert.deepEqual(await syncStageRecentOperations(options),{state:'VERIFIED_NOOP',endDate});
  assert.deepEqual(fetched,[missingDate,'2026-11-19']);
  assert.equal(files.has('2026-11-19'),false);
});

test('explicit repair fills a missing center/source without rewriting the day archive or weakening current evidence',async()=>{
  const date='2026-11-23', sha='already-published';
  const dispatch=makeDay(date,'wms_dispatch','partial',['A1']);
  const completeOrders=makeDay(date,'freshon_orders','complete',['A1','A2']);
  const partialOrders=makeDay(date,'freshon_orders','partial',['A1']);
  const oldDelivery=makeDay(date,'delivery_admin','partial',['B2'],'honam');
  const newDelivery=makeDay(date,'delivery_admin','partial',['C1'],'yeongnam');
  let current={ledger:mergeRecentOperations(ledger(),date,[dispatch,completeOrders,oldDelivery]),sha};
  const archive=[partialOrders,oldDelivery];
  const calls=[];
  const options={repairDate:date,retryDates:['2026-11-22'],
    now:()=>Date.parse('2026-11-24T00:10Z'),receipt:{runId:'b'.repeat(64),date:'2026-11-24'},
    store:{async read(){return current;},async readDay(day){return day===date?archive:null;},
      async writeDay(){assert.fail('Do not rewrite a day archive');},
      async write(next,expected){assert.equal(expected,sha);current={ledger:next,sha:'updated'};}},
    async readLatestDay(day,delivery,orders){
      calls.push(day);
      assert.deepEqual([...orders],['osan']);
      assert(delivery.has('honam'));
      return delivery.has('yeongnam')?[]:[newDelivery];
    }};
  assert.equal((await syncStageRecentOperations(options)).state,'PUBLISHED');
  assert.deepEqual(calls,[date]);
  assert.deepEqual(archive,[partialOrders,oldDelivery]);
  assert.deepEqual(current.ledger.days,[oldDelivery,completeOrders,dispatch,newDelivery]);
  assert.equal((await syncStageRecentOperations(options)).state,'VERIFIED_NOOP');
  assert.deepEqual(calls,[date,date]);
  await assert.rejects(syncStageRecentOperations({...options,readLatestDay:async()=>[oldDelivery]}),/EVIDENCE_INVALID/);
});

test('the signed latest-day collection fills source gaps after an Osan WMS-only publication',async()=>{
  const date='2026-11-23', sha='already-published';
  const dispatch=makeDay(date,'wms_dispatch','partial',Array.from({length:1629},(_,i)=>'S'+(i+1)));
  const osanOrder=makeDay(date,'freshon_orders','partial',['S1']);
  const honamDelivery=makeDay(date,'delivery_admin','partial',['S2'],'honam');
  let current={ledger:mergeRecentOperations(ledger(),date,[dispatch]),sha}, sealed, writes=0;
  const options={now:()=>Date.parse('2026-11-24T00:10Z'),receipt:{runId:'b'.repeat(64),date:'2026-11-24'},
    store:{async read(){return current;},async readDay(){return sealed;},
      async writeDay(selected,days){assert.equal(selected,date);assert.equal(sealed,undefined);sealed=days;},
      async write(next,expected){assert.equal(expected,sha);current={ledger:next,sha:'updated'};writes++;}},
    async readLatestDay(day,delivery,orders){
      assert.equal(day,date);
      if (sealed) {
        assert.deepEqual([...delivery],['honam']);
        assert.deepEqual([...orders],['osan']);
        return [];
      }
      assert.equal(delivery.size+orders.size,0);
      return [osanOrder,honamDelivery];
    }};
  assert.equal((await syncStageRecentOperations(options)).state,'PUBLISHED');
  assert.deepEqual(sealed,[honamDelivery,osanOrder,current.ledger.days.find(row=>row.source==='wms_dispatch')]
    .sort((a,b)=>(a.centerKey+':'+a.source).localeCompare(b.centerKey+':'+b.source)));
  assert.equal(sealed.find(row=>row.source==='wms_dispatch').rows.length,1629);
  assert.deepEqual(sealed,current.ledger.days);
  assert.equal((await syncStageRecentOperations(options)).state,'VERIFIED_NOOP');
  assert.equal(writes,1);
});

test('one bounded historical scope resumes on the next signed day, preserving archived and partial evidence',async()=>{
  const date='2026-11-22', latest='2026-11-23';
  const wms=makeDay(latest,'wms_dispatch','partial',['S10']);
  const old=makeDay(date,'freshon_orders','partial',['S20'],'yeongnam');
  const delivered=makeDay(date,'delivery_admin','partial',['S30'],'yeongnam');
  const extraOrder=makeDay(date,'freshon_orders','partial',['S40'],'yeongnam');
  let current={ledger:mergeRecentOperations(ledger(),latest,[old,wms]),sha:'before'};
  const archive=[old], calls=[], claims=new Set();
  let receiptDate='2026-11-24', writes=0, conflict=false, elapsed=0;
  const options=()=>({
    store:{async read(){return current;},async readDay(day){return day===date?archive:null;},
      async claimRecovery(day){
        if(claims.has(day))return false;
        claims.add(day);return true;
      },
      async writeDay(){assert.fail('Historical repair must preserve the sealed daily archive');},
      async write(next,sha){
        assert.equal(sha,current.sha);
        if(conflict)throw Object.assign(Error(),{code:'FIXED_STORE_CONFLICT'});
        current={ledger:next,sha:'writer-'+ ++writes};
      }},
    receipt:{runId:'c'.repeat(64),date:receiptDate},now:()=>Date.parse(receiptDate+'T00:00Z')+elapsed,
    recoverySources:['delivery_admin','freshon_orders'],
    async readLatestDay(day){calls.push(['latest',day]);return [];},
    async readHistoricalScope(scope,signal){
      assert(signal instanceof AbortSignal && !signal.aborted);
      calls.push(['historical',scope.date,scope.centerKey,scope.source]);
      if(scope.centerKey==='honam')return [];
      return [scope.source==='delivery_admin'?delivered:extraOrder];
    }
  });
  assert.equal((await syncStageRecentOperations(options())).state,'PUBLISHED');
  assert.deepEqual(calls,[['latest',latest],['historical',date,'yeongnam','delivery_admin']]);
  assert.equal(current.ledger.recovery[0].state,'VERIFIED');
  assert.deepEqual(archive,[old]);
  assert(current.ledger.days.some(d=>d.source==='wms_dispatch'));
  assert.equal(projectRecentOperations(current.ledger,{days:7}).centers.yeongnam.calendar.at(-2).state,'PARTIAL');
  await syncStageRecentOperations(options());
  assert.equal(calls.filter(([kind])=>kind==='historical').length,1);
  assert.equal(writes,1);

  receiptDate='2026-11-25';
  conflict=true;
  assert.equal((await syncStageRecentOperations(options())).state,'BUSY');
  assert.equal(current.ledger.recovery.length,1);
  conflict=false;
  assert.equal((await syncStageRecentOperations(options())).state,'SOURCE_UNAVAILABLE');
  assert.equal(calls.filter(([kind])=>kind==='historical').length,2);
  receiptDate='2026-11-26';
  assert.equal((await syncStageRecentOperations(options())).state,'PUBLISHED');
  assert.deepEqual(current.ledger.days.find(d=>d.source==='freshon_orders').rows.map(r=>r.customerCode),['S20','S40']);
  assert.deepEqual(calls.filter(([kind])=>kind==='historical').slice(-2),
    [['historical',date,'yeongnam','freshon_orders'],['historical',date,'yeongnam','freshon_orders']]);

  receiptDate='2026-11-27';
  const late=options();
  late.readLatestDay=async()=>{elapsed=95_000;return [];};
  assert.equal((await syncStageRecentOperations(late)).state,'SOURCE_UNAVAILABLE');
  assert.equal(writes,2);
  elapsed=0;
  assert.equal((await syncStageRecentOperations(options())).state,'RECOVERY_CHECKPOINTED');
  assert.equal(current.ledger.recovery.find(r=>r.centerKey==='honam').state,'NO_ACCEPTED_EVIDENCE');
  assert.equal(mergeRecentOperations(current.ledger,'2027-02-22',[]).recovery,undefined);
});

test('explicit multi-scope budget shares one claim, persists cooldown, and stops retrying blocked scopes',async()=>{
  const target='2026-11-22';
  let receiptDate='2026-11-24',clock=0,claims=0;
  const scopes=[];
  let current={ledger:mergeRecentOperations(ledger(),'2026-11-23',[]),sha:'first'};
  const options=()=>({store:{
    async read(){return current;},async readDay(){return null;},
    async claimRecovery(day){assert.equal(day,receiptDate);claims++;return true;},
    async write(next,sha){assert.equal(sha,current.sha);current={ledger:next,sha:'published-'+claims};}
  },receipt:{runId:'d'.repeat(64),date:receiptDate},
  now:()=>Date.parse(receiptDate+'T00:00Z')+clock,recoveryScopeLimit:2,
  recoverySources:['delivery_admin','freshon_orders'],async readHistoricalScope(scope,signal){
    assert(!signal.aborted);
    scopes.push([receiptDate,scope.date,scope.centerKey,scope.source]);
    if(scope.date===target&&scope.centerKey==='yeongnam'){
      return {rows:[],state:scope.source==='delivery_admin'?'RETRY_LATER':'SCOPE_BLOCKED'};
    }
    clock=95_000;
    return {rows:[makeDay(scope.date,scope.source,'partial',['B1'],scope.centerKey)]};
  }});
  let result=await syncStageRecentOperations(options());
  assert.equal(result.state,'RECOVERY_CHECKPOINTED');
  assert.equal(claims,1);
  assert.deepEqual(result.recoveryBatch.map(r=>[r.source,r.state,r.attemptCount,r.nextEligibleOn]),[
    ['delivery_admin','RETRY_LATER',1,'2026-11-25'],
    ['freshon_orders','SCOPE_BLOCKED',1,undefined]
  ]);
  await syncStageRecentOperations(options());
  assert.equal(claims,1);
  receiptDate='2026-11-25';
  result=await syncStageRecentOperations(options());
  assert.equal(result.state,'PUBLISHED');
  assert.deepEqual(result.recoveryBatch.map(r=>[r.centerKey,r.source,r.attemptCount,r.nextEligibleOn]),[
    ['yeongnam','delivery_admin',2,'2026-11-27'],['honam','delivery_admin',1,undefined]
  ]);
  receiptDate='2026-11-26';
  clock=0;
  await syncStageRecentOperations(options());
  assert(scopes.filter(([date])=>date===receiptDate).every(scope=>scope[2]!=='yeongnam'));
  receiptDate='2026-11-27';
  clock=0;
  await syncStageRecentOperations(options());
  assert.equal(current.ledger.recovery.find(r=>r.centerKey==='yeongnam'&&r.source==='delivery_admin').attemptCount,3);
  assert.equal(current.ledger.recovery.find(r=>r.centerKey==='yeongnam'&&r.source==='delivery_admin').nextEligibleOn,undefined);
  assert.equal(scopes.filter(row=>row[2]==='yeongnam'&&row[3]==='freshon_orders').length,1);
});

test('the Stage historical sender claim can be created once per current Seoul day',async()=>{
  const date='2026-11-24', claims=new Set();
  const env={RENDER_SERVICE_ID:STAGE_SERVICE,RENDER_EXTERNAL_URL:STAGE_ORIGIN,
    OPSMAP_STAGE_RECENT_OPERATIONS_SYNC_APPROVED:'1',OPSMAP_STAGE_SYNC_REMOTE_APPROVED:'1',
    OPSMAP_STAGE_SYNC_PUBLISH_APPROVED:'1',OPSMAP_STAGE_SYNC_WRITE_TOKEN:'synthetic-stage',
    OPSMAP_SHADOW_POSTAL_ASSET_KEY_B64:Buffer.alloc(32,4).toString('base64')};
  const make=(extra={})=>createStageRecentOperationsStore({env:{...env,...extra},write:true,
    now:()=>Date.parse('2026-11-23T21:40Z'),async fetchImpl(url,options){
      assert.equal(options.redirect,'error');
      const address=new URL(url);
      if (!options.method) return Response.json({private:true});
      assert.equal(options.method,'PUT');
      assert.match(address.pathname,/\/recent-operations-v1\/repair-2026-11-24\.json$/);
      const body=JSON.parse(options.body);
      assert.equal(body.sha,undefined);
      assert.equal(body.branch,'stage/opsmap-snapshots');
      if (claims.has(address.pathname)) return new Response(null,{status:422});
      claims.add(address.pathname);
      return new Response(null,{status:201});
    }});
  assert.equal(make().claimRecovery,undefined);
  const enabled=()=>make({OPSMAP_STAGE_RECENT_OPERATIONS_AUTO_REPAIR_APPROVED:'1'});
  await assert.rejects(enabled().claimRecovery('2026-11-23','a'.repeat(64)),/EVIDENCE_INVALID/);
  assert.deepEqual(await Promise.all([enabled().claimRecovery(date,'a'.repeat(64)),
    enabled().claimRecovery(date,'b'.repeat(64))]),[true,false]);
});

test('the Stage reader can read a published pointer with its existing read-only credential',async()=>{
  const base=ledger(makeDay(initialEnd,'delivery_admin','partial',['A1']));
  const encoded=Buffer.alloc(32,5).toString('base64');
  const packed=await sealRecentOperations(base,recentOperationsKey(encoded));
  const paths=[];
  const reader=createStageRecentOperationsStore({env:{RENDER_SERVICE_ID:STAGE_SERVICE,RENDER_EXTERNAL_URL:STAGE_ORIGIN,
    OPSMAP_STAGE_RECENT_OPERATIONS_SYNC_APPROVED:'1',OPSMAP_STAGE_SYNC_REMOTE_APPROVED:'1',
    OPSMAP_SHADOW_GITHUB_READ_TOKEN:'stage-read-fixture',OPSMAP_SHADOW_POSTAL_ASSET_KEY_B64:encoded},
  async fetchImpl(url,{method='GET',headers}){
    assert.equal(method,'GET');
    assert.equal(headers.Authorization,'Bearer stage-read-fixture');
    paths.push(url);
    return paths.length===1?Response.json({private:true}):Response.json(packed);
  }});
  assert.deepEqual((await reader.read()).ledger,base);
  assert.equal(typeof reader.write,'undefined');
  assert.match(paths[1],/recent-operations-v1\/current\.json\?ref=stage%2Fopsmap-snapshots$/);
});

test('the current pointer readback verifies the actual written digest and authentication tag',async()=>{
  const encoded=Buffer.alloc(32,5).toString('base64');
  const env={RENDER_SERVICE_ID:STAGE_SERVICE,RENDER_EXTERNAL_URL:STAGE_ORIGIN,
    OPSMAP_STAGE_RECENT_OPERATIONS_SYNC_APPROVED:'1',OPSMAP_STAGE_SYNC_REMOTE_APPROVED:'1',
    OPSMAP_STAGE_SYNC_PUBLISH_APPROVED:'1',OPSMAP_STAGE_SYNC_WRITE_TOKEN:'synthetic-stage',
    OPSMAP_SHADOW_POSTAL_ASSET_KEY_B64:encoded};
  const original=ledger(makeDay(initialEnd,'wms_dispatch','complete',['A1']));
  const sha='a'.repeat(40);
  let stored=await sealRecentOperations(original,recentOperationsKey(encoded));
  const store=createStageRecentOperationsStore({env,write:true,async fetchImpl(url,options){
    const address=new URL(url);
    if(address.pathname.endsWith('/freshon-cache')) return Response.json({private:true});
    assert.match(address.pathname,/\/recent-operations-v1\/current\.json$/);
    if(options.method==='PUT'){
      const update=JSON.parse(options.body);
      assert.equal(update.sha,sha);
      stored=JSON.parse(Buffer.from(update.content,'base64'));
      return Response.json({});
    }
    return Response.json({sha,content:Buffer.from(JSON.stringify(stored)).toString('base64')});
  }});
  const next=mergeRecentOperations(original,initialEnd,[makeDay(initialEnd,'wms_dispatch','complete',['A2'])]);
  const version=await store.write(next,sha);
  assert.equal(await store.readback(version),sha);
  assert.deepEqual((await store.read()).ledger,next);
  await assert.rejects(store.readback('b'.repeat(64)),/RECENT_OPERATIONS_STORAGE_READBACK/);
  const invalidPacked=Buffer.from(stored.packed,'base64');
  invalidPacked[invalidPacked.length-1]^=1;
  stored={...stored,packed:invalidPacked.toString('base64')};
  await assert.rejects(store.readback(version));
});

test('protects positive evidence before reading and again after the asynchronous read',async t=>{
  const app=express();
  let callbacks=0, revoke=false;
  mountRecentOperations(app,{now:()=>Date.parse('2026-11-18T19:00:00Z'),requireStaff(req,res,next){
    if (req.get('Authorization')!=='test-employee' || revoke) return res.sendStatus(401);
    next();
  },async read() {
    callbacks++;
    revoke=callbacks===2;
    return projectRecentOperations(ledger(makeDay(initialEnd,'wms_dispatch','partial',['A1'])));
  }});
  const server=app.listen(0,'127.0.0.1');
  t.after(()=>server.close());
  await new Promise(resolve=>server.once('listening',resolve));
  const url='http://127.0.0.1:'+server.address().port+RECENT_OPERATIONS_ROUTE;
  assert.equal((await fetch(url)).status,401);
  assert.equal(callbacks,0);
  const options={headers:{Authorization:'test-employee'}};
  const allowed=await fetch(url,options);
  assert.equal(allowed.headers.get('cache-control'),'private, no-store');
  const value=await allowed.json();
  assert.equal(value.rows.length,1);
  assert.equal(value.expectedEndDate,'2026-11-18');
  assert.equal((await fetch(url,options)).status,401);
});

test('employee period request selects the summary and rejects unsupported or repeated options',async t=>{
  const app=express();
  const current=ledger(makeDay(initialEnd,'delivery_admin','partial',['A1']));
  const now=()=>Date.parse('2026-11-19T20:00:00Z');
  const read=createRecentOperationsReader({now,store:{async read(){return {ledger:current};}}});
  mountRecentOperations(app,{now,read,requireStaff(req,res,next){
    if (req.get('Authorization')!=='test-employee') return res.sendStatus(401);
    return next();
  }});
  const server=app.listen(0,'127.0.0.1');
  t.after(()=>server.close());
  await new Promise(resolve=>server.once('listening',resolve));
  const url='http://127.0.0.1:'+server.address().port+RECENT_OPERATIONS_ROUTE;
  const options={headers:{Authorization:'test-employee'}};
  assert.equal((await fetch(url+'?days=7&summary=1')).status,401);
  const allowed=await fetch(url+'?days=7&summary=1',options);
  assert.equal(allowed.status,200);
  assert.equal(allowed.headers.get('cache-control'),'private, no-store');
  const result=await allowed.json();
  assert.equal(result.days,7);
  assert.equal(result.centers.osan.calendar.length,7);
  assert.equal(Object.hasOwn(result,'rows'),false);
  for (const query of ['days=14','days=7&days=30','summary=1','days=30&summary=0','days=7&customer=A1']) {
    assert.equal((await fetch(url+'?'+query,options)).status,400);
  }
});
