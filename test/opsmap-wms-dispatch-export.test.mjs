import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import XLSX from 'xlsx';
import { createStageWmsDispatchExportReader, parseOpsmapWmsDispatchExport, projectOpsmapWmsDispatch,
  sealOpsmapWmsDispatchExport, publishStageWmsDispatchExport } from '../src/opsmapWmsDispatchExport.js';
import { syncStageFreshonWmsDispatch } from '../src/stageFreshonWmsWorkbookGate.js';
import { createOpsmapDispatchReferenceReader } from '../src/opsmapDispatchReference.js';
import { coordinateAddressHash } from '../src/opsmap-abc/opsmapAutoCoordinates.js';
import { STAGE_ORIGIN, STAGE_SERVICE } from '../src/stageScope.js';
import { createStageShadowRuntime } from '../src/shadowCoverage/stageArchive.js';

const date='2026-11-23',observedAt='2026-11-22T13:15:00.000Z';
const address='경기도 오산시 합성로 10';
const input=()=>[
  ['입고요청일','확정호차','고객','매출금액','배송건수','고객주소','기사명','연락처'],
  ['20261123','101','S91001','450','1',address,'fixture driver private','private'],
  ['','소계','','500','1'],
  ['2026-11-23','208','S91002','900','1','합성 다른 주소'],
  ['','소계','','900','1'],
  ['2026-11-23','','S91003','101','1','합성 다른 주소'],
  ['','','','101','1'],
  ['합계','','','1501','3'],
];
function workbook(rows=input()) {
  const book=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(rows),'Dispatch');
  return XLSX.write(book,{type:'buffer',bookType:'xlsx'});
}
const parse=bytes=>parseOpsmapWmsDispatchExport(bytes,{date,observedAt});

test('the same-day export reconciles published totals and preserves per-vehicle differences',()=>{
  const result=parse(workbook());
  assert.equal(result.deliveryCount,3);
  assert.equal(result.total,1501);
  assert.deepEqual(result.vehicles.map(({vehicle,amount,detailTotal,difference})=>({vehicle,amount,detailTotal,difference})),[
    {vehicle:'101',amount:500,detailTotal:450,difference:50},
    {vehicle:'208',amount:900,detailTotal:900,difference:0},
    {vehicle:'미배정',amount:101,detailTotal:101,difference:0},
  ]);
  const registry=new Map([
    ['S91001',{name:'합성 매장',center:'osan',hasPoint:true,lat:37.1,lng:127.1,addressHash:coordinateAddressHash(address)}],
    ['S91002',{name:'가려진 매장',center:'osan',hasPoint:true,lat:37.2,lng:127.2,addressHash:coordinateAddressHash(address)}],
  ]);
  const projection=projectOpsmapWmsDispatch(result,registry,new Map([['S91001','01234'],['S91002','55555']]));
  assert.equal(projection.route.unassigned,1);
  assert.equal(projection.route.rows.length,2);
  assert.deepEqual(projection.route.rows[0],{customerCode:'S91001',vehicle:'101',customerName:'합성 매장',postalCode:'01234',
    lat:37.1,lng:127.1,coordinateVerified:true,registryMatched:true});
  assert.equal(projection.route.rows[1].postalCode,null);
  assert.equal(projection.route.rows[1].lat,null);
  assert.equal(projection.amounts.vehicles[0].detailRows[0].amount,450);
  const body=JSON.stringify(projection);
  for(const hidden of [address,'fixture driver private','55555','addressHash','가려진 매장']) assert(!body.includes(hidden));
});

test('wrong dates, duplicate detail and a corrupt source total fail closed',()=>{
  const wrong=input();wrong[1][0]='2026-11-22';
  assert.throws(()=>parse(workbook(wrong)),{code:'WMS_EXPORT_DATE_MISMATCH'});
  const duplicate=input();duplicate.splice(2,0,[...duplicate[1]]);
  assert.throws(()=>parse(workbook(duplicate)),{code:'WMS_EXPORT_DUPLICATE_DETAIL'});
  const invalid=input();invalid.at(-1)[3]='1502';
  assert.throws(()=>parse(workbook(invalid)),{code:'WMS_EXPORT_TOTAL_MISMATCH'});
});

