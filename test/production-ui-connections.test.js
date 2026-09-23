import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {projectFixedVehicles,createFixedVehicleReader} from '../src/fixedVehicleProjection.js';
import '../public/map-period-ui.js';
const ui=globalThis.MapPeriodUi;
test('fixed primary outranks actual/rental and Sunday assignment, never customer-specific hardcoding',()=>{
  for(const customerCode of ['S99731','S10001']){
    const [row]=projectFixedVehicles([{estCd:customerCode,mainCarSeqNm:'221',carSeqSunNm:'838',carSeqMonNm:'222',password:'synthetic-private'}]);
    assert.equal(row.baseVehicle,'221');assert.equal(row.weekdays.Mon,'222');assert.equal(row.weekdays.Sun,'838');
    assert.equal(row.baseVehicleState,'VERIFIED_MASTER');assert.equal('password' in row,false);
  }
});
test('missing primary is not inferred from weekday or delivery assignment; conflicts explicit',()=>{
  assert.equal(projectFixedVehicles([{estCd:'S1',carSeqMonNm:'838'}])[0].baseVehicleState,'UNASSIGNED');
  assert.equal(projectFixedVehicles([{estCd:'S1',mainCarSeqNm:'221'},{estCd:'S1',mainCarSeqNm:'222'}])[0].baseVehicleState,'CONFLICT');
});
test('fixed master reader uses read-only bounded center batches, strips sensitive fields',async()=>{
  const calls=[];const reader=createFixedVehicleReader({ensureSession:async()=>{},extractRows:p=>p.data,readJson:async(url,options)=>{
    calls.push({url,form:new URLSearchParams(options.body)});return {data:[{estCd:'S'+(calls.length+1),mainCarSeqNm:'221',accessInfo:'synthetic-private'}]};
  }});
  const result=await reader();assert.equal(result.data.length,3);assert.deepEqual(calls.map(x=>x.form.get('logCd')),['011','012','013']);
  assert.ok(calls.every(x=>x.url==='/bo/wm/standard/fixedAlctnList'&&x.form.get('size')==='1000'));
  assert.equal(JSON.stringify(result).includes('synthetic-private'),false);
});

test('expired fixed master session refreshes existing login once; no raw error returned',async()=>{
 const sessions=[];let calls=0;
 const reader=createFixedVehicleReader({ensureSession:async force=>sessions.push(!!force),extractRows:p=>p.data,readJson:async()=>{
  if(++calls===1)throw Object.assign(Error('PRIVATE_RESPONSE_NEVER_EXPOSE'),{status:401});
  return {data:[{estCd:'S'+calls,mainCarSeqNm:'221'}]};
 }});
 const result=await reader();assert.deepEqual(sessions,[false,true]);assert.equal(result.meta.firstHttp,401);assert.equal(result.meta.readHttp,200);assert.equal(result.meta.authRetried,true);
 assert.equal(JSON.stringify(result).includes('PRIVATE_RESPONSE'),false);
});
test('fixed master direct data array bypasses daily paging-row filter without leaking fields',async()=>{
 let fallbackCalls=0;
 const reader=createFixedVehicleReader({ensureSession:async()=>{},extractRows:()=>{fallbackCalls++;return [];},readJson:async(_url,options)=>({status:200,data:new URLSearchParams(options.body).get('logCd')==='011'?[{estCd:'S10001',mainCarSeqNm:'221',totalCnt:1,totalPages:1,isPaging:true,sortName:'est_cd',password:'SYNTHETIC_PRIVATE'}]:[]})});
 const result=await reader();assert.equal(fallbackCalls,0);assert.equal(result.data.length,1);assert.equal(result.data[0].baseVehicle,'221');assert.equal(result.meta.sourceRows,1);assert.equal(result.meta.pagingFieldRows,1);assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE'),false);
});
test('an empty fixed master data array never falls back to unrelated nested rows',async()=>{
 let fallbackCalls=0;
 const reader=createFixedVehicleReader({ensureSession:async()=>{},extractRows:()=>{fallbackCalls++;return [{estCd:'S1',mainCarSeqNm:'999'}];},readJson:async()=>({status:200,data:[]})});
 await assert.rejects(reader(),e=>e.code==='FIXED_MASTER_EMPTY');assert.equal(fallbackCalls,0);
});
test('fixed master covers more than 20000 rows using existing bounded 120-page contract',async()=>{
 const pages=[];const reader=createFixedVehicleReader({ensureSession:async()=>{},extractRows:()=>[],readJson:async(_url,options)=>{
  const q=new URLSearchParams(options.body),page=Number(q.get('page'));pages.push({center:q.get('logCd'),page});
  return {data:q.get('logCd')==='011'?Array.from({length:page<21?1000:7},(_,i)=>({estCd:'S'+(page*1000+i+1),mainCarSeqNm:'221'})):[]};
 }});
 const result=await reader();assert.equal(result.data.length,21007);assert.equal(result.meta.sourceRows,21007);assert.equal(pages.length,24);assert.equal(pages.filter(p=>p.center==='011').at(-1).page,21);
});
test('fixed master never publishes a partial result when the 120-page bound is exhausted',async()=>{
 let calls=0;const reader=createFixedVehicleReader({ensureSession:async()=>{},extractRows:()=>[],readJson:async()=>{calls++;return{data:Array.from({length:1000},()=>({estCd:'S1',mainCarSeqNm:'221'}))};}});
 await assert.rejects(reader(),e=>e.code==='FIXED_MASTER_INCOMPLETE');assert.equal(calls,120);
});
for(const status of [401,403])test('fixed master repeated '+status+' is bounded, classified, never permission bypass',async()=>{
 let calls=0;const sessions=[];const reader=createFixedVehicleReader({ensureSession:async force=>sessions.push(!!force),extractRows:()=>[],readJson:async()=>{calls++;throw Object.assign(Error('PRIVATE_BODY'),{status});}});
 await assert.rejects(reader(),e=>e.status===status&&e.code===(status===401?'FIXED_MASTER_AUTH_REQUIRED':'FIXED_MASTER_FORBIDDEN')&&!e.message.includes('PRIVATE_BODY'));
 assert.equal(calls,status===401?2:1);assert.equal(sessions.length,status===401?2:1);
});
test('login HTML preserves actual HTTP separately from authentication classification',async()=>{
 let calls=0;
 const reader=createFixedVehicleReader({ensureSession:async()=>{},extractRows:p=>p.data,readJson:async()=>{
  if(++calls===1)throw Object.assign(Error('PRIVATE_BODY'),{status:401,diagnostic:{status:200,type:'html-or-login-response'},payload:{raw:'<form action="loginProcessing">SYNTHETIC</form>'}});
  return {data:[{estCd:'S'+calls,mainCarSeqNm:'221'}]};
 }});
 const result=await reader();assert.equal(result.meta.firstHttp,200);assert.equal(result.meta.authReason,'HTML_OR_LOGIN');assert.equal(result.meta.readHttp,200);
 assert.equal(JSON.stringify(result).includes('PRIVATE_BODY'),false);
});

