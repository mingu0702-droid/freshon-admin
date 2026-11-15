import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createPostalDetailsReader } from '../src/shadowCoverage/postalDetails.js';

const generation = 'a'.repeat(64), releaseSha256 = 'b'.repeat(64), boundary = 'c'.repeat(64);
const asOf = '2026-11-07', observedAt = '2026-11-08T14:24:54.423Z';
const area = 18135;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const base = { days:90, center:'osan', area, q:'', filter:'all', offset:0 };
const known = ['S101','S102','S103','S104','S105'];
const observationA = ['a'.repeat(64), '2026-11-06', 0, '156', null, '2026-11-07'];
const observationB = ['b'.repeat(64), '2026-11-05', 0, '155', null, null];
const sourceWeeks = Object.fromEntries(['Mon','Tue','Wed','Thu','Fri','Sat'].map(day=>[day,'156']));
const catalog = [
  {code:'S101',name:'오산 검증 매장',address:'오산시 테스트길 1',lat:37.149,lng:127.072, entryPassword:'sensitive'},
  {code:'S102',name:'오산 테스트 배송',address:'공동현관 비밀번호 1234',lat:37.15,lng:127.072},
  {code:'S103',name:'오산 관측 후보',address:'오산시 테스트길 3',lat:37.151,lng:127.072},
  {code:'S104',name:'위치 미확인',address:'오산시 테스트길 4'},
  {code:'S105',name:'센터 미확인',address:'오산시 테스트길 5',lat:37.152,lng:127.072},
];
const rows = [
  ['S101', [[0,2,'2026-11-06',['155','156']]]],
  ['S102', [[0,1,'2026-11-06',['156']]]],
];
const states = [['S101',1],['S102',4],['S103',2]];
const makePeriod = days => ({
  start:{30:'2026-10-09',60:'2026-09-09',90:'2026-08-10'}[days],end:asOf,
  unidentified:0, observed:{all:['2026-11-06'],osan:['2026-11-06'],yeongnam:[],honam:[]},
  unavailableCodes:[[],[],[],[]], states, rows,
});
const opened = {
  manifest:{count:1},
  release:{ generation, boundary, asOf, sourceObservedAt:observedAt, stores:catalog,
    periods:Object.fromEntries([30,60,90].map(days=>[days,makePeriod(days)])) },
  codes:new Map(known.map((code,i)=>[code,{area:i===3?null:area, center:[0,3,0,0,3][i],registered:true}])),
  scope:{ completeness:{sourceMissing:['2026-11-05'],missing:['2026-11-05'],unverified:['2026-11-06'],observed:1} }
};

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(),'opsmap-postal-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const parts = [], buffers = [];
  let offset = 0;
  for (const [code, events] of [['S101',[observationA,observationB]],['S102',[['d'.repeat(64),'2026-11-06',0,'156',null,null]]]]) {
    const json = Buffer.from(JSON.stringify({ code, rows:events }));
    const compressed = gzipSync(json);
    const recent = [[0,'2026-11-06',['156']]];
    parts.push([code,offset,compressed.length,json.length,sha256(compressed),events.length,recent]);
    offset += compressed.length;
    buffers.push(compressed);
  }
  const index = gzipSync(JSON.stringify({ schema:'opsmap-postal-details-v1', generation, boundary, release:releaseSha256,
    asOf, sourceObservedAt:observedAt, names:['경기 오산시'], zones:[[area,0]], bytes:offset,
    parts, footprints:[[30,3],[60,3],[90,3]], orders:'NOT_CONNECTED' }));
  await writeFile(join(directory,'details-index.json.gz'),index);
  await writeFile(join(directory,'customer-history.bin'),Buffer.concat(buffers));
  const checkedAt = '2026-11-13T06:06:00.000Z';
  const options = { directory, indexSha256:sha256(index), appRoot:process.cwd(), releaseSha256,
    readFixed:async codes=>({ok:true,meta:{checkedAt,stale:true},
      data:codes.map(customerCode=>({customerCode,baseVehicle:customerCode === 'S101' ? '영남신규' : '156',baseVehicleState:'VERIFIED_MASTER',
        baseVehicleSource:'FIXED_DISPATCH_PRIMARY',weekdays:sourceWeeks}))}) };
  return { directory, options, reader:createPostalDetailsReader(options), checkedAt };
}

