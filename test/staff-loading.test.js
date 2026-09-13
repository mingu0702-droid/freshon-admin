import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../public/map-staff.js',import.meta.url),'utf8');
function fixture(){
 let clock=0,seq=0,finishDetail;const timers=new Map(),elements=[];
 class Element{
  constructor(tag){this.tag=tag;this.children=[];this.attrs={};this.open=false;this.dataset={};this.textContent='';elements.push(this);}
  append(x){this.children.push(x);}replaceChildren(){this.children=[];this.textContent='';}
  setAttribute(k,v){this.attrs[k]=v;}addEventListener(){}focus(){}
  show(){this.open=true;this.modal=false;}showModal(){this.open=true;this.modal=true;}close(){this.open=false;}
 }
 const document={body:new Element('body'),head:new Element('head'),createElement:t=>new Element(t),addEventListener(){}};
 const window={addEventListener(){}};
 const response=(status,data)=>({ok:status===200,status,headers:{get:()=>null},json:async()=>data});
 const fetch=async(path,options)=>{
  if(path.endsWith('/auth/session'))return response(200,{authenticated:true,expiresAt:Date.now()+3600000,idleExpiresAt:Date.now()+1800000});
  return new Promise((resolve,reject)=>{finishDetail=status=>resolve(response(status,{data:{accessInfo:'SYNTHETIC'}}));options.signal.addEventListener('abort',()=>reject(new DOMException('This operation was aborted','AbortError')));});
 };
 vm.runInNewContext(source,{document,window,fetch,AbortController,URLSearchParams,Date,performance:{now:()=>clock},setTimeout:(fn,ms)=>{timers.set(++seq,{fn,at:clock+ms});return seq;},clearTimeout:id=>timers.delete(id)});
 const text=e=>e.textContent+e.children.map(text).join('');
 return {window,elements,dialog:()=>elements.find(e=>e.tag==='dialog'),text:()=>text(elements.find(e=>e.tag==='dialog')),advance:ms=>{clock+=ms;for(const [id,t]of [...timers])if(t.at<=clock){timers.delete(id);t.fn();}},finish:s=>finishDetail(s)};
}
const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
test('detail shows an immediate accessible spinner without a modal and delays notice until 5s',async()=>{
 const f=fixture();await f.window.MapStaff.open({customerCode:'S1234',date:'2026-08-28'});await flush();
 assert.equal(f.dialog().modal,false);assert.match(f.text(),/상세정보 불러오는 중/);
 assert.ok(f.elements.some(e=>e.className==='staffLoadingSpinner'));assert.ok(f.elements.some(e=>e.attrs.role==='status'));
 f.advance(4999);assert.ok(!f.text().includes('지연'));f.advance(1);assert.match(f.text(),/지연/);
 f.finish(200);await flush();assert.ok(!f.text().includes('지연'));assert.match(f.text(),/SYNTHETIC/);
});
test('early 504 offers retry without an early delay notice; closing silently cancels',async()=>{
 const f=fixture();await f.window.MapStaff.open({customerCode:'S1234'});await flush();f.advance(4800);f.finish(504);await flush();
 assert.ok(!f.text().includes('지연'));assert.ok(f.elements.some(e=>e.textContent==='다시 시도'));
 await f.window.MapStaff.open({customerCode:'S5678'});await flush();f.window.MapStaff.clear();await flush();f.advance(6000);
 assert.equal(f.dialog().open,false);assert.equal(f.text(),'');
});
