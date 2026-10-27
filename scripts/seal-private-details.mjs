// Run only in the authorized data environment. Arguments contain paths, not secrets.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {sealPrivateSnapshot} from '../src/privateDetailCache.js';
const [input,output]=process.argv.slice(2);
if(!input||!output||!path.isAbsolute(input)||!path.isAbsolute(output))throw Error('Usage: node scripts/seal-private-details.mjs ABS_INPUT_JSON ABS_OUTPUT_ENCRYPTED_JSON');
const raw=await fs.readFile(input);if(raw.length>16*1024*1024)throw Error('INPUT_TOO_LARGE');
const value=JSON.parse(raw);if(value.schema!=='opsmap-protected-detail-v1'||!Array.isArray(value.rows))throw Error('INVALID_INPUT');
const encrypted=sealPrivateSnapshot(value,process.env.OPSMAP_PRIVATE_DETAIL_ENCRYPTION_KEY);
const bytes=Buffer.from(JSON.stringify(encrypted));await fs.writeFile(output,bytes,{flag:'wx',mode:0o600});
console.log(JSON.stringify({output,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),rows:value.rows.length}));
