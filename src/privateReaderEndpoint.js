const protectedActions=new Set(['customerDetail','staffCustomerDetail','customerSearch']);
export function privateReaderEndpoint(action,env=process.env){
  if(!protectedActions.has(action)||env.OPSMAP_PRIVATE_READER_ENABLED!=='true')return {url:env.HUB_API_URL,secret:env.HUB_API_SECRET,isolated:false};
  const raw=String(env.OPSMAP_PRIVATE_READER_URL||''),secret=String(env.OPSMAP_PRIVATE_READER_SECRET||'');let url;
  try{url=new URL(raw);}catch{throw Error('PRIVATE_READER_CONFIGURATION_REQUIRED');}
  if(url.protocol!=='https:'||url.hostname!=='script.google.com'||url.port||url.username||url.password||url.search||url.hash||!/^\/macros\/s\/[A-Za-z0-9_-]{20,}\/exec$/.test(url.pathname)||secret.length<32||secret.length>512)throw Error('PRIVATE_READER_CONFIGURATION_INVALID');
  return {url:url.href,secret,isolated:true};
}