test('distinct source allocations for the same shop roll up only with matching name, address, and subtotal',()=>{
  const rows=input();
  rows[0].push('고객명','기준호차');
  rows[1].push('과거 원천 이름','101');
  const slice=[...rows[1]];
  slice[3]='50';
  slice[9]='108';
  rows.splice(2,0,slice);
  rows[3][4]='2';
  rows.at(-1)[4]='4';
  const valid=parse(workbook(rows));
  assert.equal(valid.vehicles[0].deliveryCount,2);
  assert.equal(valid.vehicles[0].detailTotal,500);
  assert.equal(valid.vehicles[0].details.length,1);
  assert.equal(valid.vehicles[0].details[0].customerName,'과거 원천 이름');
  assert.equal(projectOpsmapWmsDispatch(valid).route.rows[0].vehicle,'101');
  slice[5]='주소 다름';
  assert.throws(()=>parse(workbook(rows)),{code:'WMS_EXPORT_DUPLICATE_DETAIL'});
});

test('Stage can only read the approved dated, pinned Osan file and caches successful verification',async()=>{
  const data=workbook(),hash=createHash('sha256').update(data).digest('hex');
  let reads=0;
  const env={
    RENDER_SERVICE_ID:STAGE_SERVICE,RENDER_EXTERNAL_URL:STAGE_ORIGIN,OPSMAP_STAGE_WMS_DISPATCH_EXPORT_APPROVED:'1',
    OPSMAP_STAGE_WMS_DISPATCH_EXPORTS_JSON:JSON.stringify({[date]:{warehouse:'011',sha256:hash,observedAt}}),
  };
  const readSecret=async(file, encoding)=>{
    reads++;
    assert.equal(file,'/etc/secrets/opsmap-wms-dispatch-'+date+'.xlsx.b64');
    assert.equal(encoding,'utf8');
    return data.toString('base64');
  };
  const approved=createStageWmsDispatchExportReader({env,readSecret});
  const blocked=createStageWmsDispatchExportReader({env:{...env,RENDER_EXTERNAL_URL:'https://example.invalid'},readSecret});
  assert.equal(await approved('2026-11-22'),null);
  assert.equal(approved.configurationFailure('2026-11-22'),'WMS_EXPORT_DATE_NOT_APPROVED');
  assert.equal(await blocked(date),null);
  assert.equal(blocked.configurationFailure(date),'WMS_EXPORT_APPROVAL_MISSING');
  const verifyLocal=createStageWmsDispatchExportReader({env:{
    ...env,OPSMAP_STAGE_WMS_DISPATCH_EXPORT_ARCHIVE_REF:'a'.repeat(40)
  },fetchImpl:()=>assert.fail('Same-byte verification must not read the archive')});
  assert.equal(verifyLocal.verifyWorkbook(date,data).observedAt,new Date(observedAt).toISOString());
  assert.throws(()=>verifyLocal.verifyWorkbook(date,Buffer.from('other')),{code:'WMS_EXPORT_DIGEST'});
  assert.throws(()=>verifyLocal.verifyWorkbook('2026-11-22',data),{code:'WMS_EXPORT_DATE_NOT_APPROVED'});
  assert.throws(()=>blocked.verifyWorkbook(date,data),{code:'WMS_EXPORT_APPROVAL_MISSING'});
  assert.equal(reads,0);
  const [first,second]=await Promise.all([approved(date),approved(date)]);
  assert.equal(first,second);
  assert.equal(reads,1);
  const corrupt=createStageWmsDispatchExportReader({env,readSecret:async()=>Buffer.from('wrong bytes').toString('base64')});
  await assert.rejects(corrupt(date),{code:'WMS_EXPORT_DIGEST'});
});

