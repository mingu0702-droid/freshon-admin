// Run each node:test file directly so the report counts assertions, not files.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'reports/repair4');
await fs.mkdir(output,{recursive:true});
const suites=[
  'tests/master-detail/customer-detail-boundary.test.mjs',
  'tests/patch/detail-handler.test.mjs',
  'tests/patch/loading-targets.test.mjs',
  'tests/patch/private-cache.test.mjs',
  'tests/patch/road-routing.test.mjs',
  'tests/patch/view-policy.test.mjs',
  ...(await fs.readdir(path.join(root,'tests/repair4'))).filter(name=>name.endsWith('.test.mjs')).sort().map(name=>'tests/repair4/'+name)
];
const report={type:'LOCAL_UNIT_REGRESSION',startedAt:new Date().toISOString(),node:process.version,suites:[],passed:0,failed:0,skipped:0,realProvider:false,realBrowser:false};
for(const suite of suites){
  const result=spawnSync(process.execPath,['--test-reporter=tap',suite],{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
  const log=(result.stdout||'')+(result.stderr||'')+(result.error?'\n'+String(result.error):'');
  const count=key=>Number(log.match(new RegExp('^# '+key+' (\\d+)','m'))?.[1]||0);
  const passed=count('pass'),failed=count('fail'),skipped=count('skipped');
  const logName=suite.replaceAll('/','__').replace(/\.mjs$/,'.tap');
  await fs.writeFile(path.join(output,logName),log);
  const completed=result.status===0&&!result.error&&passed>0&&failed===0;
  report.suites.push({suite,completed,exitCode:result.status,passed,failed,skipped,log:logName});
  report.passed+=passed;report.failed+=failed+(completed||failed?0:1);report.skipped+=skipped;
  console.log(`${completed?'PASS':'FAIL'} ${suite}: ${passed} passed, ${failed} failed, ${skipped} skipped`);
}
report.completedAt=new Date().toISOString();
await fs.writeFile(path.join(output,'unit-summary.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({passed:report.passed,failed:report.failed,skipped:report.skipped,report:'reports/repair4/unit-summary.json'}));
process.exitCode=report.failed?1:0;
