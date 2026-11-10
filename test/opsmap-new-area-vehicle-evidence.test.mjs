import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {addObservedVehicleDays,createLegacyNearbyVehicleReader,readStageNearbyEvidence} from '../src/stageNearbyEvidence.js';
import '../public/opsmap/phase2b-ui-helpers.js';

const generation='a'.repeat(64);
const monday='2026-11-02', saturday='2026-11-07';
const registry=new Map([['S990001',{hasPoint:true,matchHash:'current'}]]);
const observedDates=[monday,saturday];
const document={source:'STAGE_ARCHIVE_ADDRESS_BOUND',generation,start:'2026-08-10',end:saturday,observedDates,
  rows:[['S990001',saturday,'122',66]]};
const window={start:document.start,end:document.end,observedDates:{all:observedDates}};
const parse=value=>{
  const bytes=Buffer.from(JSON.stringify(value));
  return readStageNearbyEvidence(bytes,{expected:createHash('sha256').update(bytes).digest('hex'),generation,registry,window});
};
const visit=(vehicle,center='osan',hash='current')=>['private-id','S990001',vehicle,center,hash];

test('verified days are attributed to the actual vehicle, center and current address',()=>{
  const groups=new Map(), matches=(code,hash)=>registry.get(code)?.matchHash===hash;
  addObservedVehicleDays(groups,monday,[visit('101'),visit('999','osan','old'),visit(''),visit('101')],matches);
  addObservedVehicleDays(groups,saturday,[visit('122'),visit('101','honam')],matches);
  const vehicleDays=[...groups.values()];
  assert.deepEqual(vehicleDays,[['S990001','101','osan',2],['S990001','122','osan',64],['S990001','101','honam',64]]);
  assert.deepEqual(parse(document).observedDates,observedDates);
});

test('legacy authenticated generations single-flight sealed day reads and retry failures without partial results',async()=>{
  let clock=0, fail=true, reads=0;
  const prepared={registry,nearby:parse(document),readNearbyDay:async date=>{
    reads++;
    if(date===saturday&&fail)throw Error('DAY_UNAVAILABLE');
    return {date,visits:[visit(date===monday?'101':'122')],tasks:[visit('999')]};
  }};
  const read=createLegacyNearbyVehicleReader({now:()=>clock});
  assert.deepEqual(await Promise.all([read(prepared),read(prepared)]),Array(2).fill({vehicleStatus:'UNAVAILABLE'}));
  assert.equal(reads,2);
  assert.deepEqual(await read(prepared),{vehicleStatus:'UNAVAILABLE'});
  clock=30_001;fail=false;
  const result=await read(prepared);
  assert.equal(result.vehicleStatus,'READY');
  assert.deepEqual(result.vehicleDays,[['S990001','101','osan',2],['S990001','122','osan',64]]);
  assert.equal(await read(prepared),result);
  assert.equal(reads,4);
});

test('30/40/50km includes every reference vehicle and only weekday stops inside the selected radius',()=>{
  const {nearbyVehicleWeekdays,vehiclesAtRadius}=globalThis.Phase2bUi;
  const point={lat:37,lng:127};
  const stop=(vehicle,lat,mask,center='osan')=>({vehicle,lat,lng:127,mask,center,customerCode:'S'+String(lat*10000)});
  const groups=nearbyVehicleWeekdays(point,[
    ...Array.from({length:7},(_,i)=>stop(String(101+i),37.01+i/100,2)),
    stop('101',37.30,4),stop('122',37.32,8),stop('202',37.41,64),stop('203',37.51,16),
    stop('101',37.11,64,'honam'),stop('106',37.005,0)
  ]);
  const at30=vehiclesAtRadius(groups,30),at40=vehiclesAtRadius(groups,40),at50=vehiclesAtRadius(groups,50);
  assert.deepEqual([at30.length,at40.length,at50.length],[8,9,10]);
  assert.deepEqual(at30.find(item=>item.vehicle==='101'&&item.center==='osan').weekdays,['월']);
  assert.deepEqual(at40.find(item=>item.vehicle==='101'&&item.center==='osan').weekdays,['월','화']);
  assert.deepEqual(at50.find(item=>item.vehicle==='101'&&item.center==='honam').weekdays,['토']);
  assert.equal(at30[0].vehicle,'106');
  assert.equal(at30[0].nearestStop.lat,37.005);
  assert.deepEqual(at30[0].weekdays,['월']);
  assert.ok(!at50.some(item=>item.vehicle==='203'));
});

test('a verified primary assignment without weekdays still has a reference pin',()=>{
  const {nearbyVehicleWeekdays,vehiclesAtRadius}=globalThis.Phase2bUi;
  const point={lat:37,lng:127},stop={...point,customerCode:'S990001',vehicle:'101',center:'osan',mask:0};
  const [result]=vehiclesAtRadius(nearbyVehicleWeekdays(point,[stop]),30);
  assert.equal(result.nearestStop,stop);
  assert.deepEqual(result.weekdays,[]);
});
