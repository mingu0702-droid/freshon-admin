import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import '../public/phase2b-ui-helpers.js';
const runtime=await readFile(new URL('../public/map-phase2b-runtime.js',import.meta.url),'utf8');
const html=await readFile(new URL('../public/map-phase2b-preview.html',import.meta.url),'utf8');
const css=await readFile(new URL('../public/phase2b-operations-ui.css',import.meta.url),'utf8');
function fixture(){
 const nodes=new Map();const $=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',innerHTML:'',value:'',style:{},classList:{remove(){},add(){},toggle(){}},setAttribute(){}});return nodes.get(id);};
 const ctx=vm.createContext({window:{},document:{querySelector:$,querySelectorAll:()=>[]},console,Intl,Date,URL,Map,Set,Number,innerWidth:1440,requestAnimationFrame(){},Phase2bUi:globalThis.Phase2bUi});
 vm.runInContext(runtime.slice(0,runtime.lastIndexOf('  initVehicles();'))+`window.test={state,rankSearchRows,normalizeStore,renderRunList,clearSelection,setRows:(r)=>operationStops=r,setFilter:(f)=>runFilter=f};})();`,ctx);
 return {...ctx.window.test,$};
}
test('route filters retain unlocated stops, date order, status and selected row',()=>{
 const f=fixture();const rows=[{customerCode:'A',vehicle:'101',order:1,status:'COMPLETED',actualCompletedAt:'2026-08-11T00:12:00Z',customerName:'첫 점포',lat:37,lng:127},{customerCode:'B',vehicle:'101',order:2,status:'PENDING',lat:null,lng:null}];
 f.setRows(rows);f.renderRunList();assert.match(f.$('#runList').innerHTML,/첫 점포/);assert.match(f.$('#runList').innerHTML,/09:12/);assert.match(f.$('#runList').innerHTML,/data-run-code="B"/);
 f.setFilter('COMPLETED');f.renderRunList();assert.doesNotMatch(f.$('#runList').innerHTML,/data-run-code="B"/);
 f.setFilter('PENDING');f.state.selected=rows[1];f.renderRunList();assert.match(f.$('#runList').innerHTML,/runStop selected/);assert.doesNotMatch(f.$('#runList').innerHTML,/data-run-code="A"/);
 f.clearSelection();assert.doesNotMatch(f.$('#runList').innerHTML,/runStop selected/);
});
test('name index supports partial Korean, code, multi-token and dated-first dedupe',()=>{
 const f=fixture();const rows=[{customerCode:'S222538',customerName:'준코 구리 수택점',vehicle:'109'},{customerCode:'S222538',customerName:'준코 구리 수택점',vehicle:'101'}];
 for(const q of ['S222','준코','준코 구리']){const result=f.rankSearchRows(rows,q);assert.equal(result.length,1);assert.equal(result[0].vehicle,'109');}
 assert.equal(f.rankSearchRows(rows,'없는 점포').length,0);
});
test('current stop status comes from real app recording, not missing-coordinate guesses',()=>{
 const f=fixture();assert.equal(f.normalizeStore({appRecorded:true}, {vehicle:'101'},0).status,'COMPLETED');assert.equal(f.normalizeStore({appRecorded:false}, {vehicle:'101'},0).status,'PENDING');assert.equal(f.normalizeStore({}, {vehicle:'101'},0).status,'');
});
test('one operation control, WMS UI removed, list and mobile tabs present',()=>{
 assert.equal((html.match(/id="operationVehicle"/g)||[]).length,1);assert.doesNotMatch(html,/openWms|>WMS</);assert.doesNotMatch(runtime,/openWms|tab=wms/);
 for(const value of ['runList','runListPanel','mobileWorkspace','operationsPanel'])assert.match(html,new RegExp(`id="${value}"`));
 for(const value of ['detail','runs','new'])assert.match(html,new RegExp(`data-sheet-tab="${value}"`));
});
test('popup centers above pointed pin; same font family; map header has no gap',()=>{
 assert.match(runtime,/point\.x - width \/ 2/);assert.match(runtime,/point\.y - panel\.offsetHeight - 40/);assert.match(runtime,/xAnchor: \.5/);assert.match(runtime,/yAnchor: 1,/);assert.match(css,/\.code,\.storeName\{font-family:var\(--font\)/);assert.match(css,/#map\{top:var\(--bar\)/);
});
test('comparison defaults off and source truncation cannot become dated fallback',()=>{
 assert.equal(fixture().state.areaOn,false);assert.match(runtime,/if \(state\.areaOn\) \{ drawSelectedBoundaries\(\[\]\)/);assert.match(runtime,/snapshot vehicle relationships must never masquerade/);
});
