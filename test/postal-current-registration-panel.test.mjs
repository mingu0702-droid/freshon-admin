import test from 'node:test';
import assert from 'node:assert/strict';
import {createCurrentRegistrationPanel} from '../public/opsmap/postal-current-registration-panel.mjs';

function element(){
  let text='', children=[];
  return {hidden:false,open:false,
    get children(){return children;},
    get textContent(){return text+children.map(child=>child.textContent).join('');},
    set textContent(value){text=value??'';children=[];},
    replaceChildren(...value){text='';children=value;},
    append(...value){children.push(...value);}};
}

test('current registration loads lazily, pins a distinct region roster, and clears on version mismatch',async t=>{
  const previous=globalThis.document;
  globalThis.document={createElement:element};
  t.after(()=>{globalThis.document=previous;});
  const section=element(),summary=element(),roster=element();
  section.querySelector=selector=>selector==='[data-current-postal-summary]'?summary:roster;
  const generation='a'.repeat(64),registry='b'.repeat(64),requests=[],open=[];
  let stale=false;
  const panel=createCurrentRegistrationPanel(section,{
    async read(endpoint,params,signal){
      requests.push({endpoint,params,signal});
      if(stale)throw Object.assign(Error('changed'),{status:409});
      if(!params.area)return {generation,registry,registered:16084,registeredScope:17052};
      return {generation,registry,area:Number(params.area),offset:params.offset,registered:1,next:null,
        members:[{code:'S1',name:'Fixture store'}]};
    },
    openStore:row=>open.push(row.code)
  });
  panel.update({available:true,generation,center:'all'});
  assert.equal(requests.length,0);
  section.open=true;section.ontoggle();
  await new Promise(setImmediate);
  assert.match(summary.textContent,/16,084.*968/);
  panel.update({available:true,generation,center:'all',area:'06241'});
  await new Promise(setImmediate);
  assert.equal(requests.length,2);
  assert.equal(requests[1].params.registry,registry);
  assert.match(roster.textContent,/06241.*현재 등록 1곳/);
  roster.children[1].children[0].children[0].onclick();
  assert.deepEqual(open,['S1']);
  stale=true;
  panel.update({available:true,generation,center:'all',area:'06241',refresh:true});
  await new Promise(setImmediate);
  assert.match(summary.textContent,/버전이 달라/);
  assert.doesNotMatch(roster.textContent,/Fixture store/);
  panel.update();
  assert.equal(section.hidden,true);
  assert.equal(summary.textContent,'');
});
