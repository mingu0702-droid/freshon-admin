(function(root){
  'use strict';
  const states=new Set(['success','partial','error','disabled','empty']);
  const terminal=new Set(['QUOTA_EXCEEDED','AUTHENTICATION_FAILED','PERMISSION_DENIED','CALL_POLICY_BLOCKED']);
  function requestBody(draft,requestId){
    if(!draft||draft.mode!=='MANUAL_WAYPOINTS'||!Array.isArray(draft.waypoints)||draft.waypoints.length>30)throw Error('출발·도착과 최대 30개 경유지를 확인해 주세요.');
    const ids=new Set();
    const point=(p,order)=>{if(!p||typeof p.id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(p.id)||ids.has(p.id)||typeof p.lat!=='number'||typeof p.lng!=='number'||!Number.isFinite(p.lat)||!Number.isFinite(p.lng)||p.lat<33||p.lat>39.5||p.lng<124||p.lng>132)throw Error('확인된 국내 위도·경도가 필요합니다.');ids.add(p.id);return{id:p.id,lat:p.lat,lng:p.lng,...(order===undefined?{}:{order})};};
    return {mode:'MANUAL_WAYPOINTS',requestId,origin:point(draft.origin),waypoints:draft.waypoints.map((p,i)=>{if(p.order!==i+1)throw Error('경유 순서를 확인해 주세요.');return point(p,p.order);}),destination:point(draft.destination)};
  }
  function createController({fetchImpl=root.fetch.bind(root),onChange,timeoutMs=60000}){
    if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw Error('INVALID_TIMEOUT');
    let generation=0,active=null,blocked=null;
    function cancel(){generation++;active?.abort();active=null;onChange({state:'idle'});}
    async function load(draft){
      if(active)return; // Explicit duplicate clicks do not reserve another call.
      blocked=null;
      const requestId=++generation,body=requestBody(draft,requestId),controller=new AbortController();active=controller;
      let timer,stop;const timeout=new Promise((_,reject)=>{stop=()=>reject(Error('TIMEOUT'));controller.signal.addEventListener('abort',stop,{once:true});timer=setTimeout(()=>controller.abort(),timeoutMs);});onChange({state:'loading',requestId});
      try{
        const response=await Promise.race([timeout,fetchImpl('/api/map-phase2b/private/manual-road-route',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal})]);
        if(requestId!==generation)return;
        if(!response.ok){const code=await Promise.race([timeout,root.KakaoDirectionsAdapter.responseError(response)]);if(requestId!==generation)return;if(terminal.has(code))blocked=code;onChange({state:'error',error:code,requestId});return;}
        const payload=await Promise.race([timeout,(async()=>{if(!response.body?.getReader)throw Error('INVALID_RESPONSE');const reader=response.body.getReader(),parts=[];let bytes=0;try{for(;;){const item=await Promise.race([timeout,reader.read()]);if(item.done)break;bytes+=item.value.byteLength;if(bytes>8388608)throw Error('RESPONSE_TOO_LARGE');parts.push(item.value);}}finally{void reader.cancel().catch(()=>{});reader.releaseLock();}const joined=new Uint8Array(bytes);let offset=0;for(const part of parts){joined.set(part,offset);offset+=part.byteLength;}return JSON.parse(new TextDecoder().decode(joined));})()]);if(requestId!==generation)return;
        if(controller.signal.aborted)throw Error('TIMEOUT');
        if(!response.ok||payload.ok!==true){const allowed=new Set(['STAFF_LOGIN_REQUIRED','AUTHENTICATION_FAILED','PERMISSION_DENIED','QUOTA_EXCEEDED','CALL_POLICY_BLOCKED','FEATURE_DISABLED','KEY_MISSING','CALL_POLICY_UNCONFIRMED','PERSISTENT_BUDGET_REQUIRED','NO_ROAD_ROUTE']);const errorCode=typeof payload.error==='string'?payload.error:payload.error?.code;const code=allowed.has(errorCode)?errorCode:root.KakaoDirectionsAdapter.httpError(response.status);if(terminal.has(code))blocked=code;onChange({state:'error',error:code});return;}
        let data=payload.data;
        if(payload.format==='KAKAO_MOBILITY_RAW_V1'){if(data?.mode!==body.mode||data.requestId!==requestId)throw Error('INVALID_RESPONSE');data=root.KakaoDirectionsAdapter.fromProvider(data.providerResponse,body);}
        if(!data||data.mode!==body.mode||data.requestId!==requestId||!states.has(data.state))throw Error('INVALID_RESPONSE');
        if(['success','partial'].includes(data.state)){
          const full=data.state==='success',legs=body.waypoints.length+1;
          const points=[body.origin,...body.waypoints,body.destination],expectedStationary=points.slice(0,-1).flatMap((p,i)=>p.lat===points[i+1].lat&&p.lng===points[i+1].lng?[i]:[]);
          const stationary=data.stationaryLegs||[];
          if(!Array.isArray(stationary)||JSON.stringify(stationary)!==JSON.stringify(expectedStationary))throw Error('INVALID_RESPONSE');
          const stationarySet=new Set(stationary),allStationary=stationary.length===legs;
          if((data.source!=='kakao-directions'&&!(data.source==='stationary-stops'&&allStationary&&data.noDrivingRequired===true))||data.isGpsActual!==false||data.totalLegs!==legs||!Number.isInteger(data.coveredLegs)||data.coveredLegs<1||data.coveredLegs>legs||data.complete!==full||full&&data.coveredLegs!==legs||!full&&data.coveredLegs===legs||![data.distanceMeters,data.durationSeconds].every(v=>typeof v==='number'&&Number.isFinite(v)&&v>=0)||!Array.isArray(data.chunks))throw Error('INVALID_RESPONSE');
          const covered=new Set();let nextLeg=0,successful=0,vertexCount=0;
          for(const chunk of data.chunks){
            if(!chunk||!['success','error','skipped'].includes(chunk.state)||!Number.isInteger(chunk.startLeg)||!Number.isInteger(chunk.endLeg)||chunk.startLeg!==nextLeg||chunk.endLeg<chunk.startLeg||chunk.endLeg>=legs)throw Error('INVALID_RESPONSE');
            nextLeg=chunk.endLeg+1;
            if(chunk.state!=='success')continue;
            successful++;
            if(!Array.isArray(chunk.geometry)||(!chunk.geometry.length&&Array.from({length:chunk.endLeg-chunk.startLeg+1},(_,i)=>chunk.startLeg+i).some(i=>!stationarySet.has(i))))throw Error('INVALID_RESPONSE');
            const geometryLegs=new Set();
            for(const road of chunk.geometry){
              if(!Number.isInteger(road.legOffset)||stationarySet.has(chunk.startLeg+road.legOffset)||road.legOffset<0||road.legOffset>chunk.endLeg-chunk.startLeg||!Array.isArray(road.latLngs)||road.latLngs.length<2||!road.latLngs.every(p=>Array.isArray(p)&&p.length===2&&p.every(v=>typeof v==='number'&&Number.isFinite(v))&&p[0]>=33&&p[0]<=39.5&&p[1]>=124&&p[1]<=132))throw Error('INVALID_RESPONSE');
              vertexCount+=road.latLngs.length;if(vertexCount>100000)throw Error('INVALID_RESPONSE');geometryLegs.add(road.legOffset);
            }
            for(let leg=chunk.startLeg;leg<=chunk.endLeg;leg++){if(covered.has(leg)||(!geometryLegs.has(leg-chunk.startLeg)&&!stationarySet.has(leg)))throw Error('INVALID_RESPONSE');covered.add(leg);}
          }
          if(!successful||nextLeg!==legs||covered.size!==data.coveredLegs||data.distanceMeters>=1500000)throw Error('INVALID_RESPONSE');
          if(stationary.length&&(!Array.isArray(data.legs)||allStationary&&(data.distanceMeters!==0||data.durationSeconds!==0)))throw Error('INVALID_RESPONSE');
          if(data.legs!==undefined){if(!Array.isArray(data.legs)||data.legs.length!==data.coveredLegs)throw Error('INVALID_RESPONSE');const indexes=new Set();let distance=0,duration=0;for(const leg of data.legs){if(!covered.has(leg?.index)||indexes.has(leg.index)||![leg.distanceMeters,leg.durationSeconds].every(n=>Number.isSafeInteger(n)&&n>=0)||stationarySet.has(leg.index)&&(leg.distanceMeters!==0||leg.durationSeconds!==0))throw Error('INVALID_RESPONSE');indexes.add(leg.index);distance+=leg.distanceMeters;duration+=leg.durationSeconds;}if(Math.abs(distance-data.distanceMeters)>legs||Math.abs(duration-data.durationSeconds)>legs)throw Error('INVALID_RESPONSE');}
        }
        blocked=[data.error,...(data.chunks||[]).map(chunk=>chunk.error)].find(code=>terminal.has(code))||null;
        onChange(data);return data;
      }catch(error){if(requestId===generation)onChange({state:'error',error:controller.signal.aborted?'TIMEOUT':error.code==='NO_ROAD_ROUTE'?'NO_ROAD_ROUTE':'ROAD_ROUTE_FAILED'});}
      finally{clearTimeout(timer);controller.signal.removeEventListener('abort',stop);if(requestId===generation)active=null;}
    }
    return {load,cancel,isLoading:()=>Boolean(active)};
  }
  function describe(data){
    if(!data||data.state==='idle')return '출발지와 목적지를 선택해 주세요.';
    if(data.state==='loading')return '입력한 순서로 도로경로 조회 중…';
    if(data.state==='empty')return '입력한 지점의 도로경로 0건 · 거리·시간 미확인';
    if(data.state==='success')return data.noDrivingRequired?'모든 방문지가 같은 위치에 있습니다.':'자동차 경로 · 현재 교통 기준';
    const reasons={INVALID_MANUAL_ROUTE:'출발·경유·도착 입력을 확인해 주세요.',INVALID_COORDINATE:'확인된 국내 위도·경도가 필요합니다.',DUPLICATE_COORDINATE:'이미 추가한 위치입니다.',INVALID_WAYPOINT_ORDER:'경유 순서를 확인해 주세요.',WAYPOINT_LIMIT:'경유지는 최대 30개입니다.'};
    return reasons[data.error]||root.RoadRouteUi.describe(data);
  }
  root.ManualRoadRouteUi={requestBody,createController,describe};
})(typeof window==='object'?window:globalThis);

