import crypto from 'node:crypto';
import {createPrivateGithubJsonStore} from './fixedVehicleStore.js';
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=code=>{throw Object.assign(Error(code),{code});};
// Separate files in the already approved private snapshot namespace. No GPS/provider points.
export function createCustomerRegistryStorage({env=process.env,token,fetchImpl=fetch}={}){
 const repo=env.OPSMAP_SNAPSHOT_STORE_REPO,branch=env.OPSMAP_SNAPSHOT_STORE_BRANCH;
 const scopes={'srv-d87gc5rtqb8s7398t37g':'production','srv-da47hugu01pc73etpfa0':'stage'},scope=scopes[env.RENDER_SERVICE_ID];
 if(repo!=='mingu0702-droid/freshon-cache'||!scope||branch!==scope+'/opsmap-snapshots'||!token)fail('CUSTOMER_REGISTRY_STORAGE_CONFIG');
 const store=createPrivateGithubJsonStore({env:{GITHUB_CACHE_REPO:repo,GITHUB_CACHE_BRANCH:branch,GITHUB_CACHE_DIR:'opsmap-'+scope,GITHUB_TOKEN:token},fetchImpl});
 const file='customer-registry-v1.json';let rules=null,rulesAt=0,expectedSha=null,known=null,loaded=false;
 return{
  async readState(){const result=await store.read(file),value=result.value;if(value&&(value.schema!==1||value.sha256!==hash(value.current)))fail('CUSTOMER_REGISTRY_STORAGE_INTEGRITY');expectedSha=result.sha;known=value;loaded=true;return value?.current||null;},
  async writeState(current){
   const text=JSON.stringify(current);if(text.length>12000000||/"(?:password|securityKey|generalKey|accessMemo|latitude|longitude|lat|lng|cookie|token)"\s*:/.test(text))fail('CUSTOMER_REGISTRY_STORAGE_FIELDS');
   if(!loaded)fail('CUSTOMER_REGISTRY_STORAGE_NOT_LOADED');if(known?.sha256===hash(current))return;
   const next={schema:1,current,previous:known?.current||null,sha256:hash(current)};try{await store.write(file,next,expectedSha);}catch(error){fail(error.code==='FIXED_STORE_CONFLICT'?'CUSTOMER_REGISTRY_STORAGE_CONFLICT':'CUSTOMER_REGISTRY_STORAGE_WRITE');}
   const saved=await store.read(file);if(saved.value?.sha256!==next.sha256||hash(saved.value.current)!==next.sha256)fail('CUSTOMER_REGISTRY_STORAGE_READBACK');known=saved.value;expectedSha=saved.sha;
  },
  async readRules(){if(rules&&Date.now()-rulesAt<300000)return rules;const {value}=await store.read('customer-address-search-rules-v1.json');if(!value)return{};if(value.schema!==1||!value.rules||value.sha256!==hash(value.rules))fail('CUSTOMER_REGISTRY_RULES_INTEGRITY');rules=value.rules;rulesAt=Date.now();return rules;}
 };
}
