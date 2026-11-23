const tabs=document.querySelector('#approvedSiteHeader nav');
const workspace=document.querySelector('body > main.workspace');
const sidebar=workspace?.querySelector('#leftPanel');
const bridge=window.MapUiLocalBridge;

if (tabs && sidebar && bridge) {
  const desktop=matchMedia('(min-width:901px) and (any-pointer:fine)');
  const tab=document.createElement('button');
  Object.assign(tab,{id:'modeDispatchReference',className:'tab',type:'button',textContent:'배차 참고'});
  tab.setAttribute('aria-pressed','false');
  tab.setAttribute('aria-controls','dispatchReference');

  let feature,opening,previous,stylesheet;
  const session=()=>window.MapStaffEntry?.session();
  async function read(path,params,signal,wait=15_000) {
    const timeout=AbortSignal.timeout(wait);
    const response=await fetch('/api/map-phase2b/private/'+path+'?'+new URLSearchParams(params),{
      credentials:'same-origin',cache:'no-store',signal:signal?AbortSignal.any([signal,timeout]):timeout,
    });
    if (!response.ok || !session()) throw Error('DISPATCH_REFERENCE_UNAVAILABLE');
    return response.json();
  }
  async function readDay(date,{signal}) {
    const result=await read('dispatch-reference-day',{date},signal);
    if (result.contract!=='opsmap-dispatch-reference-v1'||result.date!==date||result.center!=='osan') throw Error('DISPATCH_REFERENCE_DAY_INVALID');
    return result;
  }
  async function readPeriod(end,days,{signal}) {
    const result=await read('dispatch-reference-period',{end,days},signal,90_000);
    if (result.contract!=='opsmap-dispatch-period-v1'||result.end!==end||result.days!==days||result.center!=='osan') {
      throw Error('DISPATCH_REFERENCE_PERIOD_INVALID');
    }
    return result;
  }
  async function readOutline(id,{signal}) {
    const result=await read('shadow-coverage/postal/outline',{id},signal);
    return result.data?.id===id?result.data:null;
  }

  function close(restoreView=true) {
    opening=null;
    tab.removeAttribute('aria-busy');
    if (!previous) return;
    for (const button of previous) button.setAttribute('aria-pressed','true');
    previous=null;
    tab.setAttribute('aria-pressed','false');
    document.body.classList.remove('dispatch-reference-open');
    feature.close({restoreView});
    requestAnimationFrame(()=>{if (!previous && session()) bridge.state.map?.relayout();});
  }

  tab.onclick=async ()=>{
    if (opening||previous||!session()||!desktop.matches) return;
    const attempt=opening={};
    tab.setAttribute('aria-busy','true');
    try {
      if (!feature) {
        stylesheet ||= Object.assign(document.createElement('link'),{
          rel:'stylesheet',href:new URL('./dispatch-reference.css?v=20261123-review',import.meta.url),
        });
        if (!stylesheet.isConnected) document.head.append(stylesheet);
        const {mountDispatchReference}=await import('./dispatch-reference-map.mjs?v=20261124-period-proof');
        if (opening!==attempt||!session()) return;
        feature=mountDispatchReference({workspace,sidebar,bridge,readDay,readPeriod,readOutline});
      }
      window.dispatchEvent(new Event('map-dispatch-reference-open'));
      previous=[...tabs.querySelectorAll('button[aria-pressed="true"]')];
      for (const button of previous) button.setAttribute('aria-pressed','false');
      document.body.classList.add('dispatch-reference-open');
      tab.textContent='배차 참고';
      tab.setAttribute('aria-pressed','true');
      feature.open();
    } catch {
      if (opening===attempt) {
        close();
        tab.textContent='배차 참고 다시 열기';
      }
    } finally {
      if (opening===attempt) {
        opening=null;
        tab.removeAttribute('aria-busy');
      }
    }
  };

  tabs.addEventListener('click',event=>{
    const target=event.target.closest('button');
    if (target&&target!==tab) close(target.id!=='modeDaily'&&target.id!=='modePeriod');
  },true);
  workspace.addEventListener('keydown',event=>{
    if (event.key!=='Escape'||!event.target.closest('.dispatch-controls,.dispatch-details')) return;
    event.stopPropagation();
    close();
    tabs.querySelector('button[aria-pressed="true"]:not([hidden])')?.focus();
  });
  function sync() {
    if (session()&&desktop.matches) {
      if (!tab.isConnected) tabs.append(tab);
    } else {
      close();
      tab.remove();
    }
  }
  desktop.addEventListener('change',sync);
  window.addEventListener('map-staff-ready',sync);
  window.addEventListener('pagehide',()=>close(false));
  window.MapStaffEntry?.registerPurge(()=>{
    close(false);
    feature?.clear();
    tab.remove();
  });
  sync();
}
