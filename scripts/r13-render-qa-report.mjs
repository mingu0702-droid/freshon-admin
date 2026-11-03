import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export const privateRoot = 'C:/Users/SFN/AppData/Local/OpsmapAuth/r13/qa';
const scopes = ['SYNTHETIC', 'ACTUAL_API', 'ACTUAL_BROWSER'];
const widths = [1920, 1366, 768, 390];
const statuses = new Set(['PASS', 'FAIL', 'BLOCKED']);
const measures = ['customersObserved', 'customersRegistry', 'customerOnly', 'gpsPreserved', 'manualPreserved', 'historyPreserved', 'addressInvalidated', 'sourceWrites', 'pinChanges', 'providerLookups', 'dailyQuotaRemaining', 'requestCount'];
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
const state = value => statuses.has(value) ? value : 'BLOCKED';
const number = value => Number.isFinite(value) && value >= 0 ? value : '—';
const label = value => {
  const text = String(value ?? '').slice(0, 160);
  return /password|api.?key|cookie|bearer|authorization|token|source.?full.?name|\b01[016789][- .]?\d{3,4}[- .]?\d{4}\b/i.test(text) ? '[보호 정보 제외]' : escape(text);
};
const badge = value => `<b class="${state(value)}">${state(value)}</b>`;
const sha = value => /^[a-f0-9]{40}$/.test(value || '') ? value : 'PENDING';
const observed = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));

