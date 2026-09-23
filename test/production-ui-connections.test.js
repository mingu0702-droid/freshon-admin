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
test('late empty/unverified base responses cannot erase verified master',()=>{
  const old=new Map([['S1',{customerCode:'S1',baseVehicle:'221',baseVehicleState:'VERIFIED_MASTER'}]]);
  for(const incoming of [{baseVehicle:''},{baseVehicle:'838',baseVehicleState:'VERIFIED_STORED'}])assert.equal(ui.mergeBaseVehicles(old,[{customerCode:'S1',...incoming}]).get('S1').baseVehicle,'221');
  assert.equal(ui.mergeBaseVehicles(old,[{customerCode:'S1',baseVehicle:'222',baseVehicleState:'VERIFIED_MASTER'}]).get('S1').baseVehicle,'222');
  assert.equal(ui.baseVehicleLabel({baseVehicleState:'UNASSIGNED'}),'미지정');assert.equal(ui.baseVehicleLabel({baseVehicleState:'UNKNOWN'}),'확인 필요');
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
