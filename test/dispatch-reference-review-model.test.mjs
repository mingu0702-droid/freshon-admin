import test from 'node:test';
import assert from 'node:assert/strict';
import {createDispatchReference} from '../public/opsmap/dispatch-reference.mjs';
import {compareDispatchReview,groupFixedPostalRoutes,simulateDispatchReviewMoves} from '../public/opsmap/dispatch-reference-review-model.mjs';

const date='2026-11-25', source='WMS_CONFIRMED_DISPATCH_FRESHON_JSON';
function model({routeSource=source,routeState='VERIFIED',badTarget=false}={}){
  const data=[
    ['101','C1','06241',37.5000,10], ['101','C2','06312',null,20],
    ['101','C3','06241',37.5010,30], ['101','C4','06242',37.5090,40],
    ['208','C5','06242',37.5004,50], ['208','C6','06312',null,60],
    ['208','C7','06241',37.5070,70], ['177','C3','06241',37.5010,80],
    ['177','C8','06241',37.5011,90]
  ];
  const rows=data.map(([vehicle,customerCode,postalCode,lat])=>({
    vehicle,customerCode,postalCode,lat,lng:127,coordinateVerified:lat!==null}));
  const vehicles=['101','208','177'].map(vehicle=>{
    const detailRows=data.filter(row=>row[0]===vehicle).map(row=>({customerCode:row[1],amount:row[4]}));
    return {vehicle,detailRows,amount:detailRows.reduce((sum,row)=>sum+row.amount,0)+(badTarget&&vehicle==='208'?1:0),detailState:'VERIFIED'};
  });
  return createDispatchReference({date,center:'osan',route:{state:routeState,source:routeSource,rows},
    amounts:{state:'VERIFIED',source,date,vehicles}},[],date);
}
const codes=rows=>rows.map(row=>row.customerCode);

test('separates same postal evidence from directional distance and excludes globally duplicate stops',()=>{
  const m=model();
  const result=compareDispatchReview(m,'208','101');
  assert.deepEqual(result.sharedAreaCounts,[{code:'06241',source:1,target:1},{code:'06242',source:1,target:1},{code:'06312',source:1,target:1}]);
  assert.deepEqual(codes(result.samePostalCandidates),['C1','C4','C2']);
  assert.equal(result.samePostalCandidates.at(-1).km,null);
  assert.equal(result.samePostalCandidates.at(-1).nearest.customerCode,'C6');
  assert.deepEqual(codes(result.adjacentCandidates),['C1','C4']);
  assert.deepEqual(codes(result.nearbyCandidates),['C1','C4']);
  assert.equal(result.nearbyCandidates[0].nearest.customerCode,'C5');
  assert.equal(result.nearbyCandidates[0].amount,10);
  assert.deepEqual(codes(compareDispatchReview(m,'101','208').adjacentCandidates),['C5','C7']);
  assert.equal(compareDispatchReview(model({routeState:'PARTIAL'}),'208','101'),null);
  assert.equal(compareDispatchReview(model({routeSource:'DELIVERY_ARCHIVE'}),'208','101').nearbyCandidates[0].amount,null);
});

test('aggregates independent directions, preserves fleet total and count, and fails closed',()=>{
  const m=model();
  const first={source:'101',target:'208',customerCode:'C1',mode:'adjacent'};
  const same={source:'101',target:'208',customerCode:'C2',mode:'same-postal'};
  const reverse={source:'208',target:'101',customerCode:'C5',mode:'nearby'};
  const result=simulateDispatchReviewMoves(m,[first,same,reverse]);
  assert.deepEqual(result,simulateDispatchReviewMoves(m,[same,reverse,first]));
  assert.deepEqual([...result.vehicles],[
    ['101',{amount:120,storeCount:3}], ['208',{amount:160,storeCount:4}], ['177',{amount:170,storeCount:2}]
  ]);
  assert.equal(result.amountTotal,450);
  assert.equal(result.movedAmount,80);
  assert.equal(result.moveCount,3);
  assert.equal(simulateDispatchReviewMoves(m,[first,{...first,mode:'nearby'}]),null);
  assert.equal(simulateDispatchReviewMoves(m,[{...same,mode:'nearby'}]),null);
  assert.equal(simulateDispatchReviewMoves(m,[{...first,customerCode:'C3'}]),null);
  assert.equal(simulateDispatchReviewMoves(model({badTarget:true}),[first]),null);
  assert.equal(simulateDispatchReviewMoves(model({routeSource:'DELIVERY_ARCHIVE'}),[first]),null);
});

test('counts individual verified fixed-route members without inventing or duplicating assignments',()=>{
  const assignments=new Map([['C1','101'],['C2','101'],['C3','208'],['C4','미배정'],['C5',' 209']]);
  assert.deepEqual(groupFixedPostalRoutes(['C1','C1','C2','C3','C4','C5','invalid','C6'].map(code=>({code})),code=>assignments.get(code)),
    [{vehicle:'101',count:2},{vehicle:'208',count:1}]);
});
