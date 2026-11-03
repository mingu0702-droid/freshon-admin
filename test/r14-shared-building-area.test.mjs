import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const context={};vm.runInNewContext(fs.readFileSync(new URL('../public/opsmap/new-area-requests.js',import.meta.url),'utf8'),context);
const resolve=context.NewAreaRequests.singleStoredLocation;
test('co-located stores retain every customer identity while reusing one exact stored location',()=>{
 const rows=[{customerCode:'S990001',lat:37,lng:127},{customerCode:'S990002',lat:37,lng:127}],before=JSON.stringify(rows),point=resolve(rows);
 assert.equal(point.lat,37);assert.equal(point.lng,127);assert.deepEqual(Array.from(point.coordinateReferenceCustomers),['S990001','S990002']);assert.equal(JSON.stringify(rows),before);
});
test('different or invalid stored points remain candidates without averaging or guessing',()=>{
 for(const rows of [[{lat:37,lng:127},{lat:37.00001,lng:127}],[{lat:null,lng:127}],[{lat:NaN,lng:127}]])assert.equal(resolve(rows).candidates,rows);
 assert.equal(resolve([]),null);
});
