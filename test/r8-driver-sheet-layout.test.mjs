import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDriverSheetValues} from '../src/driverSheetRows.js';
const make = () => {
 const title=[],headers=[],row=[];title[0]='SFN 기사연락처';title[20]='종료 예정 기사';title[28]='매장정보 취합 현황';
 for(const [block,start] of [0,5,10,15,20].entries()){
  ['호차','기사명','연락처','운수사'].forEach((label,offset)=>headers[start+offset]=label);
  row[start]=String(900+block);row[start+1]='합성기사'+block;row[start+2]=['010','0000',String(block).padStart(4,'0')].join('-');row[start+3]='합성운수';
 }
 headers[24]='신청일자';headers[25]='종료날짜';headers[26]='카운트';headers[27]='비고';headers[28]='총인원';headers[29]='97';
 return [title,headers,row];
};
test('four horizontal active blocks retain fourth block and exclude future termination contacts',()=>{
 const source=make(),result=parseDriverSheetValues(source);
 assert.equal(result.rows.length,4);assert.deepEqual(result.rows.map(row=>row.호차),['900','901','902','903']);
 for(let block=0;block<4;block++)assert.equal(result.rows[block].연락처,source[2][block*5+2]);
 assert.equal(result.rows.some(row=>row.호차==='904'),false);assert.equal(result.meta.headerRow,2);assert.equal(result.meta.effectiveDateAvailable,false);
 assert.equal(result.rows.some(row=>Object.hasOwn(row,'적용일')),false);
});
test('sparse header spacing and empty contact fields never shift columns',()=>{
 const source=make();source[2][2]='';source[2][7]='';
 const result=parseDriverSheetValues(source);assert.equal(result.rows[0].연락처,'');assert.equal(result.rows[0].운수사,'합성운수');assert.equal(result.rows[1].연락처,'');assert.equal(result.rows[1]._sourceColumn,6);
});
test('title row, empty rows, repeated headers and orphan contacts do not become assignments',()=>{
 const source=make();source.push([],source[1]);const orphan=[];orphan[1]='미지정합성기사';orphan[2]=['010','0000','9999'].join('-');source.push(orphan);
 const result=parseDriverSheetValues(source);assert.equal(result.rows.length,4);assert.equal(result.meta.skippedRepeatedHeaders,4);assert.equal(result.meta.skippedUnassignedRecords,1);
});
test('missing fourth block header is an explicit contract failure rather than a complete partial source',()=>{
 const source=make();source[1][17]='';assert.throws(()=>parseDriverSheetValues(source),e=>e.code==='DRIVER_SHEET_HEADER_UNRECOGNIZED');
});
test('existing flat single-table layout still reads contacts without inventing effective dates',()=>{
 const result=parseDriverSheetValues([['호차','기사명','연락처','운수사'],['999','합성기사',['010','0000','9999'].join('-'),'합성운수']]);assert.equal(result.rows.length,1);assert.equal(result.meta.headerRow,1);assert.equal(result.meta.layout,'SINGLE_CONTACT_TABLE');assert.equal(result.meta.effectiveDateAvailable,false);
});
test('existing flat aliases and actual effective-date column remain supported without collapsing blanks',()=>{
 const source=[['차량','','기사 이름','전화번호','적용일자','차량톤수'],['999','','합성기사',['010','0000','9999'].join('-'),'2026-10-01','1']];
 const result=parseDriverSheetValues(source);assert.equal(result.rows[0].기사명,'합성기사');assert.equal(result.rows[0].연락처,source[1][3]);assert.equal(result.rows[0].적용일,'2026-10-01');assert.equal(result.meta.effectiveDateAvailable,true);
});
