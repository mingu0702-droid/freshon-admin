export async function loginFreshonOverHttp({origin,userId,password}) {
  if(!userId||!password) throw Error('FRESHON_ID and FRESHON_PASSWORD must be configured as environment variables.');
  const response=await fetch(origin+'/loginProcessing',{
    method:'POST',redirect:'manual',signal:AbortSignal.timeout(20000),
    headers:{Accept:'text/html,application/xhtml+xml',
      'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8',
      Origin:origin,Referer:origin+'/login','User-Agent':'freshon-admin-auth/1.0'},
    body:new URLSearchParams({userId,password}).toString()
  });
  const setCookies=typeof response.headers.getSetCookie==='function' ?
    response.headers.getSetCookie() : [response.headers.get('set-cookie')].filter(Boolean);
  const cookie=setCookies.map(value=>String(value||'').split(';',1)[0].trim()).filter(Boolean).join('; ');
  await response.body?.cancel().catch(()=>{});
  if(![200,302,303].includes(response.status)||!cookie){
    throw Object.assign(Error(`Freshon login was rejected (status ${response.status || 'unknown'}).`),{
      status:response.status||401
    });
  }
  return {cookie,loginStatus:response.status,cookieCount:setCookies.length};
}
