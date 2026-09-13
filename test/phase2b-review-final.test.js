import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {parseLocationMessage as parse,sanitizeLocationMessage,locationDetailsFromTasks} from "../src/phase2bLocationDetail.js";
import "../public/phase2b-ui-helpers.js";
const runtime=fs.readFileSync(new URL("../public/map-phase2b-runtime.js",import.meta.url),"utf8");
const html=fs.readFileSync(new URL("../public/map-phase2b-preview.html",import.meta.url),"utf8");
const css=fs.readFileSync(new URL("../public/phase2b-review-final.css",import.meta.url),"utf8");
const server=fs.readFileSync(new URL("../src/server.js",import.meta.url),"utf8");
for(const password of ["103891#/","3488*","0001#","*8822*"])test("password string preserved: "+password,()=>{
 assert.equal(parse("도어락 비밀번호: "+password).password,password);
});
test("location fields and cold/frozen/ambient notes parse",()=>{
 const p=parse("(영업)*배송위치: 후문 / *출입방법: 경비실 호출 / *비밀번호: 1234# / *특이사항: 냉장 냉동 실온 분리 / *배송요일: 월/수/금");
 assert.match(p.accessInfo,/후문.*경비실/);assert.equal(p.password,"1234#");assert.match(p.specialRemark,/냉장 냉동 실온/);assert.equal(p.deliveryPattern,"월/수/금");
});
test("claim/center text and owner phone never survive fallback",()=>{
 const p=parse("후문 이용 / 클레임: 비공개\n점주전화: 010-1234-5678\n(센터) 비공개\n(영업) 알 수 없는 배송지시");
 const text=JSON.stringify(p);assert.doesNotMatch(text,/클레임|센터|010|비공개|\(영업\)/);assert.match(p.rawMemo,/배송지시/);
});
test("source is location.message only, center fragment stripped, no completion memo",()=>{
 const row={customer:{erpCode:"S1234"},completeTypeText:"COMPLETE_SECRET",location:{message:"출입방법: 후문 / CENTER_SECRET",messageByCenter:"CENTER_SECRET",messageBySales:"SALES_SECRET"}};
 const data=locationDetailsFromTasks([row],"2026-09-12").S1234;
 assert.equal(data.memoSource,"location.message");assert.equal(data.accessInfo,"후문 /");assert.doesNotMatch(JSON.stringify(data),/CENTER_SECRET|SALES_SECRET|COMPLETE_SECRET/);
});
test("empty location.message does not resurrect combined legacy accessMemo",()=>{
 const data=locationDetailsFromTasks([{customer:{erpCode:"S1234"},location:{message:"",messageBySales:"private",messageByCenter:"private"}}],"2026-09-12");
 assert.equal(data.S1234.password,"");assert.equal(data.S1234.rawMemo,"");
 assert.match(server,/Never expose legacy combined sales\/center memo/);
});
test("operational weekday source is explicit; raw fallback is sanitized",()=>{
 assert.match(parse("배송요일: 월화수목금토").deliveryPattern,/월화수목금토/);
 assert.equal(parse("규격외 배송 요청").rawMemo,"규격외 배송 요청");
 assert.match(server,/deliveryPatternSource/);
});
test("normal SVG pin anchors to the point without double transforms",()=>{
 assert.match(runtime,/viewBox="0 0 28 34"/);assert.match(runtime,/xAnchor: \.5/);assert.match(runtime,/yAnchor: 1,/);
 assert.match(css,/clip-path:none/);assert.match(css,/\.marker.selected[^}]*transform:none/);
 assert.match(runtime,/const label = kind === "virtual".*\["representative", "nearbyVehicle"\]/);
});
test("done/pending/selected colors are explicit",()=>{
 for(const color of ["#14825d","#f59e0b","#2563eb"])assert.ok(css.includes(color));
 assert.match(css,/\.pinNumber/);
});
test("selected vehicle identity and auxiliary diagnostics",()=>{
 assert.match(html,/selectedVehicleBadge/);assert.match(html,/runListTitle/);assert.match(runtime,/선택 호차:/);
 assert.match(html,/>진단\/상태<\/button>/);assert.match(runtime,/clearSelection\(\); updateOperationMetrics\(null\)/);
});
test("unlocated source assignment survives separately without invented status/order",()=>{
 assert.match(runtime,/const extraStops = dateReady/);assert.match(runtime,/좌표 미확인.*운행집계 제외/);
 assert.match(runtime,/지도 위치를 변경하지 않습니다/);assert.match(runtime,/lat: item.lat === null \? null/);
});
test("row-to-pin and pin-to-row maintain viewport focus and scroll",()=>{
 assert.match(runtime,/selectStore\(row, null, true\)/);assert.match(runtime,/scrollIntoView\?/);assert.match(runtime,/state.map.setLevel\(5\)/);
});
test("routing unavailable preserves straight-line policy, no browser directions fan-out",()=>{
 assert.match(runtime,/다음 직선/);assert.doesNotMatch(runtime,/apis-navi|\/directions/);
 assert.match(runtime,/500m/);assert.match(runtime,/withinRadius\(point, \.5\)/);
});
function fixture(fetchImpl) {
 const nodes=new Map();const $=id=>{if(!nodes.has(id))nodes.set(id,{textContent:"unchanged",classList:{},value:""});return nodes.get(id);};
 const ctx=vm.createContext({window:{},document:{querySelector:$,querySelectorAll:()=>[]},Phase2bUi:globalThis.Phase2bUi,console,Intl,Date,URL,Map,Set,Number,Symbol,AbortController,setTimeout,clearTimeout,performance,fetch:fetchImpl,location:{href:"https://stage.test/"},innerWidth:1440,requestAnimationFrame(){}});
 vm.runInContext(runtime.slice(0,runtime.lastIndexOf("  initVehicles();"))+"window.test={fetchJson,memoryResponses,requestControllers};})();",ctx);
 return ctx.window.test;
}
test("previous request abort is silent even when its error is plain text",async()=>{
 let rejectOld;
 const f=fixture((_url,{signal})=>new Promise((resolve,reject)=>{rejectOld=reject;signal.addEventListener("abort",()=>reject(new Error("This operation was aborted")));}));
 const old=f.fetchJson("/old",{channel:"same"}).catch(e=>e);
 f.memoryResponses.set("/cached",{value:{ok:true},expiresAt:Date.now()+5000});
 assert.equal((await f.fetchJson("/cached",{channel:"same",ttl:5000})).ok,true);
 assert.equal((await old).silent,true);assert.equal(f.requestControllers.size,0);
});
test("body read AbortError is never turned into success",async()=>{
 const f=fixture(async()=>({ok:true,headers:{get:()=>null},status:200,json:async()=>{throw Object.assign(new Error("This operation was aborted"),{name:"AbortError"});}}));
 await assert.rejects(f.fetchJson("/body"),e=>e.silent===true);
});
test("current timeout stays actionable while raw AbortError text never renders",async()=>{
 const f=fixture((_u,{signal})=>new Promise((_r,reject)=>signal.addEventListener("abort",()=>reject(Object.assign(new Error("This operation was aborted"),{name:"AbortError"})))));
 await assert.rejects(f.fetchJson("/timeout",{timeout:5}),e=>!e.silent&&e.code==="REQUEST_TIMEOUT"&&!/aborted|AbortError/.test(e.message));
});
test("superseded late network error is silent, current errors remain errors",()=>{
 const error=new Error("This operation was aborted");
 assert.equal(Phase2bUi.requestError(error,{stale:true}).silent,true);
 assert.equal(Phase2bUi.requestError(error).code,"REQUEST_TIMEOUT");
 const genuine=new Error("HTTP_500");assert.equal(Phase2bUi.requestError(genuine),genuine);
});
test("initial snapshot catch also suppresses cancellations",()=>{
 assert.match(runtime,/!dateChosenByUser && !isSilentRequestError\(error\)/);
});
