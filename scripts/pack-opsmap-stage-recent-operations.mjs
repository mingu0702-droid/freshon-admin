import {createHash} from 'node:crypto';
import {realpath,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {boundedRead,privateCoverageDirectory} from '../src/shadowCoverage/coverageFiles.js';
import {openRecentOperations,projectRecentOperations,recentOperationsKey,sealRecentOperations} from '../src/stageRecentOperations.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const [input,keyFile,output,...extra]=process.argv.slice(2);
try {
  if (extra.length || ![input,keyFile,output].every(value=>path.isAbsolute(value||''))) throw Error();
  const [source,keyPath]=await Promise.all([realpath(input),realpath(keyFile)]);
  await Promise.all([privateCoverageDirectory(path.dirname(source),root),privateCoverageDirectory(path.dirname(keyPath),root)]);
  const outputDir=await privateCoverageDirectory(path.dirname(output),root);
  const key=recentOperationsKey((await boundedRead(keyPath,128)).toString('utf8').trim());
  const evidence=JSON.parse(await boundedRead(source,32*1024*1024));
  const packed=await sealRecentOperations(evidence,key);
  const verified=await openRecentOperations(packed,key);
  const bytes=Buffer.from(JSON.stringify(packed));
  const target=path.join(outputDir,path.basename(output));
  await writeFile(target,bytes,{flag:'wx',mode:0o600});
  const sha256=createHash('sha256').update(bytes).digest('hex');
  const {startDate,endDate,centers}=projectRecentOperations(verified);
  console.log(JSON.stringify({sha256,bytes:bytes.length,startDate,endDate,centers:Object.fromEntries(
    Object.entries(centers).map(([center,{activeCount,observedDates,confirmedDays}])=>[center,{
      activeCount,observedDays:observedDates.length,confirmedDays:confirmedDays.length
    }]))}));
} catch {
  console.error('RECENT_OPERATIONS_PACKAGE_FAILED');
  process.exitCode=1;
}