export function privatePath(file) {
  if (typeof file !== 'string' || /^(?:https?:|data:|file:)/i.test(file)) throw Error('PRIVATE_EVIDENCE_PATH_REQUIRED');
  const resolved = path.resolve(file), relative = path.relative(path.resolve(privateRoot), resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('PRIVATE_EVIDENCE_PATH_REQUIRED');
  return resolved;
}

function evidence(file, image = false) {
  if (!file) return 'BLOCKED · 증거 없음';
  const resolved = privatePath(file), name = label(path.basename(resolved));
  if (!fs.existsSync(resolved)) return `BLOCKED · ${name} 없음`;
  const href = escape(path.relative(privateRoot, resolved).split(path.sep).map(encodeURIComponent).join('/'));
  return image ? `<a href="${href}"><img src="${href}" alt="${name}" loading="lazy"></a>` : `<a href="${href}">${name}</a>`;
}

export function runStatus(run, inputSha) {
  if (run.status === 'FAIL' || run.checks?.some(check => check.status === 'FAIL') || ['before', 'after'].some(phase => run[phase]?.viewports?.some(view => view.horizontalOverflow === true))) return 'FAIL';
  if (run.status !== 'PASS' || !run.checks?.length || run.checks.some(check => check.status !== 'PASS')) return 'BLOCKED';
  if (run.scope === 'SYNTHETIC') return 'PASS';
  if (sha(inputSha) === 'PENDING' || !observed(run.observedAt) || !run.evidence?.length || !run.evidence.every(file => fs.existsSync(privatePath(file)))) return 'BLOCKED';
  if (run.measures?.sourceWrites !== 0 || run.measures?.pinChanges !== 0) return 'BLOCKED';
  if (run.scope === 'ACTUAL_API') return Number.isSafeInteger(run.measures.requestCount) && run.measures.requestCount > 0 ? 'PASS' : 'BLOCKED';
  const complete = ['before', 'after'].every(phase => widths.every(width => {
    const view = run[phase]?.viewports?.find(item => item.width === width);
    return view?.horizontalOverflow === false && view.screenshot && fs.existsSync(privatePath(view.screenshot));
  }));
  return complete ? 'PASS' : 'BLOCKED';
}

function screenshots(run) {
  return `<table><thead><tr><th>화면</th><th>변경 전</th><th>변경 후</th></tr></thead><tbody>${widths.map(width => `<tr><th>${width}px</th>${['before', 'after'].map(phase => {
    const view = run[phase]?.viewports?.find(item => item.width === width);
    if (!view) return '<td>BLOCKED · 미수행</td>';
    return `<td>${badge(view.horizontalOverflow === true ? 'FAIL' : view.horizontalOverflow === false ? 'PASS' : 'BLOCKED')}<p>DOM ${number(view.domNodes)} · heap ${number(view.heapUsedBytes)} B · DCL ${number(view.dclMs)} ms · resize 2 frames ${number(view.resizeTwoFramesMs)} ms</p>${evidence(view.screenshot, true)}</td>`;
  }).join('')}</tr>`).join('')}</tbody></table>`;
}

export function renderReport(input) {
  const runs = Array.isArray(input?.runs) ? input.runs : [];
  for (const run of runs) {
    if (!scopes.includes(run.scope)) throw Error('EXPLICIT_EVIDENCE_SCOPE_REQUIRED');
    for (const file of run.evidence || []) privatePath(file);
    for (const phase of ['before', 'after']) for (const view of run[phase]?.viewports || []) if (view.screenshot) privatePath(view.screenshot);
  }
  const sections = scopes.map(scope => {
    const entries = runs.filter(run => run.scope === scope);
    return `<section><h2>${scope}</h2><p>${scope === 'SYNTHETIC' ? '합성 데이터 검증 · 운영 실검수와 구분합니다.' : scope === 'ACTUAL_API' ? '실제 API 관측 · 합성 결과를 승계하지 않습니다.' : '실제 브라우저 관측 · API 관측과 별도 판정합니다.'}</p>${entries.length ? entries.map(run => `<article><h3>${badge(runStatus(run, input.sha))}</h3><p>관측 시각: ${observed(run.observedAt) ? escape(run.observedAt) : '미수행'}</p><ul>${(run.checks || []).map(check => `<li>${badge(check.status)} ${label(check.name)}</li>`).join('')}</ul><dl>${measures.filter(key => Object.hasOwn(run.measures || {}, key)).map(key => `<dt>${key}</dt><dd>${number(run.measures[key])}</dd>`).join('')}</dl>${scope === 'ACTUAL_BROWSER' ? screenshots(run) : ''}<p>증거: ${(run.evidence || []).map(file => evidence(file)).join(' · ') || 'BLOCKED · 없음'}</p></article>`).join('') : '<p>BLOCKED · 미수행</p>'}</section>`;
  }).join('');
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>R13 Customer registry QA</title><style>body{font:14px/1.55 system-ui;color:#172033;margin:24px;overflow-wrap:anywhere}section{border-top:1px solid #ccd;margin-top:24px}article{margin:16px 0}table{width:100%;table-layout:fixed;border-collapse:collapse}th,td{border:1px solid #ccd;padding:8px;vertical-align:top}th:first-child{width:70px}img{width:100%;height:auto;max-height:460px;object-fit:contain;object-position:top}b{font-size:12px;padding:3px 6px;border-radius:4px}.PASS{background:#d5f5e4}.FAIL{background:#ffdad7}.BLOCKED{background:#fff0b5}dl{display:grid;grid-template-columns:minmax(120px,240px) 1fr}dd{margin:0}a{overflow-wrap:anywhere}@media(max-width:600px){body{margin:8px}th,td{padding:5px}}</style><h1>R13 Customer registry QA</h1><p>검증 SHA: <code>${sha(input?.sha)}</code></p><p>미수행·증거 누락은 BLOCKED입니다. 브라우저 연결 불가, 기능 OFF, 실제 API 실패를 개별 체크로 기록합니다. 원본 행·주소·전화·보호 정보는 입력의 임의 필드에서 복사하지 않습니다.</p>${sections}</html>`;
}

export function writeReport(input, output = path.join(privateRoot, 'r13-qa.html')) {
  const target = privatePath(output), html = renderReport(input);
  fs.mkdirSync(path.dirname(target), {recursive: true}); fs.writeFileSync(target, html); return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw Error('USAGE: node scripts/r13-render-qa-report.mjs input.json [private-output.html]');
  console.log(writeReport(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), process.argv[3]));
}
