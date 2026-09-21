import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/map-period-ui.js';
const {spatialIndex,reconcile}=globalThis.MapPeriodUi;
test('spatial index retains full search data while projecting only viewport candidates',()=>{
 const rows=Array.from({length:6000},(_,i)=>({customerCode:'S'+i,lat:33+i/1000,lng:127}));
 const index=spatialIndex(rows),found=index.query({south:37,north:37.02,west:126,east:128});
 assert.equal(index.valid.length,6000);assert.ok(found.length<30);assert.ok(found.every(r=>r.lat>=37&&r.lat<=37.02));assert.equal(rows.length,6000);
});
test('same viewport preserves every overlay identity and creates/removes zero objects',()=>{
 const entries=Array.from({length:100},(_,i)=>({key:String(i),fingerprint:'same'}));let created=0,removed=0;
 const first=reconcile(new Map(),entries,()=>({id:++created}),()=>removed++);
 const next=reconcile(first.next,entries,()=>({id:++created}),()=>removed++);
 assert.equal(created,100);assert.equal(removed,0);assert.equal(next.reused,100);assert.equal(next.created,0);assert.equal(next.removed,0);
 for(const [key,value] of first.next)assert.equal(next.next.get(key),value);
});
test('viewport movement changes only entered/exited/modified overlays',()=>{
 let removed=0;const create=e=>({key:e.key});const drop=()=>removed++;
 const first=reconcile(new Map(),[{key:'a',fingerprint:'1'},{key:'b',fingerprint:'1'},{key:'c',fingerprint:'1'}],create,drop);
 const next=reconcile(first.next,[{key:'b',fingerprint:'1'},{key:'c',fingerprint:'2'},{key:'d',fingerprint:'1'}],create,drop);
 assert.equal(next.reused,1);assert.equal(next.created,2);assert.equal(next.removed,2);assert.equal(removed,2);
});
test('empty viewport removes pins without changing source rows',()=>{
 const rows=[{lat:37,lng:127}];const index=spatialIndex(rows);assert.equal(index.query({south:0,north:1,west:0,east:1}).length,0);
 assert.equal(index.valid.length,1);const old=reconcile(new Map(),[{key:'x',fingerprint:'x'}],()=>1,()=>{});
 const cleared=reconcile(old.next,[],()=>1,()=>{});assert.equal(cleared.removed,1);assert.equal(cleared.next.size,0);
});
test('new area TSV preserves quoted lines and unit suffixes without splitting double spaces',()=>{
 const rows=MapPeriodUi.parseAreaInput('서울 강남구 테스트로 12  3층 301호\n"경기 오산시 테스트로 3\n2층"\t"합성 매장"\nS259514');
 assert.equal(rows.length,3);assert.equal(rows[0].address,'서울 강남구 테스트로 12  3층 301호');assert.equal(rows[0].customer,'');
 assert.equal(rows[1].address,'경기 오산시 테스트로 3\n2층');assert.equal(rows[1].customer,'합성 매장');assert.equal(rows[2].address,'S259514');
 assert.equal(MapPeriodUi.parseAreaInput('주소\t고객\t알수없는열')[0].inputAmbiguous,true);
 assert.equal(MapPeriodUi.parseAreaInput('"닫히지 않은 주소')[0].inputAmbiguous,true);
});
