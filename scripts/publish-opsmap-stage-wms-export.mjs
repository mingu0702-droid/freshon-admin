import {createHash} from 'node:crypto';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {parseOpsmapWmsDispatchExport,publishStageWmsDispatchExport} from '../src/opsmapWmsDispatchExport.js';
import {verifyStageFreshonWmsWorkbookOnce} from '../src/stageFreshonWmsWorkbookGate.js';

try {
  const [mode,date,observedAt,sha256,input,replaceSha256,...extra]=process.argv.slice(2);
  if(!['--preview','--publish','--replace','--verify-freshon'].includes(mode)||extra.length||!path.isAbsolute(input||'')||
      (mode==='--replace'?!/^[a-f0-9]{64}$/.test(replaceSha256||''):replaceSha256!==undefined)||
      !/^[a-f0-9]{64}$/.test(sha256||''))throw Error('WMS_EXPORT_SCOPE');
  const file=await stat(input);
  if(!file.isFile()||file.size<1||file.size>4*1024*1024)throw Error('WMS_EXPORT_WORKBOOK_INVALID');
  const bytes=await readFile(input);
  if(bytes.length!==file.size||createHash('sha256').update(bytes).digest('hex')!==sha256)throw Error('WMS_EXPORT_DIGEST');
  if(mode==='--verify-freshon'){
    const proof=await verifyStageFreshonWmsWorkbookOnce({bytes,date,observedAt,sha256,login:async()=>{
      const {config}=await import('../src/config.js');
      if(new URL(config.freshonBaseUrl).origin!=='https://mis.freshon.co.kr')throw Error('WMS_EXPORT_FRESHON_SCOPE');
      const {loginFreshonSession}=await import('../src/scraper/freshonDailyRoute.js');
      return loginFreshonSession();
    }});
    console.log(JSON.stringify(proof));
  }else{
    const data=parseOpsmapWmsDispatchExport(bytes,{date,observedAt});
    const result=mode==='--preview'?{state:'VERIFIED_PREVIEW',date,sha256}:
      await publishStageWmsDispatchExport({bytes,date,observedAt,sha256,replaceSha256});
    const groups=data.vehicles.length;
    const stops=data.vehicles.filter(entry=>entry.vehicle!=='미배정').reduce((n,entry)=>n+entry.details.length,0);
    console.log(JSON.stringify({...result,warehouse:'011',groups,stops}));
  }
} catch(error) {
  const code=error.code||error.message;
  console.error(/^(?:WMS_EXPORT|FIXED_STORE)_[A-Z_]+$/.test(code??'')?code:'WMS_EXPORT_RELEASE_FAILED');
  process.exitCode=1;
}
