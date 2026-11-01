import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import {staffCustomerDetail} from '../src/mapStaffDetail.js';
test('explicit protected key labels stay separate; unobserved prose is not a credential',()=>{
 const r=staffCustomerDetail({accessMemo:'비밀번호: SYNTHETIC_DOOR\n보안키: SYNTHETIC_SECURITY\n일반 키: SYNTHETIC_GENERAL'},{customerCode:'S970001',date:'2026-10-23'});assert.equal(r.password,'SYNTHETIC_DOOR');assert.equal(r.securityKey,'SYNTHETIC_SECURITY');assert.equal(r.generalKey,'SYNTHETIC_GENERAL');
 const unknown=staffCustomerDetail({accessMemo:'SYNTHETIC_UNLABELLED'},{customerCode:'S970001',date:'2026-10-23'});assert.equal(unknown.securityKey,null);assert.equal(unknown.generalKey,null);assert.equal(unknown.password,null);
});
test('read-only batch keys reject wrong source ranges and preserve sparse row identities',()=>{
 const src=fs.readFileSync(new URL('../integrations/hub/protected-reader/ReadOnlySheets.js',import.meta.url),'utf8');let wrong=false;
 const context=vm.createContext({Sheets:{Spreadsheets:{Values:{batchGet:(_id,p)=>({valueRanges:p.ranges.slice().reverse().map((range,i)=>({range:wrong?range.replace('daily_routes','OTHER'):range,values:[[i+1]]}))})}}}});vm.runInContext(src,context);vm.runInContext("protectedReaderSheetTitles_['SYNTHETIC_BOOK:7']='daily_routes'",context);
 const filters=[{gridRange:{sheetId:7,startRowIndex:9,endRowIndex:10,startColumnIndex:0,endColumnIndex:1}},{gridRange:{sheetId:7,startRowIndex:11,endRowIndex:12,startColumnIndex:7,endColumnIndex:8}}];const out=context.protectedReaderBatchKeys_('SYNTHETIC_BOOK',7,filters);assert.equal(out.valueRanges.length,2);assert.equal(out.valueRanges[0].dataFilters[0].gridRange.startRowIndex,11);wrong=true;assert.throws(()=>context.protectedReaderBatchKeys_('SYNTHETIC_BOOK',7,filters),/HISTORY_RANGE_IDENTITY/);
});
test('historical customer rows use one bounded date-only read before the unchanged protected-row cap',()=>{
 const src=fs.readFileSync(new URL('../integrations/hub/protected-reader/ReadOnlySheets.js',import.meta.url),'utf8'),ranges=[];const context=vm.createContext({protectedReaderProfile_:null,Sheets:{Spreadsheets:{Values:{get:(_id,range)=>{ranges.push(range);return {values:Array.from({length:201},(_,i)=>[i===149?'2026-10-23':'2026-10-22'])};}}}}});vm.runInContext(src,context);vm.runInContext("protectedReaderSheetTitles_['SYNTHETIC_BOOK:7']='daily_routes'",context);context.hubStaffHistoryDate_=v=>v;
 const rows=context.protectedReaderDateScopedRows_('SYNTHETIC_BOOK',7,['deliveryDate','customerCode'],Array.from({length:201},(_,i)=>i+2),'2026-10-23');assert.deepEqual([...rows],[151]);assert.deepEqual(ranges,["'daily_routes'!A2:A202"]);
});