test('roster conserves registered scope and includes distinct observed visits from another registry center',async t=>{
  const {reader,checkedAt}=await fixture(t);
  const result=await reader.roster({...base,opened,catalog});
  assert.equal(result.name,'경기 오산시');
  assert.deepEqual(result.totals,{registered:2,delivered:2,visits:3,newActive:1,newUnknown:1,newZero:0,held:0,candidates:1,unknown:0,records:3});
  assert.equal(result.source.fixed.state,'LAST_VERIFIED_RETAINED');
  assert.equal(result.source.fixed.checkedAt,checkedAt);
  const obj=result.stores.find(row=>row.code==='S101');
  assert.equal(obj.baseVehicle,'영남신규');
  assert.deepEqual(obj.confirmedVehicles,['156']);
  assert.deepEqual(obj.fixedWeekdays,[]);
  assert.equal(obj.fixedWeekdayState,'UNKNOWN');
  const redacted=result.stores.find(row=>row.code==='S102');
  assert.deepEqual(redacted.fixedWeekdays,['월','화','수','목','금','토']);
  assert.equal(redacted.registered,false);
  assert.equal(redacted.address,null);
  assert(!JSON.stringify(result).includes('sensitive'));
  const query=await reader.roster({...base,opened,catalog,q:'s103',filter:'candidate'});
  assert.deepEqual(query.stores.map(row=>row.code),['S103']);
  assert.equal(query.totals.registered,2);
  const unmatched=await reader.roster({...base,opened,catalog,area:null});
  assert.equal(unmatched.totals.records,1);
  assert.equal(unmatched.stores[0].deliveryObservation,'UNVERIFIED');
});
test('history retains dated delivery rows and evidence dates without inventing orders or IDs',async t=>{
  const {reader}=await fixture(t);
  const result=await reader.history({...base,opened,code:'S101'});
  assert.equal(result.filteredCount,2);
  assert.equal(result.orders,null);
  assert.equal(result.source.orders.state,'NOT_CONNECTED');
  assert.equal(result.orderNumber,null);
  assert.deepEqual(result.deliveries.map(row=>[row.observedDate,row.actualDate,row.confirmedVehicle,row.deliveryId,row.scheduledDate]),[
    ['2026-11-06','2026-11-07','156',null,null],['2026-11-05',null,'155',null,null],
  ]);
  assert.notEqual(result.deliveries[0].archivedKey,result.deliveries[1].archivedKey);
  await assert.rejects(reader.history({...base,opened,area:18000,code:'S101'}),/POSTAL_QUERY_INVALID/);
  await assert.rejects(reader.history({...base,opened,code:'S105'}),/POSTAL_QUERY_INVALID/);
});

test('mismatched or tampered detail package fails without synthesizing contents',async t=>{
  const {options,directory,reader}=await fixture(t);
  const absent=createPostalDetailsReader({...options,indexSha256:'0'.repeat(64)});
  await assert.rejects(absent.roster({...base,opened,catalog}),/POSTAL_DETAILS_INTEGRITY/);
  await reader.roster({...base,opened,catalog});
  const data=await import('node:fs/promises').then(fs=>fs.readFile(join(directory,'customer-history.bin')));
  data[5]^=1;
  await writeFile(join(directory,'customer-history.bin'),data);
  await assert.rejects(reader.history({...base,opened,code:'S101'}),/POSTAL_DETAILS_INTEGRITY/);
});
