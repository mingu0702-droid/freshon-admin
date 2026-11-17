import {createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes} from 'node:crypto';
import {promisify} from 'node:util';
import {gunzip, gzip} from 'node:zlib';
import {customerRegistryAddressHash} from './customerRegistry.js';
import {customerRegistryPage} from './privateCustomerRegistry.js';
import {STAGE_ORIGIN, STAGE_SERVICE} from './stageScope.js';
import {stageStaffRegistryManifest} from './stageStaffRegistryManifest.js';

const route = '/api/map-phase2b/private/customer-registry';
const repository = 'https://api.github.com/repos/mingu0702-droid/freshon-cache';
export const STAGE_STAFF_REGISTRY_PATH = 'opsmap-stage/staff-registry-v1/registry.bin';
export const STAGE_STAFF_REGISTRY_MAX_BYTES = 2 * 1024 * 1024;
export const STAGE_STAFF_REGISTRY_MAX_CLEAR_BYTES = 8 * 1024 * 1024;
const observedOn = '2026-11-17';
const expected = [
  {code:'012', centerGroup:'yeongnam', registered:7655, included:7601},
  {code:'013', centerGroup:'honam', registered:3443, included:3408}
];
const count = expected.reduce((sum, center) => sum + center.included, 0);
const sourceCount = expected.reduce((sum, center) => sum + center.registered, 0);
const aad = Buffer.from(STAGE_STAFF_REGISTRY_PATH);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const derive = (key, use) => Buffer.from(hkdfSync('sha256', key, aad, Buffer.from(use), 32));
const compress = promisify(gzip), decompress = promisify(gunzip);
const rejected = () => Object.assign(Error('CUSTOMER_REGISTRY_ASSET_REJECTED'), {permanent:true});
const unavailable = retryAt => Object.assign(Error('CUSTOMER_REGISTRY_UNAVAILABLE'), {retryAt});
const control = /[\u0000-\u001f\u007f]/;
const privateText = /(?:\+?82[- ]?)?01[016789][-. ]?\d{3,4}[-. ]?\d{4}|비밀번호|비번|보안키|출입(?:정보|번호|코드|방법)|공동현관|도어락|패스워드|password|passcode|bearer\s|https?:\/\//i;
const text = (value, max) => typeof value === 'string' && value.length <= max &&
  !control.test(value) && !privateText.test(value.normalize('NFKC'));

function hasFields(value, fields) {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value,field));
}

function parseRegistry(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > STAGE_STAFF_REGISTRY_MAX_CLEAR_BYTES) throw rejected();
  let doc;
  try { doc = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); }
  catch { throw rejected(); }
  if (!hasFields(doc,['schema','observedOn','centers','rows']) || doc.schema !== 1 || doc.observedOn !== observedOn ||
      !Array.isArray(doc.centers) || doc.centers.length !== expected.length ||
      !Array.isArray(doc.rows) || doc.rows.length !== count) throw rejected();

  for (const {code,centerGroup,registered} of expected) {
    const source = doc.centers.find(center => center?.code === code);
    if (!hasFields(source,['code','centerGroup','registered','sourceSha256']) ||
        source.centerGroup !== centerGroup || source.registered !== registered || !isHash(source.sourceSha256)) throw rejected();
  }
  const seen = new Set(), counts = new Map(expected.map(center => [center.centerGroup,0]));
  for (const row of doc.rows) {
    if (!hasFields(row,['customerCode','customerName','basicAddress','centerGroup']) ||
        typeof row.customerCode !== 'string' || !/^[A-Z]\d{1,20}$/.test(row.customerCode) || seen.has(row.customerCode) ||
        !counts.has(row.centerGroup) || !text(row.customerName,200) || !row.customerName.trim() ||
        !text(row.basicAddress,500)) throw rejected();
    seen.add(row.customerCode);
    counts.set(row.centerGroup,counts.get(row.centerGroup) + 1);
  }
  if (expected.some(center => counts.get(center.centerGroup) !== center.included)) throw rejected();
  return doc;
}

function postalKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return null;
  const key = Buffer.from(value,'base64');
  return key.length === 32 && key.toString('base64') === value ? key : null;
}

export async function sealStageStaffRegistry(bytes, encodedKey) {
  const key = postalKey(encodedKey);
  if (!key) throw rejected();
  parseRegistry(bytes);
  const compressed = await compress(bytes);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm',derive(key,'asset-encryption'),nonce);
  cipher.setAAD(aad);
  const packed = Buffer.concat([nonce,cipher.update(compressed),cipher.final(),cipher.getAuthTag()]);
  if (packed.length > STAGE_STAFF_REGISTRY_MAX_BYTES) throw rejected();
  return {packed,sha256:digest(packed)};
}

async function openRegistry(packed,key) {
  let bytes;
  try {
    const decipher = createDecipheriv('aes-256-gcm',derive(key,'asset-encryption'),packed.subarray(0,12));
    decipher.setAAD(aad);
    decipher.setAuthTag(packed.subarray(-16));
    bytes = await decompress(Buffer.concat([decipher.update(packed.subarray(12,-16)),decipher.final()]),
      {maxOutputLength:STAGE_STAFF_REGISTRY_MAX_CLEAR_BYTES});
  } catch { throw rejected(); }
  const doc = parseRegistry(bytes);
  const version = digest(bytes);
  const rows = doc.rows.map(row => ({
    ...row, addressHash:customerRegistryAddressHash(row.basicAddress), lifecycle:'ACTIVE'
  })).sort((a,b) => a.customerCode < b.customerCode ? -1 : a.customerCode > b.customerCode ? 1 : 0);
  return {
    snapshot:{contract:'customer-registry-v1',version,sourceVersion:version,sourceVersionKind:'CUSTOMER_METADATA_SHA256',
      deletionPolicy:'EXPLICIT_ONLY',lifecycleField:null,complete:true,sourceRows:sourceCount,sourceUniqueCodes:sourceCount,
      sourceCount:count,exclusions:sourceCount-count,conflicts:0,rows},
    meta:{source:'STAGE_FRESHON_CENTER_REGISTRY',checkedAt:doc.observedOn,centers:expected}
  };
}

function retryAt(response, now) {
  const retry = response.headers.get('retry-after');
  const advertised = /^\d+$/.test(retry || '') ? now + Number(retry) * 1000 : Date.parse(retry || '');
  const reset = response.headers.get('x-ratelimit-remaining') === '0'
    ? Number(response.headers.get('x-ratelimit-reset')) * 1000 : 0;
  return Math.max(now + 60_000, Number.isSafeInteger(advertised) ? advertised : 0, Number.isSafeInteger(reset) ? reset : 0);
}

export function createStageStaffRegistryAsset({
  env = process.env, fetchImpl = fetch, now = Date.now, manifest = stageStaffRegistryManifest
} = {}) {
  if (env.RENDER_EXTERNAL_URL !== STAGE_ORIGIN || env.RENDER_SERVICE_ID !== STAGE_SERVICE ||
      !manifest || !/^[a-f0-9]{40}$/.test(manifest.ref || '') || !isHash(manifest.sha256) ||
      !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 29 || manifest.bytes > STAGE_STAFF_REGISTRY_MAX_BYTES) return null;
  const key = postalKey(env.OPSMAP_SHADOW_POSTAL_ASSET_KEY_B64);
  const token = env.OPSMAP_SNAPSHOT_STORE_TOKEN || env.GITHUB_TOKEN;
  if (!key || !token) return null;
  const cursorKey = derive(key,'cursor-signing');
  let saved, pending, failed, repositoryChecked = false;

  async function download() {
    const signal = AbortSignal.timeout(20_000);
    const request = async (url,accept) => {
      const response = await fetchImpl(url,{method:'GET',redirect:'error',signal,
        headers:{Authorization:'Bearer ' + token,Accept:accept,'Accept-Encoding':'identity'}});
      if (!response.ok) {
        await response.body?.cancel().catch(()=>{});
        throw unavailable(retryAt(response,now()));
      }
      return response;
    };
    if (!repositoryChecked) {
      const info = await request(repository,'application/vnd.github+json');
      if ((await info.json()).private !== true) throw rejected();
      repositoryChecked = true;
    }
    const response = await request(repository + '/contents/' + STAGE_STAFF_REGISTRY_PATH + '?ref=' + manifest.ref,
      'application/vnd.github.raw+json');
    if (!response.body || Number(response.headers.get('content-length')) > manifest.bytes) {
      await response.body?.cancel().catch(()=>{});
      throw rejected();
    }
    const bytes = Buffer.alloc(manifest.bytes);
    let used = 0;
    for await (const chunk of response.body) {
      if (used + chunk.length > bytes.length) throw rejected();
      bytes.set(chunk,used);
      used += chunk.length;
    }
    if (used !== bytes.length || digest(bytes) !== manifest.sha256) throw rejected();
    return openRegistry(bytes,key);
  }

  function read() {
    if (saved) return Promise.resolve(saved);
    if (failed && (failed.permanent || now() < failed.retryAt)) return Promise.reject(failed);
    pending ??= download().then(value => { saved=value; return value; }).catch(error => {
      failed = error?.permanent || error?.retryAt ? error : unavailable(now() + 60_000);
      throw failed;
    }).finally(() => { pending=null; });
    return pending;
  }
  return {read,cursorKey};
}

