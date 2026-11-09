import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {readStageArchivedDelivery} from '../src/stageArchivedDelivery.js';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const address=hash('current source address');
const observedAt='2026-11-08T14:24:54.423Z';
const older={date:'2026-08-10',sourceRows:6,visits:[
  [hash('historical 1'),'S90001','101',address],
  [hash('historical 2'),'S90001','101',hash('other address')],
  [hash('historical 3'),'S90001','122',address],
  [hash('historical 4'),'S90002','202',null]
]};
const recent={date:'2026-11-07',sourceRows:3,visits:[[hash('recent'),'S90001','122',address]]};
const build=days=>Buffer.from(JSON.stringify({source:'DELIVERY_ARCHIVE_COMPLETION_OBSERVATIONS',observedAt,days}));

test('archive returns only matching dates and observed vehicles without implying complete or ordered dispatch',()=>{
  const bytes=build([older,recent]), read=readStageArchivedDelivery(bytes,hash(bytes));
  const stores=new Map([['S90001',{name:'Fixture store',hasPoint:true,matchHash:address,lat:37,lng:127}]]);
  const result=read(older.date,stores);
  assert.equal(result.meta.sourceComplete,false);
  assert.equal(result.meta.complete,false);
  assert.equal(result.meta.reviewOnly,true);
  assert.equal(result.meta.observedVisitCount,4);
  assert.equal(result.meta.rowCount,3);
  assert.deepEqual(result.data.map(row=>[row.vehicle,row.lat,row.order,row.status]),[
    ['101',null,null,'COMPLETED'],['122',37,null,'COMPLETED'],['202',null,null,'COMPLETED']
  ]);
  assert.equal(read('latest',stores).meta.date,recent.date);
  assert.equal(read('2026-07-01',stores),null);
});

test('archive rejects tampered contents, a duplicate source task and an out-of-scope vehicle',()=>{
  const bytes=build([older]);
  assert.throws(()=>readStageArchivedDelivery(bytes,hash('incorrect')),/DIGEST/);
  for(const visits of [[...older.visits,older.visits[0]],[[hash('new'),'S90001','999',address]]]){
    const wrong=build([{...older,visits}]);
    assert.throws(()=>readStageArchivedDelivery(wrong,hash(wrong)),/ROW/);
  }
});
