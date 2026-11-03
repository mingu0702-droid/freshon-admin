import test from 'node:test';
import assert from 'node:assert/strict';
import {buildVehiclePrintModel,validPrintDate,validateDatedPrintResponse,PRINT_UNPROVIDED_CENTER} from '../public/opsmap/map-print-ui.mjs';
const master={version:'a'.repeat(64),checkedAt:'2026-11-04T00:00:00Z',stale:false};
const fixed=(code,car='2',center='osan',extra={})=>({customerCode:code,customerName:'합성 테스트 매장',address:'경기도 오산시 합성로 10',baseVehicle:car,baseVehicleGroup:center,baseVehicleState:'VERIFIED_MASTER',baseVehicleSource:'FIXED_DISPATCH_PRIMARY',baseVehicleVersion:master.version,baseVehicleCheckedAt:master.checkedAt,baseVehicleStale:false,lat:37.1,lng:127.1,...extra});
const build=(rows,extra={})=>buildVehiclePrintModel({basis:'FIXED',date:'2026-11-04',nowDate:'2026-11-04',center:'osan',selectedVehicle:'2',master,rows,...extra});
test('prints only the exact verified center/vehicle and allowlisted fields, without fabricated order',()=>{
 const model=build([fixed('S100', '2','osan',{phone:'010-1111-2222',password:'secret',raw:{doorPassword:'9999'},order:4}),fixed('S200','20'),fixed('S300','2','honam'),fixed('S400','2','osan',{baseVehicleState:'UNKNOWN'})]);
 assert.deepEqual(model.stores.map(r=>r.customerCode),['S100']);assert.equal(model.stores[0].order,null);assert.equal(JSON.stringify(model).includes('secret'),false);assert.equal(JSON.stringify(model).includes('010-1111'),false);assert.equal(JSON.stringify(model).includes('9999'),false);
});
test('fixed assignment conflict or master version mismatch cannot leak a store from another car',()=>{
 assert.equal(build([fixed('S100'),fixed('S100','20'),fixed('S200','2','osan',{baseVehicleVersion:'b'.repeat(64)})]).stores.length,0);
 assert.equal(build([fixed('S100')],{master:{...master,stale:true}}).stale,true);
});
test('dated response requires exact date and complete untruncated metadata',()=>{
 const payload={ok:true,data:[{customerCode:'S100',deliveryDate:'2026-11-03'}],meta:{date:'2026-11-03',complete:true}};
 assert.equal(validateDatedPrintResponse(payload,'2026-11-03').length,1);
 for(const bad of [{...payload,meta:{...payload.meta,date:'2026-11-02'}},{...payload,meta:{...payload.meta,hasMore:true}},{...payload,meta:{...payload.meta,truncated:true}},{...payload,data:[{customerCode:'S100'}]}])assert.throws(()=>validateDatedPrintResponse(bad,'2026-11-03'),/DATE_UNVERIFIED/);
});
test('dated scope retains recorded visit order and unlocated stores, never borrowing fixed assignment',()=>{
 const rows=[{customerCode:'S100',customerName:'합성1',address:'합성주소1',deliveryDate:'2026-11-03',vehicle:'2',vehicleGroup:'osan',order:7,lat:37,lng:127},{customerCode:'S200',customerName:'합성2',deliveryDate:'2026-11-03',vehicle:'2',dispatchCenterCode:'011',order:2},{customerCode:'S300',deliveryDate:'2026-11-03',vehicle:'20',vehicleGroup:'osan',baseVehicle:'2'},{customerCode:'S400',deliveryDate:'2026-11-03',vehicle:'2',baseVehicleGroup:'osan'}];
 const model=build(rows,{basis:'DATED',date:'2026-11-03'});assert.deepEqual(model.stores.map(r=>[r.customerCode,r.order]),[['S200',2],['S100',7]]);assert.equal(model.unlocatedCount,1);assert.equal(model.checkedAt,null);
 assert.throws(()=>build(rows,{basis:'DATED',date:'2026-11-04'}),/DATE_UNVERIFIED/);
});
test('invalid dates, coordinate conflicts and impossible points stay excluded',()=>{
 assert.equal(validPrintDate('2026-02-30'),false);assert.throws(()=>build([],{date:'2026-11-05'}),/SELECTION_REQUIRED/);
 const m=build([fixed('S100','2','osan',{coordinateStatus:'CONFLICT'}),fixed('S200','2','osan',{lat:0,lng:0})]);assert.equal(m.locatedCount,0);assert.equal(m.stores.length,2);
});
test('dated center omitted at source has an explicit scope isolated from known centers and fixed master',()=>{
 const row={customerCode:'S100',customerName:'합성 원천 센터 미제공',address:'합성 검증주소',deliveryDate:'2026-11-03',vehicle:'2',sequence:4,baseVehicleGroup:'honam'};
 const rows=[row,{...row,customerCode:'S101',vehicle:'20'},{...row,customerCode:'S102',vehicleGroup:'osan'},{...row,customerCode:'S103',centerCode:'013'},{...row,customerCode:'S104',center:'UNRECOGNIZED'}];
 const unknown=build(rows,{basis:'DATED',date:'2026-11-03',center:PRINT_UNPROVIDED_CENTER});
 assert.deepEqual(unknown.stores.map(r=>[r.customerCode,r.order]),[['S100',4]]);assert.match(unknown.centerName,/센터 미구분.*원천 미제공/);assert.match(unknown.note,/현재 기준호차 센터로 추정하지/);
 assert.deepEqual(build(rows,{basis:'DATED',date:'2026-11-03',center:'osan'}).stores.map(r=>r.customerCode),['S102']);
 assert.throws(()=>build([fixed('S100')],{center:PRINT_UNPROVIDED_CENTER}),/SELECTION_REQUIRED/);
 assert.throws(()=>build(rows,{basis:'DATED',date:'2026-11-04',center:PRINT_UNPROVIDED_CENTER}),/DATE_UNVERIFIED/);
});
