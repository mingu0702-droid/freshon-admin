import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {emptyLedger,hash,address,store} from './fixtures.mjs';
import {officialAddressKey} from '../../src/opsmapOfficialAddressLookup.js';
import {validateFixedCoordinateLedger} from '../../src/fixedStoreCoordinates.js';
const cli=fileURLToPath(new URL('../../scripts/prepare-fixed-coordinate-completion.mjs',import.meta.url));
async function make(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'opsmap-audit-cli-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const ledger=emptyLedger();
 const idx={schema:'opsmap-official-address-index-v1',source:'https://www.data.go.kr/data/15083033/fileData.do',date:'2026-11-01',datasetSha256:'a'.repeat(64),rows:[{addressSha256:hash(officialAddressKey(address(10))),buildingSha256:'b'.repeat(64),lat:37.15,lng:127.05}]};
 const files={'stores.json':JSON.stringify({stores:[store()]}),'ledger.json':JSON.stringify(ledger),'index.json':JSON.stringify(idx)};
 for(const [name,bytes]of Object.entries(files))await fs.writeFile(path.join(root,name),bytes,{mode:0o600});
 const config={catalogFile:path.join(root,'stores.json'),ledgerFile:path.join(root,'ledger.json'),ledgerSha256:ledger.sha256,officialIndexFile:path.join(root,'index.json'),officialIndexSha256:hash(JSON.stringify(idx)),outputDirectory:root};
 return {root,files,config};
}
test('offline CLI creates a separate candidate, matches hashes, never overwrites inputs or prints addresses',async t=>{
 const f=await make(t),settings=path.join(f.root,'settings.json');await fs.writeFile(settings,JSON.stringify(f.config));
 const run=spawnSync(process.execPath,[cli,settings],{encoding:'utf8'});
 assert.equal(run.status,0,run.stderr);assert(!run.stdout.includes(address(10)));
 const result=JSON.parse(run.stdout);assert.equal(result.summary.added,1);assert.equal(result.summary.pending,0);
 const manifest=JSON.parse(await fs.readFile(path.join(result.outputDirectory,'manifest.safe.json')));
 assert.equal(manifest.operationalWrites,0);assert.equal(manifest.providerCalls,0);
 for(const [name,text]of Object.entries(f.files))assert.equal(await fs.readFile(path.join(f.root,name),'utf8'),text);
 for(const [name,meta]of Object.entries(manifest.files)){const bytes=await fs.readFile(path.join(result.outputDirectory,name),'utf8');assert.equal(hash(bytes),meta.sha256);assert.equal(Buffer.byteLength(bytes),meta.bytes);}
 validateFixedCoordinateLedger(JSON.parse(await fs.readFile(path.join(result.outputDirectory,'fixed-store-coordinates-v1.json'))));
});
test('offline CLI refuses an index with the wrong expected digest before producing a candidate',async t=>{
 const f=await make(t),settings=path.join(f.root,'settings.json');await fs.writeFile(settings,JSON.stringify({...f.config,officialIndexSha256:'c'.repeat(64)}));
 const run=spawnSync(process.execPath,[cli,settings],{encoding:'utf8'});
 assert.equal(run.status,1);assert.match(run.stderr,/OFFICIAL_ADDRESS_INDEX_DIGEST/);
 assert.equal((await fs.readdir(f.root)).filter(n=>n.startsWith('coordinate-candidate-')).length,0);
});
