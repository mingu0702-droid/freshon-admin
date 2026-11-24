import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source=readFileSync(new URL('../public/opsmap/map-staff-entry.js',import.meta.url),'utf8');
const stage='https://freshon-admin-stage-preview-template.onrender.com';
const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
function fixture(origin=stage,search=''){
  const fetches=[], loads=[], preloads=[], marks=[], pending=new Map(), timers=new Map();
  let authenticated=false, sequence=0, mapStarted=0;
  const placeholder=(src,optional=false)=>({dataset:{src,...(optional?{staffOptional:'1',module:'1'}:{})}});
  const scripts=[placeholder('core.js'),placeholder('postal.mjs',true),placeholder('dispatch.mjs',true)];
  class Element {
    dataset={};
    style={};
    setAttribute(){}
    remove(){}
  }
  const form=new EventTarget(), fields=new Map();
  form.elements={username:new Element(),password:new Element()};
  form.querySelector=selector=> {
    if(!fields.has(selector))fields.set(selector,new Element());
    return fields.get(selector);
  };
  form.querySelectorAll=()=>[];
  const document=new EventTarget(), window=new EventTarget();
  document.body=Object.assign(new Element(),{append(element){
    if(!element.src)return;
    loads.push(element.src);
    if(element.src==='core.js')element.onload();
    else pending.set(element.src,element);
  }});
  document.head={append:link=>preloads.push(link.href)};
  document.documentElement={dataset:{}};
  document.querySelector=()=>null;
  document.querySelectorAll=selector=>selector.startsWith('script')?scripts:[];
  document.createElement=name=>Object.assign(new Element(),name==='section'?{querySelector:()=>form}:{});
  document.readyState='loading';
  window.addEventListener('map-staff-ready',()=>mapStarted++);
  window.fetch=async(input)=>{
    fetches.push(input);
    const now=Date.now();
    if(input.endsWith('/logout'))authenticated=false;
    return {ok:true, status:200, headers:new Headers(),
      text:async()=>'window.VEHICLE_AREA_DATA = {"vehicles":[]};',
      json:async()=>input.endsWith('/session')?{authenticated,expiresAt:now+100000,idleExpiresAt:now+100000}:{}};
  };
  vm.runInNewContext(source,{window,document,location:{origin,search,href:origin+'/opsmap/'+search},
    Date, performance:{mark:name=>marks.push(name),now:()=>0}, AbortController,DOMException,Event,CustomEvent,URL,URLSearchParams, Request,
    setTimeout(fn,delay){timers.set(++sequence,{fn,delay});return sequence;},clearTimeout(id){timers.delete(id);}});
  return {window,document,marks,fetches,loads,preloads,
    authenticate(value=true){authenticated=value;return window.MapStaffEntry.check();},
    runDeferred(){for(const [id,timer] of timers)if(timer.delay===0){timers.delete(id);timer.fn();}},
    resolve(name){pending.get(name).onload();pending.delete(name);},
    fail(name){pending.get(name).onerror();pending.delete(name);},
    mapStarted:()=>mapStarted};
}

test('Stage initial map work starts while trailing optional modules are held',async()=>{
  const f=fixture();
  await f.authenticate(false);
  assert.deepEqual(f.loads,[]);
  assert.deepEqual(f.fetches,['/api/map-phase2b/auth/session']);
  await f.authenticate();
  assert.equal(f.mapStarted(),1);
  assert.deepEqual(f.loads,['core.js']);
  assert.deepEqual(f.preloads,['core.js']);
  assert.equal(f.document.body.dataset.mapStaffState,'authenticated');
  assert.ok(f.marks.includes('opsmap-staff-ready'));
  f.runDeferred();
  assert.deepEqual(f.loads,['core.js','postal.mjs']);
  f.resolve('postal.mjs');
  await flush();
  assert.deepEqual(f.loads,['core.js','postal.mjs','dispatch.mjs']);
  f.resolve('dispatch.mjs');
  await flush();
});

test('logout blocks the stale optional queue and renewed auth avoids duplicate loads',async()=>{
  const f=fixture();
  await f.authenticate();
  f.runDeferred();
  await f.window.MapStaffEntry.logout();
  assert.equal(f.window.MapStaffEntry.session(),null);
  await assert.rejects(f.window.fetch('/api/map-phase2b/private/dispatch-reference-day'),{status:401});
  f.resolve('postal.mjs');
  await flush();
  assert.deepEqual(f.loads,['core.js','postal.mjs']);
  await f.authenticate();
  f.runDeferred();
  assert.deepEqual(f.loads,['core.js','postal.mjs','dispatch.mjs']);
  f.resolve('dispatch.mjs');
  await flush();
  assert.equal(f.mapStarted(),2);
});

test('a fresh staff session shares the prior pending static load',async()=>{
  const f=fixture();
  await f.authenticate();
  f.runDeferred();
  await f.window.MapStaffEntry.logout();
  await f.authenticate();
  f.runDeferred();
  assert.deepEqual(f.loads,['core.js','postal.mjs']);
  f.resolve('postal.mjs');
  await flush();
  assert.deepEqual(f.loads,['core.js','postal.mjs','dispatch.mjs']);
  f.resolve('dispatch.mjs');
});

test('optional tab load failure leaves map ready and does not block the next tab',async()=>{
  const f=fixture();
  await f.authenticate();
  f.runDeferred();
  f.fail('postal.mjs');
  await flush();
  assert.deepEqual(f.loads,['core.js','postal.mjs','dispatch.mjs']);
  assert.equal(f.mapStarted(),1);
  assert.equal(f.document.body.dataset.mapStaffState,'authenticated');
  f.resolve('dispatch.mjs');
});

test('review-query and non-Stage preserve the original dependency sequence',async()=>{
  for(const f of [fixture(stage,'?dispatch-review=map'),fixture('https://freshon-admin.onrender.com')]){
    const ready=f.authenticate();
    await flush();
    assert.deepEqual(f.preloads,['core.js','postal.mjs','dispatch.mjs']);
    assert.deepEqual(f.loads,['core.js','postal.mjs']);
    assert.equal(f.mapStarted(),0);
    f.resolve('postal.mjs');await flush();
    assert.equal(f.mapStarted(),0);
    f.resolve('dispatch.mjs');await ready;
    assert.equal(f.mapStarted(),1);
  }
});
