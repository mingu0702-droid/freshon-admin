import test from 'node:test';import assert from 'node:assert/strict';import net from 'node:net';import {spawn} from 'node:child_process';import path from 'node:path';
test('actual Stage server starts with the new adapter but shared staff cannot write',async()=>{
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const env={SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,LOCALAPPDATA:process.env.LOCALAPPDATA,TEMP:process.env.TEMP,TMP:process.env.TMP,HOST:'127.0.0.1',PORT:String(port),OPSMAP_STAGE_VERIFY_ONLY:'1',RENDER_EXTERNAL_URL:'https://freshon-admin-stage-preview-template.onrender.com',OPSMAP_MANUAL_PIN_STORE_KIND:'github',OPSMAP_MANUAL_PIN_WRITES:'1',GITHUB_CACHE_REPO:'fixture/private',GITHUB_TOKEN:'synthetic',OPSMAP_MANUAL_PIN_GITHUB_BRANCH:'stage/opsmap-manual-pins'};
 const cwd=path.join(process.env.LOCALAPPDATA,'OpsmapPrivate','manual-pin-isolated-20261027');
 const child=spawn(process.execPath,[new URL('./manual-pin-stage-bootstrap.mjs',import.meta.url).pathname.replace(/^\/(C:)/,'$1')],{cwd,env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
 try{
  await new Promise((resolve,reject)=>{const deadline=setTimeout(()=>reject(Error('ISOLATED_BOOT_TIMEOUT')),12000);const check=()=>{if(stdout.includes('listening on')){clearTimeout(deadline);resolve();}else if(child.exitCode!==null){clearTimeout(deadline);reject(Error('ISOLATED_BOOT_FAILED '+stderr.slice(0,300)));}else setTimeout(check,100);};check();});
  const url='http://127.0.0.1:'+port+'/api/map-phase2b/private/manual-pins/S970003/save',r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(r.status,401);
 }finally{child.kill();}
});
