const fmt=new Intl.NumberFormat('ko-KR');
const digest=/^[a-f0-9]{64}$/;
const node=(tag,text)=>Object.assign(document.createElement(tag),{textContent:text});
const count=value=>Number.isSafeInteger(value)&&value>=0;
const button=(label,onclick)=>Object.assign(node('button',label),{type:'button',onclick});

export function createCurrentRegistrationPanel(section,{read,openStore}) {
  const summaryNode=section.querySelector('[data-current-postal-summary]');
  const rosterNode=section.querySelector('[data-current-postal-roster]');
  let scope,area,summary,request;
  function cancel(){request?.abort();request=null;}
  function stillActive(controller){return request===controller&&!controller.signal.aborted&&section.open&&!section.hidden;}

  async function show(offset=0,refresh=false) {
    cancel();
    if(section.hidden||!section.open||!scope)return;
    const controller=request=new AbortController();
    const selected=area;
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(12000)]);
    const params=scope;
    rosterNode.replaceChildren();
    if(!summary||refresh){
      summary=null;
      summaryNode.textContent='현재 등록 현황을 확인하는 중입니다.';
    }
    try{
      if(!summary){
        const data=await read('current-registration',params,signal);
        if(!stillActive(controller))return;
        if(data.generation!==params.generation||!digest.test(data.registry)||!count(data.registered)||!count(data.registeredScope)||
            data.registered>data.registeredScope)throw Error('POSTAL_CURRENT_REGISTRATION_CHANGED');
        summary=data;
        summaryNode.textContent='현재 등록 '+fmt.format(data.registeredScope)+'곳 중 우편번호 연결 '+fmt.format(data.registered)+
          '곳 · 연결 미확인 '+fmt.format(data.registeredScope-data.registered)+'곳';
      }
      if(!selected){rosterNode.textContent='지도에서 우편번호 구역을 선택하면 현재 등록 매장을 볼 수 있습니다.';return;}
      rosterNode.textContent='우편번호 '+selected+' · 등록 매장을 확인하는 중입니다.';
      const data=await read('current-registration',{...params,registry:summary.registry,area:selected,offset},signal);
      if(!stillActive(controller))return;
      if(data.generation!==params.generation||data.registry!==summary.registry||Number(selected)!==data.area||
          data.offset!==offset||!Array.isArray(data.members)||data.members.length>12||!count(data.registered)) {
        throw Error('POSTAL_CURRENT_REGISTRATION_CHANGED');
      }
      const title=node('h3','우편번호 '+selected+' · 현재 등록 '+fmt.format(data.registered)+'곳');
      const list=node('ul','');
      for(const member of data.members){
        const item=node('li','');
        item.append(button((member.name||member.code)+' · '+member.code,()=>openStore?.(member)));
        list.append(item);
      }
      rosterNode.replaceChildren(title,data.members.length?list:node('p','연결이 확인된 현재 등록 매장이 없습니다.'));
      if(offset)rosterNode.append(button('이전',()=>void show(Math.max(0,offset-12))));
      if(count(data.next)&&data.next>offset)rosterNode.append(button('다음',()=>void show(data.next)));
    }catch(error){
      if(!stillActive(controller))return;
      summary=null;
      summaryNode.textContent=error.status===409||error.message==='POSTAL_CURRENT_REGISTRATION_CHANGED'?
        '등록 원장과 우편번호 연결 자료의 버전이 달라 현재 등록을 확인할 수 없습니다.':'현재 등록 현황을 확인하지 못했습니다.';
      rosterNode.replaceChildren(button('다시 확인',()=>void show(0,true)));
    }finally{if(request===controller)request=null;}
  }
  section.ontoggle=()=>{
    if(section.open)void show();
    else{cancel();summary=null;summaryNode.replaceChildren();rosterNode.replaceChildren();}
  };
  return {
    update({available,generation,center,area:selection,refresh=false}={}){
      const valid=Boolean(available&&digest.test(generation));
      const nextArea=/^\d{5}$/.test(selection||'')?selection:null;
      const changed=!scope||scope.generation!==generation||scope.center!==center;
      const areaChanged=area!==nextArea;
      section.hidden=!valid;
      if(!valid){
        cancel();scope=area=summary=null;
        summaryNode.replaceChildren();rosterNode.replaceChildren();
        return;
      }
      scope={generation,center};
      area=nextArea;
      if(changed)summary=null;
      if(changed||areaChanged||refresh&&!request)void show(0,refresh);
    }
  };
}
