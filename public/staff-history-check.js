(() => {
  if(location.hostname!=='freshon-admin-stage-preview-template.onrender.com')return;
  const output=document.querySelector('#result'),startDate='2026-07-17',endDate='2026-09-14';let running=false;
  const summary=samples=>{const a=samples.map(s=>s.ms).sort((a,b)=>a-b),m=Math.floor(a.length/2);return{success:samples.filter(s=>s.http===200).length,total:samples.length,min:a[0],median:a.length%2?a[m]:(a[m-1]+a[m])/2,max:a.at(-1),over5s:samples.filter(s=>s.ms>=5000).length};};
  async function request(path,kind){
    const at=performance.now(),response=await fetch(path,{credentials:'same-origin',cache:'no-store'}),headersAt=performance.now();let body=null;
    let text=await response.text();const bodyAt=performance.now();try{body=JSON.parse(text);}catch{}text='';const parsedAt=performance.now();
    const sample={http:response.status,ms:Math.round((performance.now()-at)*10)/10,contentType:response.headers.get('content-type'),noStore:/no-store/.test(response.headers.get('cache-control')||''),complete:body?.meta?.complete===true};
    Object.assign(sample,{headersMs:+(headersAt-at).toFixed(2),bodyMs:+(bodyAt-headersAt).toFixed(2),parseMs:+(parsedAt-bodyAt).toFixed(2),serverTiming:response.headers.get('server-timing'),receivedAt:response.headers.get('x-request-received-at'),uptimeMs:Number(response.headers.get('x-app-uptime-ms')),hubSentAt:Number(response.headers.get('x-hub-sent-at')),hubExecutionStartAt:Number(response.headers.get('x-hub-execution-start-at')),upstreamStatus:Number(response.headers.get('x-history-upstream-status')),responseKind:response.headers.get('x-history-response-kind'),failurePhase:response.headers.get('x-history-phase')});
    const failure=response.headers.get('x-history-failure');if(failure&&/^[A-Z_]+$/.test(failure))sample.failure=failure;
    if(kind==='history'&&response.status===200){const rows=Array.isArray(body?.data)?body.data:[];sample.rows=rows.length;sample.phonePresent=rows.filter(r=>Boolean(r.driverPhone)).length;sample.dateValid=rows.every(r=>r.deliveryDate>=startDate&&r.deliveryDate<=endDate);sample.fieldsValid=rows.every(r=>!('ownerPhone'in r)&&!('accessMemo'in r));}
    if(kind==='period'){sample.stores=Array.isArray(body?.data)?body.data.length:0;sample.phase=body?.meta?.phase;sample.progress=body?.meta?.progress;}
    body=null;return sample;
  }
  document.querySelector('#history').onclick=async()=>{if(running)return;running=true;const samples=[];try{for(let i=0;i<10;i++){const r=await request('/api/map-phase2b/private/driver-history?customerCode=S222538&startDate='+startDate+'&endDate='+endDate,'history');samples.push(r);output.textContent=JSON.stringify({kind:'history',samples,summary:summary(samples)},null,2);if(r.http===401)break;}}finally{running=false;}};
  document.querySelector('#period').onclick=async()=>{if(running)return;running=true;const samples=[];try{for(let i=0;i<5;i++){const r=await request('/api/map-phase2b/preview/period?vehicle=101&startDate='+startDate+'&endDate='+endDate,'period');samples.push(r);output.textContent=JSON.stringify({kind:'period',samples,summary:summary(samples)},null,2);if(!r.complete)break;}}finally{running=false;}};
})();
