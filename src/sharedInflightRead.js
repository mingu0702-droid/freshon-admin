// In-flight sharing only: no result, photo, or credential cache.
export function createSharedInflightRead({maxEntries=64,timeoutMs=15000,
  error=code=>Object.assign(new Error(code),{code})}={}) {
  if(!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>1024||
     !Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>120000)throw Error('SHARED_READ_CONFIG');
  const entries=new Map();
  function read(key,work,{signal}={}) {
    if(signal?.aborted)return Promise.reject(error('READ_ABORTED'));
    let entry=entries.get(key);
    if(!entry){
      if(entries.size>=maxEntries)return Promise.reject(error('READ_BUSY'));
      const controller=new AbortController();entry={controller,waiters:0,settled:false};entries.set(key,entry);
      let abort;
      const stopped=new Promise((_,reject)=>{
        abort=()=>reject(controller.signal.reason||error('READ_ABORTED'));
        controller.signal.addEventListener('abort',abort,{once:true});
      });
      const timer=setTimeout(()=>controller.abort(error('READ_TIMEOUT')),timeoutMs);
      const operation=Promise.resolve().then(()=>{
        if(controller.signal.aborted)throw controller.signal.reason;
        return work(controller.signal);
      });
      entry.promise=Promise.race([operation,stopped]).finally(()=>{
        entry.settled=true;clearTimeout(timer);controller.signal.removeEventListener('abort',abort);
        if(entries.get(key)===entry)entries.delete(key);
      });
      void entry.promise.catch(()=>{});
    }
    entry.waiters++;
    return new Promise((resolve,reject)=>{
      let done=false;
      const finish=(failure,value)=>{
        if(done)return;done=true;signal?.removeEventListener('abort',cancel);entry.waiters--;
        if(!entry.waiters&&!entry.settled){
          if(entries.get(key)===entry)entries.delete(key);
          entry.controller.abort(error('READ_ABORTED'));
        }
        failure?reject(failure):resolve(value);
      };
      const cancel=()=>finish(error('READ_ABORTED'));
      signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
      entry.promise.then(value=>finish(null,value),failure=>finish(failure));
    });
  }
  return {read,size:()=>entries.size};
}