test('one approved WMS export supplies both confirmed stops and amounts without fetching a separate cache',async()=>{
  let otherCalls=0;
  const read=createOpsmapDispatchReferenceReader({
    getPublication:()=>null,
    readWmsExport:()=>parse(workbook()),
    readAmounts:()=>{otherCalls++;},
  });
  const day=await read(date);
  assert.equal(day.route.source,'WMS_CONFIRMED_DISPATCH_EXPORT');
  assert.equal(day.amounts.source,day.route.source);
  assert.equal(otherCalls,0);
  const wrong=createOpsmapDispatchReferenceReader({
    getPublication:()=>null,
    readWmsExport:()=>{throw Object.assign(Error(),{code:'WMS_EXPORT_DATE_MISMATCH'});},
    readAmounts:()=>null,
  });
  const missing=await wrong(date);
  assert.equal(missing.amounts.exportFailure,'DATE_MISMATCH');
  assert.equal(missing.route.state,'UNAVAILABLE');
});

test('the approved archive authenticates a dated XLSX from a private, pinned GitHub revision',async()=>{
  const key=Buffer.alloc(32,0x31),ref='b'.repeat(40);
  const {manifest,archive}=sealOpsmapWmsDispatchExport(workbook(),{date,observedAt,key});
  const env={
    RENDER_SERVICE_ID:STAGE_SERVICE,RENDER_EXTERNAL_URL:STAGE_ORIGIN,OPSMAP_STAGE_WMS_DISPATCH_EXPORT_APPROVED:'1',
    OPSMAP_STAGE_WMS_DISPATCH_EXPORTS_JSON:JSON.stringify({[date]:manifest}),
    OPSMAP_STAGE_WMS_DISPATCH_EXPORT_ARCHIVE_REF:ref,
    OPSMAP_STAGE_WMS_DISPATCH_EXPORT_ARCHIVE_KEY_B64:key.toString('base64'),
    OPSMAP_SHADOW_GITHUB_READ_TOKEN:'test-read-token',
  };
  const root='https://api.github.com/repos/mingu0702-droid/freshon-cache';
  const calls=[];
  let privateRepo=true, response=archive;
  const fetchImpl=async(url,options)=>{
    calls.push(url);
    assert.equal(options.method,'GET');
    assert.equal(options.redirect,'error');
    assert.equal(options.headers.Authorization,'Bearer test-read-token');
    if (url===root) return Response.json({private:privateRepo});
    assert.equal(url,root+'/contents/opsmap-stage/wms-dispatch-v1/'+date+'.json?ref='+ref);
    return Response.json(response);
  };
  const reader=(overrides={})=>createStageWmsDispatchExportReader({
    env:{...env,...overrides},fetchImpl,readSecret:async()=>assert.fail('unexpected Secret File fallback'),
  });
  const read=reader();
  assert.equal(await reader({RENDER_SERVICE_ID:'other-service'})(date),null);
  assert.equal(calls.length,0);
  assert.equal((await read(date)).vehicles[0].amount,500);
  assert.equal((await read(date)).date,date);
  assert.equal(calls.length,2);

  // Stage removes the shared read credential from the general app environment.
  const {env:appEnv}=createStageShadowRuntime(env);
  assert.equal(appEnv.OPSMAP_SHADOW_GITHUB_READ_TOKEN,undefined);
  const stripped=createStageWmsDispatchExportReader({env:appEnv,fetchImpl});
  const oldPath=createOpsmapDispatchReferenceReader({getPublication:()=>null,readWmsExport:stripped});
  const missing=await oldPath(date);
  assert.equal(missing.route.state,'UNAVAILABLE');
  assert.equal(missing.amounts.exportFailure,'WMS_EXPORT_ARCHIVE_TOKEN_MISSING');
  assert.equal(calls.length,2);
  const startupReader=reader();
  assert.deepEqual(startupReader.configuration.archive,{refValid:true,keyValid:true,tokenPresent:true});
  const newPath=createOpsmapDispatchReferenceReader({getPublication:()=>null,readWmsExport:startupReader});
  assert.equal((await newPath(date)).amounts.vehicles[0].amount,500);
  assert.equal(calls.length,4);

  const changed={...manifest,sha256:'a'.repeat(64)};
  await assert.rejects(reader({OPSMAP_STAGE_WMS_DISPATCH_EXPORTS_JSON:JSON.stringify({[date]:changed})})(date),
    {code:'WMS_EXPORT_ARCHIVE_INTEGRITY'});
  response={...archive,tag:'0'.repeat(32)};
  await assert.rejects(reader()(date),{code:'WMS_EXPORT_ARCHIVE_INTEGRITY'});

  privateRepo=false;
  calls.length=0;
  await assert.rejects(reader()(date),{code:'WMS_EXPORT_ARCHIVE_PERMISSION'});
  assert.deepEqual(calls,[root]);
});
test('published Stage WMS releases verify key, ciphertext, date and CAS without changing approved legacy files',async()=>{
  const key=Buffer.alloc(32,0x31);
  const ref='b'.repeat(40), branch='stage/opsmap-wms-exports';
  const root='https://api.github.com/repos/mingu0702-droid/freshon-cache';
  const prefix=root+'/contents/opsmap-stage/wms-dispatch-v1/';
  const {manifest,archive}=sealOpsmapWmsDispatchExport(workbook(),{date,observedAt,key});
  const env={
    RENDER_SERVICE_ID:STAGE_SERVICE,RENDER_EXTERNAL_URL:STAGE_ORIGIN,
    OPSMAP_STAGE_WMS_DISPATCH_EXPORT_APPROVED:'1',OPSMAP_STAGE_WMS_DISPATCH_EXPORT_PUBLISH_APPROVED:'1',
    OPSMAP_STAGE_WMS_DISPATCH_EXPORTS_JSON:JSON.stringify({[date]:manifest}),
    OPSMAP_STAGE_WMS_DISPATCH_EXPORT_ARCHIVE_REF:ref,
    OPSMAP_STAGE_WMS_DISPATCH_EXPORT_ARCHIVE_KEY_B64:key.toString('base64'),
    OPSMAP_STAGE_WMS_DISPATCH_EXPORT_ARCHIVE_WRITE_TOKEN:'stage-test-write',
    OPSMAP_SHADOW_GITHUB_READ_TOKEN:'stage-test-read',
  };
  const files=new Map(), events=[];
  let rejectsOnce=true;
  const fetchImpl=async(input,options)=>{
    const url=new URL(input),address=url.origin+url.pathname, method=options.method||'GET';
    assert.equal(options.redirect,'error');
    if(address===root) return Response.json({private:true});
    assert.ok(address.startsWith(prefix));
    const name=address.slice(prefix.length);
    if(url.searchParams.get('ref')===ref){
      assert.equal(name,date+'.json');
      assert.equal(method,'GET');
      return Response.json(archive);
    }
    const previous=files.get(name);
    if(method==='PUT'){
      assert.equal(options.headers.Authorization,'Bearer stage-test-write');
      const data=JSON.parse(options.body);
      assert.equal(data.branch,branch);
      events.push(name);
      if(name==='release-index-v1.json'&&rejectsOnce){
        rejectsOnce=false;return new Response(null,{status:409});
      }
      if(previous&&data.sha!==previous.sha||!previous&&data.sha) return new Response(null,{status:409});
      const text=Buffer.from(data.content,'base64').toString('utf8');
      files.set(name,{sha:createHash('sha1').update(text).digest('hex'),value:JSON.parse(text),content:data.content});
      return Response.json({ok:true});
    }
    assert.equal(url.searchParams.get('ref'),branch);
    if(!previous)return new Response(null,{status:404});
    return Response.json(options.headers.Accept==='application/vnd.github.raw+json'?previous.value:previous);
  };
  const date2='2026-11-24', date3='2026-11-25';
  const nextBook=target=>workbook(input().map(row=>{
    if(row[0]==='20261123'||row[0]===date) return [target,...row.slice(1)];
    return row;
  }));
  const upload=(target,opts={})=>{
    const bytes=opts.bytes||nextBook(target);
    return publishStageWmsDispatchExport({date:target,observedAt:opts.observedAt||observedAt,bytes,replaceSha256:opts.replaceSha256,
      sha256:createHash('sha256').update(bytes).digest('hex'),env:opts.env||env,fetchImpl});
  };

  const reader=()=>createStageWmsDispatchExportReader({env,fetchImpl,readSecret:async()=>assert.fail('no plaintext fallback')});
  assert.equal(await reader()(date2),null);
  await assert.rejects(upload(date2,{env:{...env,RENDER_SERVICE_ID:'other'}}),{code:'WMS_EXPORT_RELEASE_CONFIGURATION'});
  await assert.rejects(upload(date2,{env:{...env,OPSMAP_STAGE_WMS_DISPATCH_EXPORT_ARCHIVE_KEY_B64:Buffer.alloc(32,9).toString('base64')}}),
    {code:'WMS_EXPORT_ARCHIVE_INTEGRITY'});
  assert.equal(events.length,0);
  const localTime='2026-11-24T23:08:19.5824678+09:00';
  const [first,second]=await Promise.all([upload(date2,{observedAt:localTime}),upload(date3)]);
  assert.equal(first.state,'PUBLISHED');
  assert.equal(second.state,'PUBLISHED');
  for(const file of [...files.keys()].filter(f=>f.startsWith('release-2026-'))){
    assert.deepEqual(Object.keys(files.get(file).value).sort(),['ciphertext','nonce','schema','tag']);
  }
  const countsBefore=events.length;
  assert.equal((await upload(date2)).state,'VERIFIED_NOOP');
  assert.equal(events.length,countsBefore);
  await assert.rejects(upload(date),{code:'WMS_EXPORT_RELEASE_LEGACY_DATE'});
  const modified=input();
  modified[1][3]='440';
  const incompatible=workbook(modified.map(row=>row[0]===date||row[0]==='20261123'?[date2,...row.slice(1)]:row));
  await assert.rejects(upload(date2,{bytes:incompatible}),{code:'WMS_EXPORT_RELEASE_DATE_CONFLICT'});
  assert.equal(events.length,countsBefore);

  const staged=reader();
  assert.equal(staged.configurationFailure(date2),'WMS_EXPORT_DATE_NOT_APPROVED');
  assert.equal(staged.recoveryConfigurationFailure(date2),null);
  assert.equal(staged.recoveryConfigurationFailure(date2,{workbook:true}),'WMS_EXPORT_DATE_NOT_APPROVED');
  assert.equal(staged.recoveryConfigurationFailure('2026-02-31'),'WMS_EXPORT_DATE_NOT_APPROVED');
  const noKey=createStageWmsDispatchExportReader({env:{...env,OPSMAP_STAGE_WMS_DISPATCH_EXPORT_ARCHIVE_KEY_B64:''},fetchImpl});
  assert.equal(noKey.recoveryConfigurationFailure(date2),'WMS_EXPORT_DATE_NOT_APPROVED');
  assert.deepEqual(await staged.availableDates(),[date,date2,date3]);
  assert.equal((await staged(date)).total,1501);
  const localTimeRelease=await staged(date2);
  assert.equal(localTimeRelease.date,date2);
  assert.equal(localTimeRelease.observedAt,new Date(localTime).toISOString());
  assert.equal((await staged(date3)).total,1501);
  const department=createOpsmapDispatchReferenceReader({getPublication:()=>null,readWmsExport:staged});
  const result=await department.period(date3,7);
  const selected=result.dates.find(day=>day.date===date3);
  assert.equal(selected.wmsVerified,true);
  assert.deepEqual(selected.amounts,[['101',500],['208',900]]);

  const idx=files.get('release-index-v1.json');
  files.set('release-index-v1.json',{...idx,value:{...idx.value,tag:'0'.repeat(64)}});
  await assert.rejects(reader()(date2),{code:'WMS_EXPORT_RELEASE_INDEX_INVALID'});
  assert.equal((await reader()(date)).total,1501);
  files.set('release-index-v1.json',idx);
  const identified=[...files.keys()].find(name=>name.startsWith('release-'+date2+'-'));
  const doc=files.get(identified);
  files.set(identified,{...doc,value:{...doc.value,tag:'0'.repeat(32)}});
  await assert.rejects(reader()(date2),{code:'WMS_EXPORT_ARCHIVE_INTEGRITY'});
  files.set(identified,doc);

  const priorSha=idx.value.entries.find(entry=>entry.date===date2).sha256;
  const revisionTime='2026-11-26T03:20:00.000Z';
  const changeAmount=add=>{
    const corrected=input();
    for(const i of [1,3,5])corrected[i][0]=date2;
    for(const i of [1,2,7])corrected[i][3]=String(Number(corrected[i][3])+add);
    return workbook(corrected);
  };
  const bytes=changeAmount(20);
  const priorEvents=events.length;
  await assert.rejects(upload(date2,{bytes,replaceSha256:'a'.repeat(64),observedAt:revisionTime}),{code:'WMS_EXPORT_RELEASE_BASE_CHANGED'});
  await assert.rejects(upload(date2,{bytes,replaceSha256:priorSha,observedAt:localTime}),{code:'WMS_EXPORT_RELEASE_STALE'});
  await assert.rejects(upload('2026-11-26',{replaceSha256:priorSha,observedAt:revisionTime}),{code:'WMS_EXPORT_RELEASE_BASE_CHANGED'});
  assert.equal(events.length,priorEvents);
  const updates=await Promise.allSettled([bytes,changeAmount(30)].map(next=>upload(date2,{
    bytes:next,replaceSha256:priorSha,observedAt:revisionTime
  })));
  const successful=updates.find(result=>result.status==='fulfilled');
  const rejected=updates.find(result=>result.status==='rejected');
  assert.equal(successful.value.supersedes,priorSha);
  assert.equal(rejected.reason.code,'WMS_EXPORT_RELEASE_BASE_CHANGED');
  assert.deepEqual(files.get(identified),doc);
  const activeIndex=files.get('release-index-v1.json').value;
  assert.equal(activeIndex.entries.filter(entry=>entry.date===date2).length,1);
  assert.equal(activeIndex.entries.find(entry=>entry.date===date2).sha256,successful.value.sha256);
  const verified=await reader()(date2);
  assert.equal(verified.observedAt,revisionTime);
  assert.equal(verified.total,updates[0].status==='fulfilled'?1521:1531);
  assert.equal((await reader()(date3)).total,1501);

  const jsonEnv={...env,OPSMAP_STAGE_WMS_FRESHON_VALIDATION_APPROVED:'1',
    OPSMAP_STAGE_WMS_FRESHON_JSON_PUBLISH_APPROVED:'1'};
  const date4='2026-11-27', date5='2026-11-28';
  const original=workbook([
    ['입고요청일','확정호차','고객','매출금액','배송건수','고객주소','고객명','기준호차'],
    [date4,'101','S91001',450,1,address,'합성 매장','105'],
    ['','소계','',450,1],
    [date4,'','S91003',101,1,address,'합성 매장2','104'],
    ['','','',101,1],
    ['합계','','',551,2],
  ]);
  const originalRelease=await upload(date4,{bytes:original,observedAt:'2026-11-27T00:00:00.000Z'});
  let logins=0,sourceReads=0;
  const submit=(target,options={})=>syncStageFreshonWmsDispatch({
    date:target,observedAt:'2026-11-28T00:00:00Z',env:jsonEnv,archiveFetchImpl:fetchImpl,
    login:async()=>{logins++;return {cookie:'fixture-test-cookie'};},
    fetchImpl:async(url,opts)=>{
      sourceReads++;
      assert.equal(url,'https://mis.freshon.co.kr/bo/wm/dispatch/baecha_list');
      assert.equal(opts.redirect,'error');
      assert.equal(new URLSearchParams(opts.body).get('calStartDate'),target);
      const firstAmount=options.amount??450;
      return Response.json({data:[
        {stockDate:target,isSum:false,totalCnt:2,logCd:'011',estCd:'S91001',confirmCarSeq:'101',
          carSeq:'105',maechul:firstAmount,baesongCnt:1,estName:'합성 매장',address},
        {stockDate:'',isSum:false,totalCnt:0,maechul:firstAmount,baesongCnt:1},
        {stockDate:target,isSum:false,totalCnt:2,logCd:'011',estCd:'S91003',confirmCarSeq:'',
          carSeq:'104',maechul:101,baesongCnt:1,estName:'합성 매장2',address},
        {stockDate:'',isSum:false,totalCnt:0,maechul:101,baesongCnt:1},
      ]});
    },
    ...options,
  });
  await assert.rejects(submit(date5,{env:{...jsonEnv,OPSMAP_STAGE_WMS_FRESHON_JSON_PUBLISH_APPROVED:'0'}}),
    {code:'WMS_EXPORT_FRESHON_SCOPE'});
  await assert.rejects(submit(date5,{env:{...jsonEnv,OPSMAP_STAGE_WMS_DISPATCH_EXPORT_ARCHIVE_KEY_B64:Buffer.alloc(32,0xaa).toString('base64')}}),
    {code:'WMS_EXPORT_RELEASE_INDEX_INVALID'});
  assert.equal((await submit(date4)).state,'VERIFIED_NOOP');
  await assert.rejects(submit(date4,{replaceSha256:'f'.repeat(64)}),{code:'WMS_EXPORT_FRESHON_REPLACEMENT'});
  assert.deepEqual([logins,sourceReads],[0,0]);
  let beforeJson=events.length;
  const same=await submit(date4,{replaceSha256:originalRelease.sha256});
  assert.equal(same.state,'VERIFIED_NOOP');
  assert.equal(same.sha256,originalRelease.sha256);
  assert.equal(events.length,beforeJson);
  assert.deepEqual([logins,sourceReads],[1,1]);
  const newest=await submit(date5);
  assert.equal(newest.state,'PUBLISHED');
  assert.deepEqual([logins,sourceReads],[2,2]);
  const jsonRead=await reader()(date5);
  assert.equal(jsonRead.source,'WMS_CONFIRMED_DISPATCH_FRESHON_JSON');
  assert.equal(jsonRead.total,551);
  assert.equal(jsonRead.vehicles.find(row=>row.vehicle==='미배정').deliveryCount,1);
  assert.equal(jsonRead.vehicles.find(row=>row.vehicle==='101').details[0].addressHash,coordinateAddressHash(address));
  const jsonReference=createOpsmapDispatchReferenceReader({getPublication:()=>null,readWmsExport:reader()});
  const analyzed=(await jsonReference.period(date5,7)).dates.find(day=>day.date===date5);
  assert.equal(analyzed.dispatchScope,'WMS_EXPORT');
  assert.equal(analyzed.wmsVerified,true);
  beforeJson=events.length;
  assert.equal((await submit(date5)).state,'VERIFIED_NOOP');
  assert.equal(events.length,beforeJson);
  assert.deepEqual([logins,sourceReads],[2,2]);
  const oldPath=[...files.keys()].find(f=>f.startsWith('release-'+date4+'-'));
  const oldContent=files.get(oldPath);
  const change=await submit(date4,{replaceSha256:originalRelease.sha256,amount:451});
  assert.equal(change.supersedes,originalRelease.sha256);
  assert.deepEqual([logins,sourceReads],[3,3]);
  assert.deepEqual(files.get(oldPath),oldContent);
  assert.equal((await reader()(date4)).total,552);
  assert.equal((await reader()(date)).total,1501);
  const date6='2026-11-29';
  const simultaneous=await Promise.all([
    submit(date6,{observedAt:'2026-11-29T08:01:00Z'}),
    submit(date6,{observedAt:'2026-11-29T08:02:00Z'}),
  ]);
  assert.deepEqual(simultaneous.map(row=>row.state).sort(),['PUBLISHED','VERIFIED_NOOP']);
  assert.equal([...files.keys()].filter(name=>name.startsWith('release-'+date6+'-')).length,1);
  const restored=await submit(date4,{replaceSha256:change.sha256,amount:450,observedAt:'2026-11-29T08:01:00Z'});
  const restoredExisting=await submit(date4,{replaceSha256:restored.sha256,amount:451,observedAt:'2026-11-30T08:01:00Z'});
  assert.equal(restoredExisting.sha256,change.sha256);
  assert.equal((await reader()(date4)).observedAt,'2026-11-30T08:01:00.000Z');
  assert.equal([...files.keys()].filter(name=>name.startsWith('release-'+date4+'-')).length,3);
  assert.deepEqual(files.get(oldPath),oldContent);
  const jsonIndex=files.get('release-index-v1.json');
  const withoutType=jsonIndex.value.entries.map(({format,...entry})=>entry);
  files.set('release-index-v1.json',{...jsonIndex,value:{...jsonIndex.value,entries:withoutType}});
  await assert.rejects(reader()(date5),{code:'WMS_EXPORT_RELEASE_INDEX_INVALID'});
});
