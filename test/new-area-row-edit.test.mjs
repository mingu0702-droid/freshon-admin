import assert from 'node:assert/strict';
import test from 'node:test';
import '../public/opsmap/map-period-ui.js';
import '../public/opsmap/new-area-row-edit.js';

const {replace}=globalThis.MapNewAreaRowEdit;
const {parseAreaInput}=globalThis.MapPeriodUi;

test('edits one logical TSV row and keeps mixed newlines and untouched columns byte for byte',()=>{
  const before='주소 1\t"고객\r\n첫 줄"\r\n';
  const row='"주소 2, 상세"\t"고객 ""별칭""\n둘째 줄"';
  const after='\n\n주소 3\t고객 3\r\n';
  const input=before+row+after;
  const original=parseAreaInput(input)[1];
  assert.equal(original.originalInput,row);
  const result=replace(input,1,original.originalInput,{address:'서울 제기로 80'});
  assert.deepEqual(result,{index:1,originalInput:'서울 제기로 80\t"고객 ""별칭""\n둘째 줄"',input:before+'서울 제기로 80\t"고객 ""별칭""\n둘째 줄"'+after});
  assert.deepEqual(parseAreaInput(result.input).slice(2),parseAreaInput(input).slice(2));
});

test('duplicate raw rows remain independent and stale edit snapshots are refused',()=>{
  const row='주소\t고객';
  const input=row+'\n'+row;
  const result=replace(input,1,row,{customer:'새\t고객 "A"'});
  assert.equal(result.input,row+'\n주소\t"새\t고객 ""A"""');
  assert.equal(parseAreaInput(result.input)[1].customer,'새\t고객 "A"');
  assert.equal(replace(result.input,1,row,{customer:'늦은 수정'}),null);
});

test('preserves BOM and can add a customer field to a single-column row',()=>{
  const input='\ufeff기존 주소\r\n다음 주소';
  const result=replace(input,0,parseAreaInput(input)[0].originalInput,{address:'다른 주소',customer:'고객'});
  assert.equal(result.input,'\ufeff다른 주소\t고객\r\n다음 주소');
});

test('explicit CSV supports commas, escaped quotes and multiline values',()=>{
  const row='"서울, 주소", "고객\r\n""A"""';
  const tail='\r\n"다른, 주소",고객 B';
  const result=replace(row+tail,0,row,{customer:'새 고객, "B"'},{format:'csv'});
  assert.equal(result.input,'"서울, 주소","새 고객, ""B"""'+tail);
  assert.equal(replace('서울, 주소\t고객',0,'서울, 주소\t고객',{customer:'새 고객'}).input,'서울, 주소\t새 고객');
});

test('rejects malformed, extra-column, stale or blank-address corrections',()=>{
  for(const input of ['"주소\n고객','주소\t고객\t추가 입력'])assert.equal(replace(input,0,input,{address:'새 주소'}),null);
  assert.equal(replace('주소',0,'주소',{address:' '}),null);
  assert.equal(replace('주소',1,'주소',{address:'새 주소'}),null);
  assert.equal(replace('주소',0,'주소',{address:'새 주소'},{format:'unknown'}),null);
});
