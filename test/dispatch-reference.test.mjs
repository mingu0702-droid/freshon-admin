import test from 'node:test';
import assert from 'node:assert/strict';
import {createDispatchReference,compareDispatchRoutes,simulateDispatchTransfer} from '../public/opsmap/dispatch-reference.mjs';

const date='2026-11-20';
const points=[
  {customerCode:'S1',lat:37.1,lng:127.1,postalCode:'01234',coordinateStatus:'CONFIRMED'},
  {customerCode:'S2',lat:37.101,lng:127.1,postalCode:'01234',coordinateStatus:'CONFIRMED'},
  {customerCode:'S3',lat:37.102,lng:127.1,postalCode:'01235',coordinateStatus:'CONFIRMED'},
  {customerCode:'S4',lat:37.1,lng:127.1,postalCode:'01234',coordinateStatus:'CONFLICT'},
  {customerCode:'S5',lat:37.3,lng:127.1,postalCode:'01234',coordinateStatus:'CONFIRMED'}
];
const rows=[{customerCode:'S1',vehicle:'101'},...points.slice(1).map(({customerCode})=>({customerCode,vehicle:'102'}))];
const details=[{customerCode:'S2',amount:10},{customerCode:'S3',amount:30},{customerCode:'S4',amount:5},{customerCode:'S5',amount:5}];
const target={vehicle:'101',amount:100,detailState:'UNAVAILABLE'};
const source={vehicle:'102',amount:50,detailState:'VERIFIED',detailRows:details};
const day=(overrides={})=>({date,center:'osan',route:{state:'VERIFIED',rows},
  amounts:{date,state:'VERIFIED',vehicles:[target,source]},...overrides});

test('Osan comparison uses verified geodesic locations while keeping postal overlap independent',()=>{
  const model=createDispatchReference(day(),points,date);
  const pair=compareDispatchRoutes(model,'101','102',.5);
  assert.deepEqual(pair.sharedPostalCodes,['01234']);
  assert.deepEqual(pair.candidates.map(row=>row.customerCode),['S2','S3']);
  assert.ok(pair.minimumKm>.11&&pair.minimumKm<.112);
  assert.deepEqual(compareDispatchRoutes(model,'101','102',.5,30).candidates.map(row=>row.customerCode),['S3','S2']);
  assert.deepEqual(compareDispatchRoutes(model,'101','102',.05).candidates,[]);
  assert.throws(()=>createDispatchReference(day({center:'honam'}),points,date),/SCOPE/);
  assert.throws(()=>createDispatchReference(day(),points,'2026-11-21'),/SCOPE/);
});

test('missing, mismatched and inconsistent amounts stay unknown and prevent simulated changes',()=>{
  const model=createDispatchReference(day({amounts:{date:'2026-11-19',state:'VERIFIED',vehicles:[target,source]}}),points,date);
  assert.equal(model.amountsVerified,false);
  assert.equal(model.vehicles.get('101').amount,null);
  assert.equal(simulateDispatchTransfer(compareDispatchRoutes(model,'101','102',.5),'S2'),null);
  const mismatched={...source,detailRows:details.slice(0,3)};
  const partial=createDispatchReference(day({amounts:{date,state:'VERIFIED',vehicles:[target,mismatched]}}),points,date);
  assert.equal(partial.vehicles.get('102').amount,50);
  assert.equal(partial.vehicles.get('102').detailSummary.missing,1);
  assert.equal(partial.vehicles.get('102').detailSummary.difference,partial.vehicles.get('102').amount-details.slice(0,3).reduce((total,row)=>total+row.amount,0));
  assert.equal(simulateDispatchTransfer(compareDispatchRoutes(partial,'101','102',.5),'S2'),null);
});

test('verified hypothetical transfer preserves total amount and keeps the loaded data untouched',()=>{
  const input=day(), before=JSON.stringify(input);
  const model=createDispatchReference(input,points,date);
  const pair=compareDispatchRoutes(model,'101','102',.5);
  assert.deepEqual(simulateDispatchTransfer(pair,'S2'),{targetAmount:110,sourceAmount:40,targetCount:2,sourceCount:3});
  assert.equal(simulateDispatchTransfer(pair,'S5'),null);
  assert.equal(JSON.stringify(input),before);
  assert.equal(model.vehicles.get('101').amount,100);
  assert.equal(model.vehicles.get('102').storeCount,4);
});

test('partial historical observations show route points without deriving total stops or hypothetical amounts',()=>{
  const input=day();
  input.route.state='PARTIAL';
  const model=createDispatchReference(input,points,date);
  const pair=compareDispatchRoutes(model,'101','102',.5);
  assert.equal(model.routeState,'PARTIAL');
  assert.equal(model.vehicles.get('101').storeCount,null);
  assert(pair.candidates.some(row=>row.customerCode==='S2'));
  assert.equal(simulateDispatchTransfer(pair,'S2'),null);
});
