(() => {
  if(location.hostname!=='freshon-admin-stage-preview-template.onrender.com')return;
  const output=document.querySelector('#result'),startDate='2026-07-17',endDate='2026-09-14';let running=false;
  const summary=samples=>{const a=samples.map(s=>s.ms).sort((a,b)=>a-b);return{success:samples.filter(s=>s.http===200).length,total:samples.length,min:a[0],median:a[Math.floor(a.length/2)],max:a.at(-1)};};
  async function request(path,kind){
    const at=performance.now(),response=await fetch(path,{credentials:'same-origin',cache:'no-store'});let body=null;
    try{body=await response.json();}catch{}
    const sample={http:response.status,ms:Math.round((performance.now()-at)*10)/10,contentType:response.headers.get('content-type'),noStore:/no-store/.test(response.headers.get('cache-control')||''),complete:body?.meta?.complete===true};
    if(kind==='history'&&response.status===200){const rows=Array.isArray(body?.data)?body.data:[];sample.rows=rows.length;sample.phonePresent=rows.filter(r=>Boolean(r.driverPhone)).length;sample.dateValid=rows.every(r=>r.deliveryDate>=startDate&&r.deliveryDate<=endDate);sample.fieldsValid=rows.every(r=>!('ownerPhone'in r)&&!('accessMemo'in r));}
    if(kind==='period'){sample.stores=Array.isArray(body?.data)?body.data.length:0;sample.phase=body?.meta?.phase;sample.progress=body?.meta?.progress;}
    body=null;return sample;
  }
  document.querySelector('#history').onclick=async()=>{if(running)return;running=true;const samples=[];try{for(let i=0;i<10;i++){const r=await request('/api/map-phase2b/private/driver-history?customerCode=S222538&startDate='+startDate+'&endDate='+endDate,'history');samples.push(r);output.textContent=JSON.stringify({kind:'history',samples,summary:summary(samples)},null,2);if(r.http===401)break;}}finally{running=false;}};
  document.querySelector('#period').onclick=async()=>{if(running)return;running=true;const samples=[];try{for(let i=0;i<5;i++){const r=await request('/api/map-phase2b/preview/period?vehicle=101&startDate='+startDate+'&endDate='+endDate,'period');samples.push(r);output.textContent=JSON.stringify({kind:'period',samples,summary:summary(samples)},null,2);if(!r.complete)break;}}finally{running=false;}};
})();
