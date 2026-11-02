import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export const privateRoot = 'C:/Users/SFN/AppData/Local/OpsmapAuth/r11-ui/qa';
const scopes = new Set(['SYNTHETIC', 'LOCAL_READ_CANDIDATES', 'PRODUCTION_BROWSER']);
const statuses = new Set(['PASS', 'FAIL', 'BLOCKED']);
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const number = value => Number.isFinite(value) && value >= 0 ? value : '—';
const status = value => statuses.has(value) ? value : 'BLOCKED';
const label = value => {
  const text = String(value ?? '').slice(0, 160);
  if (/password|api.?key|cookie|token|source.?full.?name|\b01[016789][- .]?\d{3,4}[- .]?\d{4}\b/i.test(text)) return '[보호 정보 제외]';
  return escape(text);
};
const badge = value => `<b class="${status(value)}">${status(value)}</b>`;
function runStatus(run) {
  if (run.status === 'FAIL' || run.checks?.some(check => check.status === 'FAIL')) return 'FAIL';
  if (run.scope !== 'PRODUCTION_BROWSER' || run.status !== 'PASS') return status(run.status);
  const complete = ['before','after'].every(phase => [1920,1366,768,390].every(width => {
    const view=run[phase]?.viewports?.find(item=>item.width===width);
    return view && view.horizontalOverflow === false && view.screenshot && fs.existsSync(privatePath(view.screenshot));
  }));
  const preserved=['sourceWrites','pinChanges','quotaOperations','logoutOperations'].every(key=>run.preservation?.[key]===0);
  return complete && preserved ? 'PASS' : 'BLOCKED';
}
export function privatePath(file) {
  const resolved = path.resolve(file), relative = path.relative(path.resolve(privateRoot), resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('PRIVATE_EVIDENCE_PATH_REQUIRED');
  return resolved;
}
function evidence(file, image = false) {
  if (!file) return 'BLOCKED · 증거 없음';
  const resolved = privatePath(file), name = escape(path.basename(resolved));
  if (!fs.existsSync(resolved)) return `BLOCKED · ${name} 없음`;
  const href = escape(path.relative(privateRoot, resolved).split(path.sep).map(encodeURIComponent).join('/'));
  return image ? `<a href="${href}"><img src="${href}" alt="${name}" loading="lazy"></a>` : `<a href="${href}">${name}</a>`;
}
export function renderReport(input) {
  const runs = Array.isArray(input.runs) ? input.runs : [];
  for (const run of runs) if (!scopes.has(run.scope)) throw new Error('EXPLICIT_EVIDENCE_SCOPE_REQUIRED');
  const sha = /^[a-f0-9]{40}$/.test(input.sha) ? input.sha : 'PENDING';
  const content = runs.map(run => {
    const screenshots = [1920, 1366, 768, 390].map(width => {
      const cells = ['before', 'after'].map(phase => {
        const view = run[phase]?.viewports?.find(item => item.width === width);
        if (!view) return '<td>BLOCKED · 미수행</td>';
        return `<td>${badge(view.horizontalOverflow === true ? 'FAIL' : view.horizontalOverflow === false ? 'PASS' : 'BLOCKED')}<p>DOM ${number(view.domNodes)} · heap ${number(view.heapUsedBytes)} B · resize 2 frames ${number(view.resizeTwoFramesMs)} ms<br>resize probe wall ${number(view.resizeProbeWallMs)} ms · DCL ${number(view.domContentLoadedMs)} ms · load ${number(view.loadMs)} ms</p>${evidence(view.screenshot, true)}<details><summary>초기 접힘·버튼·가로 넘침 집계</summary><p>화면 밖 버튼은 스크롤 영역을 포함하며 오류 판정과 구분합니다.</p><pre>${escape(JSON.stringify({details: view.details?.map(item => ({id:/^[a-zA-Z][\w-]{0,70}$/.test(item.id)?item.id:null,open: !!item.open,visible: !!item.visible})),visibleButtons: view.buttons?.length,outsideViewportButtons: view.buttons?.filter(item=>item.outsideViewport).length,overflowElements: view.overflow?.length}, null, 2))}</pre></details></td>`;
      });
      return `<tr><th>${width}px</th>${cells.join('')}</tr>`;
    }).join('');
    const checks = (run.checks ?? []).map(check => `<li>${badge(check.status)} ${label(check.name)}</li>`).join('');
    const preservation = run.preservation ?? {};
    return `<section><h2>${run.scope} ${badge(runStatus(run))}</h2><p>${run.scope === 'SYNTHETIC' ? '합성 데이터 검증 · 운영 실검수와 구분' : run.scope === 'LOCAL_READ_CANDIDATES' ? '로컬 실자료 조회 후보 · 운영 검수 아님' : '운영 브라우저 실검수 · 수집된 증거만 표시'}</p><ul>${checks}</ul><p>원천 쓰기 ${number(preservation.sourceWrites)} · 핀 변경 ${number(preservation.pinChanges)} · 유료 조회 ${number(preservation.quotaOperations)} · 로그아웃 ${number(preservation.logoutOperations)}</p><table><thead><tr><th>너비</th><th>변경 전</th><th>변경 후</th></tr></thead><tbody>${screenshots}</tbody></table><p>원시 증거: ${(run.evidence ?? []).map(file => evidence(file)).join(' · ') || 'BLOCKED · 없음'}</p></section>`;
  }).join('');
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>R11 UI QA</title><style>body{font:14px/1.5 system-ui;margin:24px;color:#172033;overflow-wrap:anywhere}section{margin:24px 0;border-top:1px solid #ccd;padding-top:12px}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{border:1px solid #ccd;padding:10px;vertical-align:top}th:first-child{width:70px}img{width:100%;height:auto;max-height:460px;object-fit:contain;object-position:top}b{font-size:12px;padding:3px 6px;border-radius:4px}.PASS{background:#d5f5e4}.FAIL{background:#ffdad7}.BLOCKED{background:#fff0b5}pre{white-space:pre-wrap;overflow-wrap:anywhere}a{overflow-wrap:anywhere}@media(max-width:600px){body{margin:8px}th,td{padding:5px}}</style><h1>R11 UI QA</h1><p>최종 SHA: <code>${sha}</code> · 증거 누락은 BLOCKED</p><p>실제 API 실패, 기능 OFF, 자동화 연결 불가는 개별 체크로 구분합니다. 브라우저 연결 불가는 서버 인증 실패로 판정하지 않습니다.</p><p>heap은 브라우저 제공 시에만 기록합니다. DCL/load는 최초 탐색 수치입니다. resize 2 frames는 브라우저 두 프레임 대기이며 전체 렌더 완료 시간이 아닙니다. probe wall은 DOM 검사와 자동화 대기 비용을 포함합니다. 보호 데이터는 보고서에 포함하지 않습니다.</p>${content}</html>`;
}
export function writeReport(input, output = path.join(privateRoot, 'r11-qa.html')) {
  const target = privatePath(output);
  fs.mkdirSync(path.dirname(target), {recursive:true});
  fs.writeFileSync(target, renderReport(input));
  return target;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const input = JSON.parse(fs.readFileSync(privatePath(process.argv[2]), 'utf8'));
  console.log(writeReport(input, process.argv[3]));
}
