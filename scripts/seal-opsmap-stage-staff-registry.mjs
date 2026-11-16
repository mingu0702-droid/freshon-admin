import {readFile, stat, writeFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {sealStageStaffRegistry, STAGE_STAFF_REGISTRY_MAX_CLEAR_BYTES, STAGE_STAFF_REGISTRY_PATH} from '../src/stageStaffRegistryAsset.js';

try {
  const [input,keyFile,output] = process.argv.slice(2);
  if (![input,keyFile,output].every(value => isAbsolute(value || '')) || process.argv.length !== 5) {
    throw Error('Usage: node scripts/seal-opsmap-stage-staff-registry.mjs <absolute-input-json> <absolute-stage-key-file> <absolute-output-bin>');
  }
  const info = await stat(input);
  if (!info.isFile() || info.size > STAGE_STAFF_REGISTRY_MAX_CLEAR_BYTES) throw Error('CUSTOMER_REGISTRY_INPUT_LIMIT');
  const [bytes,key] = await Promise.all([readFile(input),readFile(keyFile,'utf8')]);
  const {packed,sha256} = await sealStageStaffRegistry(bytes,key.trim());
  await writeFile(output,packed,{flag:'wx',mode:0o600});
  console.log(JSON.stringify({path:STAGE_STAFF_REGISTRY_PATH,sha256,bytes:packed.length}));
} catch (error) {
  console.error(/^(?:Usage:|CUSTOMER_REGISTRY_)/.test(error.message) ? error.message : 'CUSTOMER_REGISTRY_SEAL_FAILED');
  process.exitCode=1;
}