test('local master timeout retries only the failed page, never reports synthetic upstream 504',async()=>{
 const calls=[],waits=[];let attempts=0;
 const reader=createFixedVehicleReader({ensureSession:async()=>{},sleep:async ms=>waits.push(ms),extractRows:()=>[],readJson:async(_url,options)=>{
  const q=new URLSearchParams(options.body),page=Number(q.get('page')),center=q.get('logCd');calls.push(center+':'+page);
  if(center==='011'&&page===1&&++attempts<3)throw Object.assign(Error('Freshon request timed out after 25s (/synthetic)'),{status:504});
  return {data:center==='011'?Array.from({length:page===0?1000:1},(_,i)=>({estCd:'S'+(page*1000+i+1),mainCarSeqNm:'221'})):[]};
 }});
 const result=await reader();assert.equal(result.data.length,1001);assert.equal(calls.filter(x=>x==='011:0').length,1);assert.equal(calls.filter(x=>x==='011:1').length,3);assert.deepEqual(waits,[1000,2000]);assert.equal(reader.getProgress().retries,2);assert.equal(reader.getProgress().phase,'DONE');
});

test('exhausted local timeout is bounded and carries no original message or synthetic HTTP',async()=>{
 let calls=0;const reader=createFixedVehicleReader({ensureSession:async()=>{},sleep:async()=>{},extractRows:()=>[],readJson:async()=>{calls++;throw Object.assign(Error('Freshon request timed out after 25s (/synthetic-private)'),{status:504});}});
 await assert.rejects(reader(),e=>e.code==='FIXED_MASTER_LOCAL_TIMEOUT'&&e.status===0&&e.kind==='LOCAL_TIMEOUT'&&!e.message.includes('synthetic-private'));assert.equal(calls,3);
});

