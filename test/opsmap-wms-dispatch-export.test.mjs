import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import XLSX from 'xlsx';
import { createStageWmsDispatchExportReader, parseOpsmapWmsDispatchExport, projectOpsmapWmsDispatch,
  sealOpsmapWmsDispatchExport } from '../src/opsmapWmsDispatchExport.js';
import { createOpsmapDispatchReferenceReader } from '../src/opsmapDispatchReference.js';
import { coordinateAddressHash } from '../src/opsmap-abc/opsmapAutoCoordinates.js';
import { STAGE_ORIGIN, STAGE_SERVICE } from '../src/stageScope.js';

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
  assert.equal(await blocked(date),null);
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
  assert.equal(await read('2026-11-22'),null);
  assert.equal(await reader({RENDER_SERVICE_ID:'other-service'})(date),null);
  assert.equal(calls.length,0);
  assert.equal((await read(date)).vehicles[0].amount,500);
  assert.equal((await read(date)).date,date);
  assert.equal(calls.length,2);

  const changed={...manifest,sha256:'a'.repeat(64)};
  await assert.rejects(reader({OPSMAP_STAGE_WMS_DISPATCH_EXPORTS_JSON:JSON.stringify({[date]:changed})})(date),
    {code:'WMS_EXPORT_ARCHIVE_INTEGRITY'});
  response={...archive,tag:'0'.repeat(32)};
  await assert.rejects(reader()(date),{code:'WMS_EXPORT_ARCHIVE_INTEGRITY'});

  privateRepo=false;
  calls.length=0;
  await assert.rejects(reader()(date),{code:'WMS_EXPORT_ARCHIVE_READ'});
  assert.deepEqual(calls,[root]);
});
