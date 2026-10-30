// Explicit operator configuration; a shared login alone never grants writes.
export function createManualPinAuthorizer({env=process.env,now=Date.now}={}){
 return async (_req,session)=>{
  if(env.OPSMAP_MANUAL_PIN_WRITES!=='1'||env.OPSMAP_MANUAL_PIN_WRITE_AUTHORIZATION!=='EXPLICIT_SHARED_STAFF_APPROVAL')return false;
  if(!/^[-A-Za-z0-9_]{8,100}$/.test(env.OPSMAP_MANUAL_PIN_WRITE_APPROVAL_ID||'')||!env.MAP_STAFF_ID||env.OPSMAP_MANUAL_PIN_WRITER_ID!==env.MAP_STAFF_ID)return false;
  return Boolean(session&&typeof session.key==='string'&&session.key&&Number.isFinite(session.expiresAt)&&Number.isFinite(session.idleExpiresAt)&&now()<session.expiresAt&&now()<session.idleExpiresAt);
 };
}
