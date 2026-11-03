import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {privateRoot, privatePath, renderReport, runStatus} from '../scripts/r13-render-qa-report.mjs';

const sha = 'a'.repeat(40);
const actual = scope => ({scope, status: 'PASS', observedAt: '2026-11-04T01:02:03Z', checks: [{name: 'CURRENT_CUSTOMER_ADDRESS', status: 'PASS'}], measures: {sourceWrites: 0, pinChanges: 0, requestCount: 1}, evidence: [path.join(privateRoot, 'api-summary.json')]});

test('synthetic success never claims actual API or browser validation', () => {
  const html = renderReport({sha, runs: [{scope: 'SYNTHETIC', status: 'PASS', checks: [{name: 'SYNTHETIC_REGISTRY_MERGE', status: 'PASS'}]}]});
  assert(html.includes('<h2>SYNTHETIC</h2>')); assert(html.includes('<h2>ACTUAL_API</h2>')); assert(html.includes('<h2>ACTUAL_BROWSER</h2>'));
  assert.equal((html.match(/BLOCKED · 미수행/g) || []).length, 2); assert.equal((html.match(/<h3><b class="PASS">/g) || []).length, 1);
});

test('actual PASS requires SHA, observed time, evidence, preservation and requests', context => {
  context.mock.method(fs, 'existsSync', () => true);
  const run = actual('ACTUAL_API'); assert.equal(runStatus(run, sha), 'PASS');
  for (const patch of [{observedAt: null}, {evidence: []}, {checks: []}, {measures: {sourceWrites: 1, pinChanges: 0, requestCount: 1}}, {measures: {sourceWrites: 0, pinChanges: 0, requestCount: 0}}]) assert.equal(runStatus({...run, ...patch}, sha), 'BLOCKED');
  assert.equal(runStatus(run, 'invalid'), 'BLOCKED');
});

test('actual browser needs before and after screenshots at all four widths', context => {
  context.mock.method(fs, 'existsSync', () => true);
  const views = [1920, 1366, 768, 390].map(width => ({width, horizontalOverflow: false, screenshot: path.join(privateRoot, `${width}.png`)}));
  const run = {...actual('ACTUAL_BROWSER'), before: {viewports: views}, after: {viewports: views}};
  assert.equal(runStatus(run, sha), 'PASS'); assert.equal(runStatus({...run, after: {viewports: views.slice(1)}}, sha), 'BLOCKED');
  assert.equal(runStatus({...run, after: {viewports: [{...views[0], horizontalOverflow: true}, ...views.slice(1)]}}, sha), 'FAIL');
  assert.equal(runStatus({...run, checks: [...run.checks, {name: 'AUTOMATION_UNAVAILABLE', status: 'BLOCKED'}]}, sha), 'BLOCKED');
});

test('unknown scopes, public paths, URLs and path escapes are rejected', () => {
  assert.throws(() => renderReport({runs: [{scope: 'REAL_OR_SYNTHETIC'}]}), /EXPLICIT_EVIDENCE_SCOPE_REQUIRED/);
  for (const file of [privateRoot, path.join(privateRoot, '../public.png'), 'https://example.com/a.png', 'data:image/png;base64,AAAA', 'C:/Users/SFN/Documents/public.json']) assert.throws(() => privatePath(file), /PRIVATE_EVIDENCE_PATH_REQUIRED/);
  assert.throws(() => renderReport({runs: [{scope: 'ACTUAL_API', evidence: ['https://example.com/a.json']}]}), /PRIVATE_EVIDENCE_PATH_REQUIRED/);
});

test('report projects only approved counters and escapes labels without copying protected fields', () => {
  const html = renderReport({sha, sourceFullName: 'SYNTHETIC_PROTECTED_SOURCE', rows: [{address: 'SYNTHETIC_PROTECTED_ADDRESS'}], runs: [{scope: 'SYNTHETIC', status: 'FAIL', password: 'SYNTHETIC_PROTECTED_PASSWORD', checks: [{name: '<script>alert(1)</script>', status: 'FAIL'}, {name: 'cookie=SECRET', status: 'FAIL'}, {name: '010-1234-5678', status: 'FAIL'}], measures: {customersObserved: 4843, sourceFullName: 'SYNTHETIC_PROTECTED_COUNTER'}}]});
  assert(html.includes('4843')); assert(html.includes('&lt;script&gt;')); assert(!html.includes('<script>'));
  for (const value of ['SYNTHETIC_PROTECTED', 'cookie=SECRET', '010-1234-5678']) assert(!html.includes(value));
});

test('missing evidence remains BLOCKED and missing heap is not reported as zero', () => {
  const run = {...actual('ACTUAL_BROWSER'), before: {viewports: [{width: 390, horizontalOverflow: false, domNodes: 20, heapUsedBytes: null, screenshot: path.join(privateRoot, 'does-not-exist.png')} ]}};
  const html = renderReport({sha, runs: [run]});
  assert.equal(runStatus(run, sha), 'BLOCKED'); assert(html.includes('heap — B')); assert(html.includes('BLOCKED · does-not-exist.png 없음'));
});
