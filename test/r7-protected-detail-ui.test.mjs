import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const source=fs.readFileSync(new URL('../public/opsmap/map-staff.js',import.meta.url),'utf8');
const flush=async()=>{for(let i=0;i<25;i++)await Promise.resolve();};
function fixture(){
 const elements=[],pending=[],timers=new Map();let seq=0,expired=0,logouts=0;
 class Element{
  constructor(tag){this.tag=tag;this.children=[];this.attrs={};this.dataset={};this.textContent='';this.isConnected=true;this.classList={add(){},remove(){}};elements.push(this);}
  append(x){this.children.push(x);}replaceChildren(){this.children=[];this.textContent='';}setAttribute(k,v){this.attrs[k]=v;}addEventListener(){}focus(){}
  show(){this.open=true;}showModal(){this.open=true;}close(){this.open=false;}
 }
 const session={authenticated:true,expiresAt:Date.now()+3600000,idleExpiresAt:Date.now()+1800000};
 const window={addEventListener(){},MapStaffEntry:{check:async()=>session,session:()=>session,expire:()=>expired++,logout:()=>logouts++},Phase2bUi:{normalizeVehicleLabel:v=>String(v)}};
 const document={body:new Element('body'),head:new Element('head'),createElement:t=>new Element(t),addEventListener(){},hidden:false};
 const fetch=(url,options)=>new Promise(resolve=>pending.push({url,signal:options.signal,finish:(status,data)=>resolve(new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}}))}));
 vm.runInNewContext(source,{document,window,fetch,Response,AbortController,DOMException,URLSearchParams,Date,performance,MutationObserver:class{observe(){}},setTimeout:(fn,ms)=>{timers.set(++seq,{fn,ms});return seq;},clearTimeout:id=>timers.delete(id)});
 const text=e=>e.textContent+e.children.map(text).join('');
 return {window,pending,host:()=>new Element('section'),button:()=>new Element('button'),text,expired:()=>expired,logouts:()=>logouts};
}
const target={kind:'notes',customerCode:'S970001',date:'2026-10-23'};
const good={ok:true,data:{customerCode:target.customerCode,memoDate:target.date,accessInfo:'SYNTHETIC_AUTHORISED_ONLY'}};

test('HTTP200 internal failure cannot render unregistered protected fields as success',async()=>{
 const f=fixture(),host=f.host();await f.window.MapStaff.open(target,host,f.button());await flush();
 f.pending[0].finish(200,{ok:false,data:null,error:'INTERNAL_ERROR',raw:'NEVER_RENDER_RAW'});await flush();
 assert.equal(host.dataset.state,'error');assert.doesNotMatch(f.text(host),/NEVER_RENDER_RAW|비밀번호|미등록/);assert.equal(f.expired(),0);assert.equal(f.logouts(),0);
});
test('upstream 401-class error or timeout preserves authenticated employee and offers manual retry',async()=>{
 for(const [http,error,state] of [[502,'DETAIL_SOURCE_AUTH_REQUIRED','source-auth'],[502,'DETAIL_SOURCE_FORBIDDEN','source-auth'],[504,'DETAIL_UPSTREAM_TIMEOUT','error']]){
  const f=fixture(),host=f.host();await f.window.MapStaff.open(target,host,f.button());await flush();f.pending[0].finish(http,{ok:false,error});await flush();
  assert.equal(host.dataset.state,state);assert.equal(f.expired(),0);assert.equal(f.logouts(),0);assert.equal(f.pending.length,1);
 }
});
test('only exact customer and delivery-date response is displayed',async()=>{
 const f=fixture(),host=f.host();await f.window.MapStaff.open(target,host,f.button());await flush();f.pending[0].finish(200,{...good,data:{...good.data,memoDate:'2026-10-22'}});await flush();
 assert.equal(host.dataset.state,'error');assert.doesNotMatch(f.text(host),/SYNTHETIC_AUTHORISED_ONLY/);
 await f.window.MapStaff.open(target,host,f.button());await flush();f.pending[1].finish(200,good);await flush();assert.equal(host.dataset.state,'ready');assert.match(f.text(host),/SYNTHETIC_AUTHORISED_ONLY/);
});
test('switching customers aborts first read and rejects its late protected response',async()=>{
 const f=fixture(),host=f.host();await f.window.MapStaff.open(target,host,f.button());await flush();
 await f.window.MapStaff.open({...target,customerCode:'S970002'},host,f.button());await flush();assert.equal(f.pending[0].signal.aborted,true);
 f.pending[0].finish(200,good);await flush();assert.equal(host.dataset.state,'loading');assert.doesNotMatch(f.text(host),/SYNTHETIC_AUTHORISED_ONLY/);
 f.pending[1].finish(200,{ok:true,data:{customerCode:'S970002',memoDate:target.date,accessInfo:'SECOND_SYNTHETIC_ONLY'}});await flush();
 assert.equal(host.dataset.state,'ready');assert.match(f.text(host),/SECOND_SYNTHETIC_ONLY/);assert.doesNotMatch(f.text(host),/SYNTHETIC_AUTHORISED_ONLY/);
});

test('future protected source remains pending without clearing the employee session or exposing fields',async()=>{
 const f=fixture(),host=f.host();await f.window.MapStaff.open({...target,date:'2026-11-01'},host,f.button());await flush();
 f.pending[0].finish(202,{ok:false,data:null,error:'PLANNED_SOURCE_UNOBSERVED'});await flush();
 assert.equal(host.dataset.state,'not-ready');assert.match(f.text(host),/예정 자료/);assert.doesNotMatch(f.text(host),/비밀번호|미등록/);assert.equal(f.expired(),0);assert.equal(f.logouts(),0);assert.equal(f.pending.length,1);
});
