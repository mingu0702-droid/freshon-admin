// A disconnected employee request cancels its own read, never the employee session.
export function createPrivateDetailReadScope(request,response,{deadline}={}) {
  const controller=new AbortController();
  const abort=()=>controller.abort();
  const close=()=>{if(!response.writableEnded)abort();};
  request.once('aborted',abort);response.once('close',close);
  if(request.aborted||response.destroyed)abort();
  return {signal:controller.signal,deadline,
    canRespond:()=>!controller.signal.aborted&&!response.destroyed&&!response.headersSent&&!response.writableEnded,
    dispose:()=>{request.removeListener('aborted',abort);response.removeListener('close',close);}};
}

export function privateDetailFailure(error,profile={}) {
  const upstream=Number(error?.upstreamStatus)||0;
  const classification=profile.cancelledBy==='CALLER'?'CANCELLED'
    : error?.name==='AbortError'?'TIMEOUT'
    : upstream===403?'SOURCE_FORBIDDEN'
    : error?.failureType==='auth'||upstream===401?'SOURCE_AUTH'
    : upstream===404&&error?.failureType==='upstream'?'NOT_FOUND'
    : error?.failureType==='contract'||error?.failureType==='parse'?'CONTRACT'
    : upstream===429?'SOURCE_RATE_LIMIT':'SOURCE_UNAVAILABLE';
  const mapping={CANCELLED:[499,'DETAIL_REQUEST_CANCELLED'],TIMEOUT:[504,'DETAIL_UPSTREAM_TIMEOUT'],
    SOURCE_AUTH:[502,'DETAIL_SOURCE_AUTH_REQUIRED'],SOURCE_FORBIDDEN:[502,'DETAIL_SOURCE_FORBIDDEN'],
    NOT_FOUND:[404,'DETAIL_NOT_FOUND'],CONTRACT:[502,'DETAIL_INVALID_RESPONSE'],
    SOURCE_RATE_LIMIT:[503,'DETAIL_SOURCE_RATE_LIMITED'],SOURCE_UNAVAILABLE:[502,'PRIVATE_DETAIL_UNAVAILABLE']};
  const [status,code]=mapping[classification];
  return {status,code,classification,source:'UPSTREAM',
    phase:['HEADERS','BODY','PARSE','CONTRACT','DONE'].includes(profile.phase)?profile.phase:'unknown',
    target:['EXEC','OUTPUT'].includes(profile.requestStage)?profile.requestStage:'unknown',
    transportStatus:Number(profile.upstreamStatus)||0,upstreamStatus:upstream,
    requestId:typeof profile.requestId==='string'&&/^[a-f0-9-]{36}$/i.test(profile.requestId)?profile.requestId:null};
}
