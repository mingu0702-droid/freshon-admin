import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../public/opsmap/map-phase2b-runtime.js',import.meta.url),'utf8');
const body=source.slice(source.indexOf('function scheduleVisibleAddressRows('),source.indexOf('\n  async function syncCustomerRegistry('));
const rows=[{customerCode:'S990001',lat:null,lng:null},{customerCode:'S990002',lat:37,lng:127},{customerCode:'S990003',customerOnly:true,lat:null,lng:null}];
function run(summary,selected){let result;const schedule=vm.runInNewContext('('+body+')',{customerRegistry:{summary:()=>summary,locationRows:rows=>rows},state:{selected},registrySelection:()=>({}),liveAddressLocations:{schedule:(rows,options)=>{result={codes:rows.map(r=>r.customerCode),priority:options?.priority===true};}}});schedule(rows);return JSON.parse(JSON.stringify(result));}
test('initial bulk loading defers duplicate private address reads without changing located rows',()=>{
 for(const status of ['idle','loading'])assert.deepEqual(run({status,complete:false}),{codes:[],priority:true});
});
test('an explicitly selected store may still resolve while the Customer projection loads',()=>{
 assert.deepEqual(run({status:'loading',complete:false},rows[0]),{codes:['S990001'],priority:true});
});
test('completed projection and failed registry retain observed and Customer-only location scheduling',()=>{
 for(const summary of [{status:'ready',complete:true},{status:'failed',complete:false}])assert.deepEqual(run(summary),{codes:['S990001','S990003'],priority:false});
});
