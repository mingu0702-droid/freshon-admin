/* Read-only freshness is public. Candidate mutation requires the existing admin token. */
(() => {
  const button=document.createElement('button');button.id='mapDataSync';button.textContent='지도 데이터 동기화';
  document.querySelector('#mapDateBar').append(button);
  const panel=document.createElement('details');panel.id='mapDataHealth';panel.className='block';
  const summary=document.createElement('summary');summary.textContent='지도 데이터 최신화 상태';panel.append(summary);
  const status=document.createElement('p');status.setAttribute('role','status');panel.append(status);
  const action=document.createElement('button');action.textContent='관리자 로그인 필요 · 저장분 증분 요청';action.disabled=true;panel.append(action);
  document.querySelector('#leftPanel .head').after(panel);
  let busy=false,last=null,poll=null,pollCount=0,dialogOpen=false,submitted=false;
  const api=window.MapDataSync={onPublished:null};
  async function refresh(){
    if(busy)return;busy=true;button.disabled=true;
    try{
      const [r,s]=await Promise.all([fetch('/api/map-phase2b/preview/data-status',{cache:'no-store'}),fetch('/api/map-phase2b/preview/status',{cache:'no-store'})]);
      if(!r.ok)throw new Error('STATUS');const d=(await r.json()).data,snap=s.ok?(await s.json()).snapshot:null;
      const target=d.customer.freshon&&d.customer.delivery?[d.customer.freshon,d.customer.delivery].sort()[0]:null,job=d.job;
      const active=job&&(job.publication==='PENDING'||!['DONE','ERROR','UP_TO_DATE'].includes(job.phase));
      status.textContent='Customer Freshon '+(d.customer.freshon||'미확인')+' / Delivery '+(d.customer.delivery||'미확인')
        +' · 게시모델 '+(d.published.endDate||'미확인')+' · 현재 지도 '+(d.live.periodLatest||'준비 중')
        +' · Snapshot '+(snap?.latest||'미확인')+(snap?.stale?' (stale)':'')
        +' · 자동 최신화 미설정 · 화면 확인 '+new Date().toLocaleTimeString('ko-KR')
        +(job?' · 작업 '+job.phase+(job.publication==='PENDING'?' (게시 포인터 확인 중)':'')+' '+(job.sendAt||0)+'/'+(job.shards||0)+(job.lastError?' · '+job.lastError:''):'');
      action.disabled=!target||!d.live.ready||target<=d.published.endDate||active||job?.phase==='ERROR'||job?.publication==='ERROR';
      action.textContent=!d.live.ready?'지도 복원 중 · 동기화 대기':active?'동기화 진행 중':job?.phase==='ERROR'||job?.publication==='ERROR'?'이전 작업 실패 · 관리자 확인 필요':!target?'수집 완료일 확인 필요':target<=d.published.endDate?'저장분이 이미 반영되어 있습니다':'관리자 로그인 필요 · 저장분 증분 요청';
      if(!active)submitted=false;
      if(last!==d.live.generation&&d.live.ready){const old=last;last=d.live.generation;if(old!==null)await api.onPublished?.(d.live);}
      if(active&&pollCount>0&&pollCount++<21){clearTimeout(poll);poll=setTimeout(refresh,30000);}
      return d;
    }catch{status.textContent='최신화 상태 확인 실패 · 기존 지도 유지 · 다시 버튼을 눌러 확인해 주세요.';action.disabled=true;action.textContent='상태 확인 후 관리자 요청 가능';}
    finally{busy=false;button.disabled=false;}
  }
  button.onclick=()=>{document.querySelector('#mapDateBar').append(panel);panel.open=true;void refresh();};
  action.onclick=()=>{
    if(action.disabled||dialogOpen||submitted)return;dialogOpen=true;
    const dialog=document.createElement('dialog'),form=document.createElement('form'),label=document.createElement('label'),input=document.createElement('input'),submit=document.createElement('button'),close=document.createElement('button'),message=document.createElement('p');
    label.textContent='기존 관리자 토큰 (직원 비밀번호 아님)';input.type='password';input.autocomplete='off';input.required=true;label.append(input);
    submit.type='submit';submit.textContent='저장된 Customer 데이터만 증분 요청';close.type='button';close.textContent='취소';
    form.append(label,submit,close,message);dialog.append(form);document.body.append(dialog);
    const discard=()=>{input.value='';dialog.close();dialog.remove();dialogOpen=false;};
    close.onclick=discard;dialog.addEventListener('cancel',discard);
    form.onsubmit=async event=>{
      event.preventDefault();if(submitted)return;submitted=true;submit.disabled=true;let token=input.value;input.value='';
      try{
        const response=await fetch('/api/map-phase2b/admin/model-sync',{method:'POST',cache:'no-store',headers:{'content-type':'application/json','x-admin-token':token},body:'{}'});
        token='';if(!response.ok){submitted=false;message.textContent=response.status===401?'관리자 로그인 필요':response.status===403?'요청 출처가 허용되지 않았습니다.':'요청 결과 미확인 · 상태를 확인해 주세요.';return;}
        const value=await response.json();discard();panel.open=true;
        status.textContent='작업 '+(value.data?.phase||'요청 접수')+' · 완료가 아닙니다. 검증·게시 결과를 기다립니다.';
        pollCount=1;clearTimeout(poll);poll=setTimeout(refresh,21000);
      }catch{message.textContent='요청 결과 미확인 · 중복 실행 대신 상태를 확인해 주세요.';action.disabled=true;}
      finally{token='';input.value='';submit.disabled=false;}
    };dialog.showModal();
  };
  void refresh();
})();
