// Isolated child process: never contact any upstream service during boot.
import {createRequire,registerHooks} from 'node:module';import {pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url);
const deps=Object.fromEntries(['express','compression','argon2','dotenv','multer','xlsx','xlsx-populate','playwright'].map(name=>[name,pathToFileURL(require.resolve(name)).href]));
registerHooks({resolve(name,context,next){return deps[name]?{url:deps[name],shortCircuit:true}:next(name,context);}});
globalThis.fetch=async()=>{throw Error('UPSTREAM_DISABLED_IN_ISOLATED_TEST');};
await import('../src/server.js');
