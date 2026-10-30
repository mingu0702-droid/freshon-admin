// Opt-in: existing Hub callers retain their current response handling.
export async function readBoundedHubText(response,maxBytes,signal){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>2*1048576)throw Error('HUB_RESPONSE_LIMIT_INVALID');
 const reject=()=>Object.assign(Error('HUB_RESPONSE_TOO_LARGE'),{failureType:'contract'});
 const length=response.headers?.get('content-length');
 if(length&&/^\d+$/.test(length)&&Number(length)>maxBytes){await response.body?.cancel().catch(()=>{});throw reject();}
 if(!response.body?.getReader)throw Object.assign(Error('HUB_BOUNDED_STREAM_REQUIRED'),{failureType:'contract'});
 const reader=response.body.getReader(),chunks=[];let bytes=0;
 const cancel=()=>{void reader.cancel().catch(()=>{});};signal?.addEventListener('abort',cancel,{once:true});
 try{
  for(;;){signal?.throwIfAborted();const {done,value}=await reader.read();signal?.throwIfAborted();if(done)break;
   if(!(value instanceof Uint8Array))throw Object.assign(Error('HUB_BOUNDED_STREAM_INVALID'),{failureType:'contract'});
   bytes+=value.byteLength;if(bytes>maxBytes){await reader.cancel().catch(()=>{});throw reject();}chunks.push(value);
  }
  return Buffer.concat(chunks,bytes).toString('utf8');
 }catch(error){await reader.cancel().catch(()=>{});throw error;
 }finally{signal?.removeEventListener('abort',cancel);reader.releaseLock();}
}
