import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../public/map-staff.js',import.meta.url),'utf8');
function fixture(){
  const elements=[],timers=new Map();let sequence=0,finish;
  class Element{
    constructor(tag){this.tag=tag;this.children=[];this.attrs={};this.dataset={};this.textContent='';elements.push(this);}
    append(x){this.children.push(x);}replaceChildren(){this.children=[];this.textContent='';}
    setAttribute(k,v){this.attrs[k]=v;}addEventListener(){}focus(){}
    show(){this.open=true;this.modal=false;}showModal(){this.open=true;this.modal=true;}close(){this.open=false;}
  }
  const window={addEventListener(){},Phase2bUi:{normalizeVehicleLabel:v=>v+'호'}};
  const document={body:new Element('body'),head:new Element('head'),createElement:t=>new Element(t),addEventListener(){}};
  const response=(status,body)=>({status,ok:status===200,headers:{get:()=>null},json:async()=>body});
  const fetch=async(path,options)=>path.endsWith('/auth/session')?response(200,{authenticated:true,expiresAt:Date.now()+3600000,idleExpiresAt:Date.now()+1800000}):new Promise((resolve,reject)=>{
    finish=(status,body)=>resolve(response(status,body));options.signal.addEventListener('abort',()=>reject(new DOMException('This operation was aborted','AbortError')));
  });
  vm.runInNewContext(source,{window,document,fetch,AbortController,URLSearchParams,Date,performance,setTimeout:(fn,ms)=>{timers.set(++sequence,{fn,ms});return sequence;},clearTimeout:id=>timers.delete(id)});
  const text=e=>e.textContent+e.children.map(text).join('');
  return {window,element:tag=>new Element(tag),textAt:text,dialog:()=>elements.find(e=>e.tag==='dialog'),text:()=>text(elements.find(e=>e.tag==='dialog')),finish:(...args)=>finish(...args),body:document.body};
}
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
const open=async(f,kind='history')=>{await f.window.MapStaff.open({kind,customerCode:'S900001',date:'2026-08-28'});await flush();};
for(const code of ['READ_MODEL_NOT_READY','READ_MODEL_RANGE_NOT_READY'])test('history '+code+' is not empty or generic failure',async()=>{
  const f=fixture();await open(f);assert.equal(f.dialog().dataset.state,'loading');
  f.finish(503,{error:code});await flush();assert.equal(f.dialog().dataset.state,'not-ready');assert.match(f.text(),/기사 없음으로 판단하지 마세요/);assert.equal(f.dialog().modal,false);
});
test('successful empty complete history differs from incomplete coverage and pending',async()=>{
  const f=fixture();await open(f);f.finish(200,{data:[],meta:{complete:true,coverageComplete:true}});await flush();
  assert.equal(f.dialog().dataset.state,'empty');assert.match(f.text(),/선택 기간의 기사 이력이 없습니다/);
  await open(f);f.finish(200,{data:[],meta:{complete:true,coverageComplete:false}});await flush();assert.equal(f.dialog().dataset.state,'not-ready');
  await open(f);f.finish(200,{data:[],meta:{complete:false}});await flush();assert.equal(f.dialog().dataset.state,'not-ready');
});
test('available partial history remains ready with a coverage warning',async()=>{
  const f=fixture();await open(f);f.finish(200,{data:[{deliveryDate:'2026-08-28',vehicle:'101',driverName:'합성기사'}],meta:{complete:true,coverageComplete:false}});await flush();
  assert.equal(f.dialog().dataset.state,'ready');assert.match(f.text(),/전체 기간 수집 완전성 미확인/);assert.match(f.text(),/합성기사/);
});
for(const kind of ['history','notes'])test(kind+' failure leaves the public detail outside the dialog untouched',async()=>{
  const f=fixture();const publicCard={textContent:'합성 공개 고객정보'};f.body.append(publicCard);await open(f,kind);
  f.finish(503,{error:'UPSTREAM_FAILURE',internal:'DO_NOT_RENDER'});await flush();
  assert.equal(f.dialog().dataset.state,'error');assert.equal(publicCard.textContent,'합성 공개 고객정보');assert.match(f.text(),/공개 고객정보와 지도는 계속/);assert.doesNotMatch(f.text(),/DO_NOT_RENDER/);
});
test('closing during history request silently ignores aborted response',async()=>{
  const f=fixture();await open(f);f.window.MapStaff.clear();await flush();assert.equal(f.dialog().open,false);assert.equal(f.text(),'');
});
test('401 still uses the existing login form rather than a not-ready view',async()=>{
  const f=fixture();await open(f);f.finish(401,{error:'UNAUTHORIZED'});await flush();assert.equal(f.dialog().modal,true);assert.match(f.text(),/직원 공용 로그인/);
});
test('protected content stays inside selected card; collapse removes it and aborts late response',async()=>{
 const f=fixture(),host=f.element('div'),button=f.element('button'),target={kind:'notes',customerCode:'S900001',date:'2026-08-28'};
 assert.equal(f.textAt(host),'');await f.window.MapStaff.open(target,host,button);await flush();
 assert.equal(host.dataset.state,'loading');assert.equal(f.dialog().open,false);assert.equal(button.attrs['aria-expanded'],'true');
 await f.window.MapStaff.open(target,host,button);await flush();f.finish(200,{data:{accessInfo:'SYNTHETIC_ONLY'}});await flush();
 assert.equal(host.hidden,true);assert.equal(f.textAt(host),'');assert.equal(button.attrs['aria-expanded'],'false');assert.equal(f.text(),'');
});
test('inline history shows records before collapsed completeness details and clears on selection change',async()=>{
 const f=fixture(),host=f.element('div'),button=f.element('button');
 await f.window.MapStaff.open({kind:'history',customerCode:'S900001'},host,button);await flush();
 f.finish(200,{data:[{deliveryDate:'2026-08-28',vehicle:'101',driverName:'합성기사'}],meta:{complete:true,coverageComplete:false}});await flush();
 assert.equal(host.dataset.state,'ready');const text=f.textAt(host);assert.ok(text.indexOf('합성기사')<text.indexOf('검증 상태 상세'));
 assert.equal(host.children.find(e=>e.tag==='details').open,undefined);
 f.window.MapStaff.clear();assert.equal(f.textAt(host),'');assert.equal(host.hidden,true);
});
