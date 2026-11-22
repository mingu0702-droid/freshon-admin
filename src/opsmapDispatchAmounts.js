import {createHash, createPrivateKey, sign} from 'node:crypto';
import {readFileSync, statSync} from 'node:fs';
import {readBoundedHubText} from './opsmap-abc/boundedHubResponse.js';
import {driverVehicle} from './privateDriverContact.js';
import {isDay} from './shadowCoverage/coverageFiles.js';
import {STAGE_ORIGIN, STAGE_SERVICE} from './stageScope.js';

const tokenUrl = 'https://oauth2.googleapis.com/token';
const sheetUrl = 'https://sheets.googleapis.com/v4/spreadsheets/';
const scope = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const range = "'금액정보'!A6:D1000";
const serialEpoch = Date.UTC(1899, 11, 30);
const dayMs = 24 * 3600000;
const kstOffsetMs = 9 * 3600000;
const signatureHeader = Buffer.from(JSON.stringify({alg:'RS256', typ:'JWT'})).toString('base64url');
const unavailable = date => ({date, observedAt:null, state:'UNAVAILABLE', vehicles:[]});
// The two existing operational workbooks allow edits through their shared links.
// Keep their document IDs out of the public repository. Deployment approval
// and an independently reviewed, access-controlled workbook are both required.
const editableWorkbookHashes = new Set([
  'e17debf7b2b0d4def740ace8242dbb12ea9c3cc6ec91eb702e8f667004affd5f',
  'd7cc394dcf802c2977a74bd442ebc49a973bca981203d854853135916f52a638'
]);

function readCredentials(env) {
  const file = env.OPSMAP_STAGE_DRIVER_GOOGLE_SERVICE_ACCOUNT_FILE;
  const encoded = env.OPSMAP_STAGE_DRIVER_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
  if (!!file === !!encoded) throw Error('WMS_SHEET_CREDENTIALS');
  if (file && (!/^\/etc\/secrets\/[A-Za-z0-9._-]+\.json$/.test(file) || !statSync(file).isFile() || statSync(file).size > 16384)) {
    throw Error('WMS_SHEET_CREDENTIALS');
  }
  if (encoded && (encoded.length > 22000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))) throw Error('WMS_SHEET_CREDENTIALS');
  const credentials = JSON.parse(file ? readFileSync(file,'utf8') : Buffer.from(encoded,'base64').toString('utf8'));
  if (credentials.type !== 'service_account' || !/^[^\s@]{1,256}@[^@\s]{1,256}\.gserviceaccount\.com$/.test(credentials.client_email || '')) {
    throw Error('WMS_SHEET_CREDENTIALS');
  }
  const key = createPrivateKey(credentials.private_key);
  if (key.asymmetricKeyType !== 'rsa') throw Error('WMS_SHEET_CREDENTIALS');
  return {account:credentials.client_email, key};
}

function projectAmounts(values, now) {
  if (!Array.isArray(values) || values.length < 15 || values.length >= 995 ||
      values.some(row => !Array.isArray(row) || row.length > 4)) return null;
  const date = /^조회 배송일 (\d{4}-\d{2}-\d{2}) · 완료$/.exec(values[1][0])?.[1];
  const [center, total, serial, state] = values[3];
  if (!isDay(date) || center !== '오산' || state !== '조회 성공' || !Number.isSafeInteger(total) ||
      typeof serial !== 'number' || !Number.isFinite(serial) || serial < 1 ||
      !['WMS 원본 호차','매출 금액','경유지수','센터'].every((value,index) => values[13][index] === value)) return null;
  // The existing workbook stores a Sheets serial in its Asia/Seoul timezone.
  const stamp = serialEpoch + Math.round(serial * dayMs) - kstOffsetMs;
  if (!(stamp > 0 && stamp <= now)) return null;
  const vehicles = [];
  const seen = new Set();
  let sum = 0;
  for (const [identifier, amount, , rowCenter] of values.slice(14)) {
    if (rowCenter !== '오산') continue;
    const vehicle = identifier === '미배정' ? identifier : driverVehicle(identifier);
    if (!vehicle || !Number.isSafeInteger(amount) || seen.has(vehicle)) return null;
    seen.add(vehicle);
    sum += amount;
    if (!Number.isSafeInteger(sum)) return null;
    vehicles.push({vehicle, amount, routeCode:null, detailState:'UNAVAILABLE'});
  }
  if (!vehicles.length || sum !== total) return null;
  return {date, observedAt:new Date(stamp).toISOString(), state:'VERIFIED', vehicles};
}

export function createOpsmapDispatchAmountsReader({env=process.env, fetchImpl=fetch, now=Date.now}={}) {
  const id = env.OPSMAP_STAGE_WMS_AMOUNTS_SHEET_ID;
  const enabled = env.RENDER_EXTERNAL_URL === STAGE_ORIGIN && env.RENDER_SERVICE_ID === STAGE_SERVICE &&
    env.OPSMAP_STAGE_WMS_AMOUNTS_APPROVED === '1' && typeof id === 'string' && /^[A-Za-z0-9_-]{15,128}$/.test(id) &&
    !editableWorkbookHashes.has(createHash('sha256').update(id).digest('hex'));
  let credentials, cached, pending, expires = 0;

  async function load() {
    credentials ??= readCredentials(env);
    const signal = AbortSignal.timeout(10000);
    const issued = Math.floor(now()/1000);
    const claims = Buffer.from(JSON.stringify({iss:credentials.account, scope, aud:tokenUrl, iat:issued, exp:issued+3600})).toString('base64url');
    const unsigned = signatureHeader+'.'+claims;
    const assertion = unsigned+'.'+sign('RSA-SHA256', Buffer.from(unsigned), credentials.key).toString('base64url');
    const token = await json(tokenUrl, 16384, {method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion})});
    if (!/^[\x21-\x7e]{1,4096}$/.test(token?.access_token || '')) return null;
    const url = sheetUrl + encodeURIComponent(id) + '/values/' + encodeURIComponent(range) +
      '?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE';
    const sheet = await json(url, 262144, {headers:{Authorization:'Bearer '+token.access_token, Accept:'application/json'}});
    return projectAmounts(sheet?.values, now());

    async function json(url, maxBytes, options) {
      const response = await fetchImpl(url, {...options, signal, redirect:'error', cache:'no-store'});
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw Error('WMS_SHEET_UNAVAILABLE');
      }
      return JSON.parse(await readBoundedHubText(response, maxBytes, signal));
    }
  }

  async function latest() {
    if (!enabled) return null;
    if (now() >= expires) {
      pending ??= load().catch(() => null).then(value => {
        cached = value;
        expires = now()+30000;
      }).finally(() => {pending = null;});
      await pending;
    }
    return cached;
  }
  const read=async date=>{
    if (!isDay(date)) return unavailable(date);
    const result=await latest();
    return result?.date===date?result:unavailable(date);
  };
  read.latest=latest;
  return read;
}
