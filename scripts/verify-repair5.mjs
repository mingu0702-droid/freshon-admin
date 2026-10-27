// Offline repeatable checks. Counts node:test cases, not files or replay iterations.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'reports/repair5');
const rounds=Number(process.argv.find(a=>a.startsWith('--rounds='))?.split('=')[1]||3);
if(!Number.isInteger(rounds)||rounds<1||rounds>5)throw Error('--rounds must be 1..5');
await fs.mkdir(output,{recursive:true});
const suites=[
 'tests/master-detail/customer-detail-boundary.test.mjs',
 'tests/patch/detail-handler.test.mjs',
 'tests/patch/loading-targets.test.mjs',
 'tests/patch/private-cache.test.mjs',
 'tests/patch/road-routing.test.mjs',
 'tests/patch/view-policy.test.mjs',
 ...(await fs.readdir(path.join(root,'tests/repair4'))).filter(n=>n.endsWith('.test.mjs')).sort().map(n=>'tests/repair4/'+n),
 ...(await fs.readdir(path.join(root,'tests/repair5'))).filter(n=>n.endsWith('.test.mjs')).sort().map(n=>'tests/repair5/'+n)
];
const report={type:'LOCAL_OFFLINE_UNIT_INTEGRATION_REGRESSION',startedAt:new Date().toISOString(),node:process.version,rounds:[],realCustomerData:false,realKakaoProvider:false,remoteMutationCount:0};
for(let round=1;round<=rounds;round++){
 const run={round,startedAt:new Date().toISOString(),passed:0,failed:0,skipped:0,suites:[]};
 const dir=path.join(output,'round-'+round);await fs.mkdir(dir,{recursive:true});
 for(const suite of suites){
  const r=spawnSync(process.execPath,['--test-reporter=tap',suite],{cwd:root,encoding:'utf8',timeout:90000,maxBuffer:8*1024*1024});
  const text=(r.stdout||'')+(r.stderr||'')+(r.error?'\n'+String(r.error):'');
  const count=key=>Number(text.match(new RegExp('^# '+key+' (\\d+)','m'))?.[1]||0);
  const passed=count('pass'),failed=count('fail'),skipped=count('skipped');
  const ok=r.status===0&&!r.error&&passed>0&&failed===0&&skipped===0;
  const log=suite.replaceAll('/','__').replace(/\.mjs$/,'.tap');
  await fs.writeFile(path.join(dir,log),text);
  run.suites.push({suite,completed:ok,exitCode:r.status,passed,failed,skipped,log:'round-'+round+'/'+log});
  run.passed+=passed;run.failed+=failed+(ok||failed?0:1);run.skipped+=skipped;
  console.log(`ROUND ${round} ${ok?'PASS':'FAIL'} ${suite}: ${passed}/${failed}/${skipped}`);
 }
 run.completedAt=new Date().toISOString();report.rounds.push(run);
 console.log(`ROUND ${round}: ${run.passed} passed, ${run.failed} failed, ${run.skipped} skipped`);
 await fs.writeFile(path.join(output,'repeat-summary.json'),JSON.stringify(report,null,2)+'\n');
}
report.completedAt=new Date().toISOString();
report.completed=report.rounds.every(r=>!r.failed&&!r.skipped);
report.distinctNodeTestCases=report.rounds[0].passed;
await fs.writeFile(path.join(output,'repeat-summary.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({completed:report.completed,rounds:report.rounds.map(r=>({round:r.round,passed:r.passed,failed:r.failed,skipped:r.skipped})),distinctNodeTestCases:report.distinctNodeTestCases}));
process.exitCode=report.completed?0:1;
