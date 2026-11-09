const protectedActions=new Set(['customerDetail','staffCustomerDetail','customerSearch','customerRegistry']);
const execUrl=/^\/macros\/s\/[A-Za-z0-9_-]{20,}\/exec$/;
function protectedEndpoint(raw,secret) {
  let url;
  try { url=new URL(raw); } catch { throw Error('PRIVATE_READER_CONFIGURATION_REQUIRED'); }
  if(url.origin!=='https://script.google.com'||url.username||url.password||url.search||url.hash||
      !execUrl.test(url.pathname)||typeof secret!=='string'||secret.length<32||secret.length>512)
    throw Error('PRIVATE_READER_CONFIGURATION_INVALID');
  return {url:url.href,secret,isolated:true};
}
export function privateReaderEndpoint(action,env=process.env){
  if(action==='datedAssignments'&&env.RENDER_SERVICE_ID==='srv-da47hugu01pc73etpfa0'&&
      env.RENDER_EXTERNAL_URL==='https://freshon-admin-stage-preview-template.onrender.com'&&
      env.OPSMAP_STAGE_DATED_READER_APPROVED==='1'){
    const endpoint=protectedEndpoint(env.OPSMAP_STAGE_DATED_READER_URL,env.OPSMAP_STAGE_DATED_READER_SECRET);
    if(endpoint.url===env.HUB_API_URL||endpoint.secret===env.HUB_API_SECRET||endpoint.secret===env.OPSMAP_PRIVATE_READER_SECRET)
      throw Error('PRIVATE_READER_CONFIGURATION_INVALID');
    return endpoint;
  }
  if(action==='customerRegistry'&&env.OPSMAP_PRIVATE_READER_ENABLED!=='true')throw Error('PRIVATE_READER_CONFIGURATION_REQUIRED');
  if(!protectedActions.has(action)||env.OPSMAP_PRIVATE_READER_ENABLED!=='true')return {url:env.HUB_API_URL,secret:env.HUB_API_SECRET,isolated:false};
  return protectedEndpoint(env.OPSMAP_PRIVATE_READER_URL,env.OPSMAP_PRIVATE_READER_SECRET);
}
