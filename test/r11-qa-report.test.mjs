import test from 'node:test';
import assert from 'node:assert/strict';
import {renderReport, privatePath, privateRoot} from './r11-ui-report.mjs';
import path from 'node:path';
import fs from 'node:fs';

test('separates production, synthetic, and local candidates; missing before/after remains blocked', () => {
  const html = renderReport({sha:'b'.repeat(40),runs:[{scope:'SYNTHETIC',status:'PASS'}, {scope:'LOCAL_READ_CANDIDATES',status:'BLOCKED'}, {scope:'PRODUCTION_BROWSER',status:'BLOCKED',checks:[{name:'QA_CONTEXT_UNAVAILABLE_NOT_AUTH_FAILURE',status:'BLOCKED'}]}]});
  for(const scope of ['SYNTHETIC','LOCAL_READ_CANDIDATES','PRODUCTION_BROWSER']) assert(html.includes(scope));
  assert.equal((html.match(/BLOCKED · 미수행/g)??[]).length,24);
  assert(html.includes('b'.repeat(40)));
  assert(html.includes('서버 인증 실패로 판정하지 않습니다'));
});
test('unknown protected data are excluded and check labels escaped or redacted', () => {
  const html=renderReport({sourceFullName:'PRIVATE_SENTINEL',runs:[{scope:'SYNTHETIC',status:'PASS',password:'PRIVATE_PASSWORD',checks:[{name:'<script>alert(1)</script>',status:'FAIL'},{name:'cookie=SECRET',status:'FAIL'},{name:'010-1234-5678',status:'FAIL'}]}]});
  for(const forbidden of ['PRIVATE_SENTINEL','PRIVATE_PASSWORD','cookie=SECRET','010-1234-5678','<script>']) assert(!html.includes(forbidden));
  assert(html.includes('&lt;script&gt;'));
});
test('only private evidence files and explicit evidence scopes are accepted', () => {
  assert.equal(privatePath(path.join(privateRoot,'synthetic.json')),path.resolve(privateRoot,'synthetic.json'));
  for(const file of [privateRoot,path.join(privateRoot,'../public.json'),'https://example.com/p.png','C:/Users/SFN/Documents/public.json']) assert.throws(()=>privatePath(file),/PRIVATE_EVIDENCE_PATH_REQUIRED/);
  assert.throws(()=>renderReport({runs:[{scope:'REAL_DATA_MAYBE'}]}),/EXPLICIT_EVIDENCE_SCOPE_REQUIRED/);
  assert.throws(()=>renderReport({runs:[{scope:'SYNTHETIC',evidence:['C:/outside.png']}]}),/PRIVATE_EVIDENCE_PATH_REQUIRED/);
});
test('numeric measures, missing heap, and overflow failure remain distinct', () => {
  const html=renderReport({sha:'invalid',runs:[{scope:'SYNTHETIC',status:'FAIL',before:{viewports:[{width:768,horizontalOverflow:true,domNodes:20,heapUsedBytes:null,resizeTwoFramesMs:17,details:[{open:false,visible:true}],buttons:[],overflow:[]}]}}]});
  assert(html.includes('PENDING'));
  assert(html.includes('DOM 20 · heap — B · resize 2 frames 17 ms'));
  assert(html.includes('&quot;open&quot;: false'));
});
test('production cannot claim PASS without every before/after screenshot and preservation counters',()=>{
  const html=renderReport({runs:[{scope:'PRODUCTION_BROWSER',status:'PASS'}]});
  assert(html.includes('PRODUCTION_BROWSER <b class="BLOCKED">BLOCKED</b>'));
  assert(!html.includes('class="PASS"'));
});
test('complete production evidence preserves BLOCKED checks and observed overflow overrides a claimed PASS',context=>{
  context.mock.method(fs,'existsSync',()=>true);
  const views=[1920,1366,768,390].map(width=>({width,horizontalOverflow:false,screenshot:path.join(privateRoot,'synthetic-'+width+'.png')}));
  const run={scope:'PRODUCTION_BROWSER',status:'PASS',before:{viewports:views},after:{viewports:views},checks:[{name:'SYNTHETIC_COMPLETE_EVIDENCE',status:'PASS'}],preservation:{sourceWrites:0,pinChanges:0,quotaOperations:0,logoutOperations:0}};
  assert(renderReport({runs:[run]}).includes('PRODUCTION_BROWSER <b class="PASS">PASS</b>'));
  run.checks.push({name:'SYNTHETIC_FEATURE_OFF_NOT_API_FAILURE',status:'BLOCKED'});
  assert(renderReport({runs:[run]}).includes('PRODUCTION_BROWSER <b class="BLOCKED">BLOCKED</b>'));
  run.after={viewports:[{...views[0],horizontalOverflow:true},...views.slice(1)]};
  assert(renderReport({runs:[run]}).includes('PRODUCTION_BROWSER <b class="FAIL">FAIL</b>'));
});