export function mountStageStaffRegistry({app,requireStaff,asset,getVerifiedRegistry,now = Date.now}) {
  const compatible = new WeakMap();
  function verifiedRegistry() {
    const registry = getVerifiedRegistry();
    if (!(registry instanceof Map) || registry.size < 6043) throw unavailable(now() + 5_000);
    return registry;
  }
  app.get(route,requireStaff,async (req,res) => {
    const send = (status,value,retryAt) => requireStaff(req,res,() => {
      res.set('Cache-Control','private, no-store').vary('Cookie');
      if (retryAt > now()) res.set('Retry-After',String(Math.ceil((retryAt-now())/1000)));
      return res.status(status).json(value);
    });
    const {cursor,since,limit} = req.query;
    if (Object.keys(req.query).some(key => !['cursor','since','limit'].includes(key)) ||
        cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursor.length > 256) ||
        since !== undefined && !isHash(since) || cursor && since ||
        limit !== undefined && (typeof limit !== 'string' || !/^(?:[1-9]\d{0,2}|1000)$/.test(limit))) {
      return send(400,{ok:false,error:'CUSTOMER_REGISTRY_QUERY_INVALID'});
    }
    if (!asset) return send(503,{ok:false,error:'CUSTOMER_REGISTRY_NOT_CONFIGURED'});
    try {
      verifiedRegistry();
      const {snapshot,meta} = await asset.read();
      const current = verifiedRegistry();
      if (!compatible.has(current)) {
        const disjoint = snapshot.rows.every(row => !current.has(row.customerCode));
        compatible.set(current,disjoint);
        if (disjoint) console.info(JSON.stringify({component:'stage-coordinate-audit',date:meta.checkedAt,
          registrationOnly:Object.fromEntries(meta.centers.map(center => [center.centerGroup,center.included]))}));
      }
      if (!compatible.get(current)) return send(503,{ok:false,error:'CUSTOMER_REGISTRY_SCOPE_CHANGED'});
      const data = customerRegistryPage(snapshot,{cursor:cursor ?? null,since,limit:limit ? Number(limit) : 250,
        maxLimit:1000,secret:asset.cursorKey});
      return send(200,{ok:true,data,meta});
    } catch (error) {
      const code = error.code || error.message;
      if (code === 'CUSTOMER_REGISTRY_CURSOR_INVALID') return send(400,{ok:false,error:code});
      if (code === 'CUSTOMER_REGISTRY_VERSION_CHANGED') return send(409,{ok:false,error:code});
      return send(503,{ok:false,error:error.permanent?'CUSTOMER_REGISTRY_ASSET_REJECTED':'CUSTOMER_REGISTRY_UNAVAILABLE'},error.retryAt);
    }
  });
}
