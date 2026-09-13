(() => {
  'use strict';
  const allowedHost = 'freshon-admin-stage-preview-template.onrender.com';
  const form = document.querySelector('#probeForm'), state = document.querySelector('#state'), output = document.querySelector('#results');
  const opened = performance.now(); let running = false, cancelled = false, controller;
  const results = [];
  const median = a => { const s = a.slice().sort((a,b)=>a-b); return s.length ? s[Math.floor(s.length/2)] : null; };
  const sensitive = key => /password|passwd|rawmemo|accessinfo|accessmemo|phone|telephone|detailaddress|specialremark/i.test(key.replace(/[_\s-]/g,''));
  function countSensitive(value, parent='') {
    if (!value || typeof value !== 'object') return 0;
    return Object.entries(value).reduce((n,[k,v]) => n + Number(sensitive(k) || (parent==='location' && k==='message')) + countSensitive(v,k),0);
  }
  async function request(label, path, options={}) {
    if (cancelled) throw new Error('CANCELLED');
    controller = new AbortController(); const timer = setTimeout(()=>controller.abort(),120000), start = performance.now();
    let row = {label,status:0,browserTotalMs:0}, parsed;
    try {
      const res = await fetch(path,{...options,credentials:'same-origin',cache:'no-store',signal:controller.signal});
      row.headersMs = +(performance.now()-start).toFixed(2); row.status=res.status;
      row.receivedAt=res.headers.get('x-request-received-at'); row.processUptimeMs=Number(res.headers.get('x-app-uptime-ms'))||null;
      row.serverTiming={};
      for (const part of (res.headers.get('server-timing')||'').split(',')) { const match=part.trim().match(/^([A-Za-z]+);dur=([\d.]+)$/); if(match)row.serverTiming[match[1]]=Number(match[2]); }
      const policy=res.headers.get('x-staff-cookie-policy'); if(policy)try{const p=JSON.parse(policy);row.cookie={httpOnly:p.httpOnly===true,secure:p.secure===true,sameSite:p.sameSite==='Strict'?'Strict':'OTHER'};}catch{}
      let text=await res.text(); const parseStart=performance.now();
      try { parsed=JSON.parse(text); } catch { row.json=false; } text='';
      row.browserParseMs=+(performance.now()-parseStart).toFixed(2);
      if(label==='session') row.authenticated=parsed?.authenticated===true;
      if(label==='private') {row.ok=parsed?.ok===true;row.noStore=/(?:^|[,\s])no-store(?:$|[,\s])/.test(res.headers.get('cache-control')||'');}
      if(label==='public') row.sensitiveFields=countSensitive(parsed);
      parsed=null;
    } catch {row.error=cancelled?'CANCELLED':'NETWORK_OR_TIMEOUT';}
    finally {clearTimeout(timer);row.browserTotalMs=+(performance.now()-start).toFixed(2);results.push(row);output.textContent=JSON.stringify({requests:results},null,2);}
    return row;
  }
  const post = body => ({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  document.querySelector('#cancel').onclick=()=>{cancelled=true;controller?.abort();};
  form.addEventListener('submit',async event=>{
    event.preventDefault(); if(running)return;
    if(location.hostname!==allowedHost||location.protocol!=='https:'){state.textContent='Stage 전용 검증입니다. 실행하지 않았습니다.';return;}
    let id=form.elements.id.value,password=form.elements.password.value,adminToken=form.elements.adminToken.value;
    form.reset();running=true;cancelled=false;results.length=0;form.querySelector('button').disabled=true;
    const coldEligible=performance.now()-opened>=15*60*1000;
    const privatePath='/api/map-phase2b/private/customer-detail?customerCode=S222538&date=2026-08-28';
    const delivery='/api/collector/delivery?date=2026-08-28&page=0&pageSize=1';
    try {
      // No preliminary network request: an idle first login can be measured as cold.
      for(let i=0;i<5&&!cancelled;i++){
        state.textContent=(i+1)+'/5회 · 인증 및 단일 고객 조회 계측 중';
        const login=await request('login','/api/map-phase2b/auth/login',post({id,password}));
        login.iteration=i+1;login.coldCandidate=i===0&&coldEligible&&login.processUptimeMs!=null&&login.processUptimeMs<60000;
        if(login.status!==200)break;
        await request('session','/api/map-phase2b/auth/session');
        await request('private',privatePath);
        await request('public','/api/map-phase2b/preview/detail?customerCode=S222538');
        if(i===0){
          await request('staffCollector',delivery);
          await request('staffAdmin','/api/map-phase2b/admin/status');
          await request('adminCollector',delivery,{headers:{'x-admin-token':adminToken}});
          adminToken='';
        }
        await request('logout','/api/map-phase2b/auth/logout',post({}));
        await request('afterLogoutPrivate',privatePath);
      }
      password='';id='';adminToken='';
      if(!cancelled){
        await request('anonymousCollector',delivery);
        await request('wrongLogin','/api/map-phase2b/auth/login',post({id:'INVALID_SYNTHETIC_ID',password:'INVALID_SYNTHETIC_PASSWORD'}));
      }
    } finally {
      id='';password='';adminToken='';form.reset();
      // Cancellation must not leave a verification session behind.
      try {await fetch('/api/map-phase2b/auth/logout',{...post({}),credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(10000)});}catch{}
      const summaries={};for(const label of ['login','session','logout','private','public']){const rows=results.filter(r=>r.label===label&&!r.coldCandidate);summaries[label]={count:rows.length,ms:rows.map(r=>r.browserTotalMs),medianMs:median(rows.map(r=>r.browserTotalMs))};}
      output.textContent=JSON.stringify({requests:results,summaries,coldMeasured:results.some(r=>r.coldCandidate),cancelled},null,2);
      state.textContent=cancelled?'중지됨 · 비밀값 제거 완료':'측정 완료 · 비밀값 제거 완료';running=false;form.querySelector('button').disabled=false;
    }
  });
})();
