// Offline candidate preparation only. Does not call an API or overwrite any input.
// Usage: node scripts/prepare-fixed-coordinate-completion.mjs /absolute/private/settings.json
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {boundedRead,privateCoverageDirectory} from '../src/shadowCoverage/coverageFiles.js';
import {readFixedCoordinateLedger} from '../src/fixedStoreCoordinates.js';
import {createOfficialAddressLookup} from '../src/opsmapOfficialAddressLookup.js';
import {completeFixedCoordinates} from '../src/fixedCoordinateCompletion.js';
const appRoot=fileURLToPath(new URL('../',import.meta.url));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function privateFile(file,max){
  if(!path.isAbsolute(file||''))throw Error('FIXED_PREPARE_ABSOLUTE_PATH_REQUIRED');
  const folder=await privateCoverageDirectory(path.dirname(file),appRoot);
  const actual=await fs.realpath(path.join(folder,path.basename(file)));
  if(path.dirname(actual)!==folder)throw Error('FIXED_PREPARE_SYMLINK_REJECTED');
  return boundedRead(actual,max);
}
async function main(){
  const [settingsFile,...extra]=process.argv.slice(2);
  if(extra.length)throw Error('FIXED_PREPARE_USAGE');
  const config=JSON.parse(await privateFile(settingsFile,32768));
  const [catalogBytes,ledgerBytes,indexBytes]=await Promise.all([
    privateFile(config.catalogFile,3*1024*1024),privateFile(config.ledgerFile,8*1024*1024),privateFile(config.officialIndexFile,512*1024)]);
  const ledger=readFixedCoordinateLedger(ledgerBytes,config.ledgerSha256);
  const index=createOfficialAddressLookup(indexBytes,{sha256:config.officialIndexSha256});
  const catalog=JSON.parse(catalogBytes);
  const candidate=completeFixedCoordinates({stores:catalog.stores,ledger,index,maxChanges:config.maxChanges??1000});
  const parent=await privateCoverageDirectory(config.outputDirectory,appRoot);
  const output=await fs.mkdtemp(path.join(parent,'coordinate-candidate-'));
  const files={
    'fixed-store-coordinates-v1.json':JSON.stringify(candidate.ledger),
    'stores.private.json':JSON.stringify({...catalog,stores:candidate.stores}),
    'coordinate-decisions.private.json':JSON.stringify(candidate.decisions)
  };
  const manifest={kind:'CANDIDATE_ONLY',sourceWrites:0,providerCalls:0,operationalWrites:0,
    inputs:{catalogSha256:digest(catalogBytes),ledgerSha256:ledger.sha256,officialIndexSha256:digest(indexBytes)},
    outputLedgerSha256:candidate.ledger.sha256,summary:candidate.summary,
    files:Object.fromEntries(Object.entries(files).map(([name,text])=>[name,{sha256:digest(text),bytes:Buffer.byteLength(text)}]))};
  for(const [name,text] of Object.entries({...files,'manifest.safe.json':JSON.stringify(manifest,null,2)}))
    await fs.writeFile(path.join(output,name),text,{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({kind:manifest.kind,summary:manifest.summary,outputDirectory:output}));
}
try{await main();}catch(error){
  const code=/^[A-Z][A-Z_0-9]{1,95}$/.test(error.code||error.message||'')?error.code||error.message:'FIXED_PREPARE_FAILED';
  console.error(code);process.exitCode=1;
}
