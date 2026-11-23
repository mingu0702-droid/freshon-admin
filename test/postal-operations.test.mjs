import assert from 'node:assert/strict';
import test from 'node:test';
import {projectPostalOperations} from '../src/shadowCoverage/postalOperations.js';

const order='order_confirmed', dispatch='dispatch_confirmed', delivery='delivery_completed';
const dates=(date,centerKey,entries)=>({date,centerKey,rows:entries.map(([customerCode,evidence])=>({customerCode,evidence}))});
const assignments=new Map([
  ['S1',{area:6241,registered:true,center:0}], ['S2',{area:6241,registered:true,center:0}],
  ['S3',{area:6241,registered:true,center:0}], ['S4',{area:6253,registered:true,center:0}],
  ['S5',{area:6241,registered:true,center:1}], ['S6',{area:null,reviewArea:6241,registered:true,center:0}],
  ['S7',{area:6241,registered:false,center:0}],
]);
const ledger={startDate:'2026-08-26',endDate:'2026-11-23',days:[
  dates('2026-09-14','osan',[['S4',dispatch]]),
  dates('2026-10-01','osan',[['S2',delivery]]),
  dates('2026-11-16','osan',[['S3',delivery]]),
  dates('2026-11-17','osan',[['S1',delivery],['S2',order]]),
  dates('2026-11-23','osan',[['S1',order],['S1',dispatch],['S1',dispatch],['S6',delivery],['S7',order],['S8',dispatch]]),
  dates('2026-11-23','yeongnam',[['S1',delivery],['S5',order]]),
  dates('2026-11-24','osan',[['S2',delivery]]),
]};

test('postal operations count distinct verified customers by evidence, retaining earlier stronger evidence',()=>{
  const report=projectPostalOperations(ledger,assignments,{days:7,center:'osan',end:'2026-11-23'});
  assert.deepEqual(report.period,{days:7,start:'2026-11-17',end:'2026-11-23'});
  assert.equal(report.publishedThrough,'2026-11-23');
  assert.deepEqual(report.areas.get(6241).counts,{registered:3,observed:2,orders:2,dispatch:1,completed:1});
  assert.deepEqual([...report.areas.get(6241).members],[['S1',7],['S2',1],['S3',0]]);
  assert.equal(report.summary.unplaced,3);
  assert.equal(report.areas.get(6253).counts.observed,0);
  assert.equal(report.summary.missingAreas,1);
});

test('each supported window and center uses its own positive records with no geometry guess',()=>{
  for(const [days,completed,confirmedDispatch] of [[7,1,1],[30,2,1],[60,3,1],[90,3,2]]){
    const report=projectPostalOperations(ledger,assignments,{days,center:'osan',end:'2026-11-23'});
    assert.deepEqual([report.summary.completed,report.summary.dispatch],[completed,confirmedDispatch]);
  }
  const yeongnam=projectPostalOperations(ledger,assignments,{days:7,center:'yeongnam',end:'2026-11-23'});
  assert.equal(yeongnam.summary.completed,0);
  assert.equal(yeongnam.summary.unplaced,1);
  assert.deepEqual([...yeongnam.areas.get(6241).members],[['S5',1]]);
});