for(const status of [429,502,504])test('actual upstream '+status+' uses bounded same-page retries without authentication refresh',async()=>{
 let calls=0,login=0;const reader=createFixedVehicleReader({ensureSession:async()=>login++,sleep:async()=>{},extractRows:()=>[],readJson:async()=>{calls++;throw Object.assign(Error('PRIVATE_BODY'),{status,diagnostic:{type:'http-error',status}});}});
 await assert.rejects(reader(),e=>e.status===status&&e.kind==='UPSTREAM_HTTP'&&!e.message.includes('PRIVATE_BODY'));assert.equal(calls,3);assert.equal(login,1);
});
test('late empty/unverified base responses cannot erase verified master',()=>{
  const old=new Map([['S1',{customerCode:'S1',baseVehicle:'221',baseVehicleState:'VERIFIED_MASTER'}]]);
  for(const incoming of [{baseVehicle:''},{baseVehicle:'838',baseVehicleState:'VERIFIED_STORED'}])assert.equal(ui.mergeBaseVehicles(old,[{customerCode:'S1',...incoming}]).get('S1').baseVehicle,'221');
  assert.equal(ui.mergeBaseVehicles(old,[{customerCode:'S1',baseVehicle:'222',baseVehicleState:'VERIFIED_MASTER'}]).get('S1').baseVehicle,'222');
  assert.equal(ui.baseVehicleLabel({baseVehicleState:'UNASSIGNED'}),'미지정');assert.equal(ui.baseVehicleLabel({baseVehicleState:'UNKNOWN'}),'확인 필요');
});
for(const http of [200,403,500])test('non-login HTML '+http+' is classified by actual HTTP without login retry',async()=>{
 let reads=0,login=0;const reader=createFixedVehicleReader({ensureSession:async()=>login++,extractRows:()=>[],readJson:async()=>{reads++;throw Object.assign(Error('PRIVATE_BODY'),{status:401,diagnostic:{status:http,type:'html-or-login-response'},payload:{raw:'<html>generic error</html>'}});}});
 await assert.rejects(reader(),e=>e.status===http&&e.code===(http===403?'FIXED_MASTER_FORBIDDEN':'FIXED_MASTER_NON_JSON'));
 assert.equal(reads,1);assert.equal(login,1);
});
test('base pins/card/filter agree while driver mode keeps actual historical vehicle',()=>{
  const rows=[{customerCode:'S99731',baseVehicle:'221',history:[{vehicle:'838',driverKey:'D',deliveryDate:'2026-09-19'}]}];
  assert.equal(ui.select(rows,['221'],'',{vehicleBasis:'base'})[0].vehicle,'221');
  assert.equal(ui.select(rows,['838'],'',{vehicleBasis:'base'}).length,0);
  assert.equal(ui.select(rows,[],'D')[0].vehicle,'838');
});
test('TSV retains blank rows/cells, duplicates, original text and quoted multiline Y',()=>{
  const rows=ui.parseAreaInput('  부산광역시 가로 1  \t"고객\n2층"\r\n\t\r\n경기도 광주시 1\t\r\n경기도 광주시 1\t');
  assert.equal(rows.length,4);assert.equal(rows[0].originalAddress,'  부산광역시 가로 1  ');assert.equal(rows[0].customer,'고객\n2층');
  assert.equal(rows[1].address,'');assert.equal(rows[2].originalCustomer,'');assert.equal(rows[3].address,rows[2].address);
});
test('clipboard BV:BY is four columns and BJ:BK is two columns, no headers, chosen application date',()=>{
  const rows=[{address:'부산광역시 가로 1',customer:'고객',decision:'O',reason:'',rangeEnd:'2026-09-19',nearby:[{customerName:'배송처'}],nearestDistance:0.12349},
    {address:'경기도 광주시 1',decision:'검토',reason:'해당 센터 비교자료 부족',nearestDistance:null}];
  assert.equal(ui.areaTsv(rows,'2026-10-02','decision'),'O\t\t10-2\t영남권\r\n검토필요\t검토필요\t10-2\t');
  assert.equal(ui.areaTsv(rows,'2026-10-02','matching'),'배송처\t0.123\r\n\t');
  assert.equal(ui.areaExportRows(rows,'2026-10-02')[0].length,9);
});
test('normalized province separates Gyeonggi Gwangju from Gwangju metro',()=>{
  for(const [address,region] of [['경기도 광주시 가로 1',''],['광주광역시 서구 가로 1','호남권'],['전북특별자치도 전주시','호남권'],['경상남도 창원시','영남권'],['제주특별자치도 제주시','제주도']])assert.equal(ui.regionForAddress(address),region);
});
test('single auxiliary host and no scrollIntoView/camera-fit-on-card; protected values stay out of basic card',()=>{
  const runtime=fs.readFileSync(new URL('../public/map-phase2b-runtime.js',import.meta.url),'utf8');
  const html=fs.readFileSync(new URL('../public/map-phase2b-preview.html',import.meta.url),'utf8');
  assert.equal((html.match(/id="staffAuxContent"/g)||[]).length,1);assert.ok(!runtime.includes('scrollIntoView'));
  assert.ok(!runtime.includes('id="staffHistoryContent"'));assert.ok(!runtime.includes('id="staffNotesContent"'));
  const card=runtime.slice(runtime.indexOf('$("#detail").innerHTML'),runtime.indexOf('requestAnimationFrame(positionDetailPopup)',runtime.indexOf('$("#detail").innerHTML')));
  assert.ok(!card.includes('baseVehicleSource'));assert.ok(!card.includes('row.driverName'));
});
