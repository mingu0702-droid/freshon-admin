import {createPrivateKey, sign} from 'node:crypto';
import {readFileSync, statSync} from 'node:fs';
import {parseDriverSheetValues} from './driverSheetRows.js';
import {createDriverAssignmentReader, driverPhone, driverVehicle, mountPrivateDriverContact} from './privateDriverContact.js';
import {readBoundedHubText} from './opsmap-abc/boundedHubResponse.js';
import {STAGE_ORIGIN, STAGE_SERVICE} from './stageScope.js';

const tokenUrl = 'https://oauth2.googleapis.com/token';
const sheetUrl = 'https://sheets.googleapis.com/v4/spreadsheets/';
const scope = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const centers = {osan:'osan', osanColdStorage:'osan', yeongnam:'yeongnam', honam:'honam'};
const masterRoute = '/api/vehicle-driver-master';
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const contactQueryFields = new Set(['customerCode','vehicle','date','context','center','deliveryId']);
const fail = (code, status = 503) => Object.assign(Error(code), {code, status});
const clean = value => typeof value === 'string' ? value.normalize('NFKC').trim() : '';
const validDay = day => typeof day === 'string' && datePattern.test(day) && Number.isFinite(Date.parse(day)) &&
  new Date(day).toISOString().slice(0,10) === day;
const kstDay = now => new Date(now + 9 * 3600000).toISOString().slice(0,10);
const badDatedIdentity = () => fail('DRIVER_ASSIGNMENT_UNCONFIRMED', 409);

function sheetDay(value) {
  if (!value) return null;
  const match = /^(\d{4})[-./년]\s*(\d{1,2})[-./월]\s*(\d{1,2})(?:일|\.)?$/.exec(value);
  const day = match ? [match[1],match[2].padStart(2,'0'),match[3].padStart(2,'0')].join('-') : '';
  if (!validDay(day)) throw fail('DRIVER_SHEET_DATE_UNRECOGNIZED');
  return day;
}

function projectSheet(values) {
  if (!Array.isArray(values) || values.length > 1001 || values.some(row => !Array.isArray(row) ||
      row.length > 19 || row.some(cell => String(cell ?? '').length > 512))) throw fail('DRIVER_SHEET_RANGE_INVALID');
  // A full last row does not prove the selected range covers all active rows.
  if (values.length === 1001) throw fail('DRIVER_SHEET_RANGE_INCOMPLETE');
  return parseDriverSheetValues(values).rows.map(row => ({
    vehicle: driverVehicle(row['호차']),
    driverName: clean(row['기사명']),
    phone: driverPhone(row['연락처']),
    effectiveDate: sheetDay(row['적용일'])
  })).filter(row => row.vehicle).map(row => {
    if (row.driverName.length > 100 || /[\x00-\x1f\x7f]/.test(row.driverName)) throw fail('DRIVER_SHEET_NAME_INVALID');
    if (/^(?:미확인|미등록|없음|unknown|null|undefined|[-—])$/i.test(row.driverName)) row.driverName = '';
    return row;
  });
}

function effectiveVehicles(rows, date) {
  const byVehicle = new Map();
  for (const row of rows) {
    if (row.effectiveDate && row.effectiveDate > date) continue;
    const prev = byVehicle.get(row.vehicle);
    const effective = row.effectiveDate || '', previous = prev?.effectiveDate || '';
    if (!prev || effective > previous) byVehicle.set(row.vehicle, row);
    else if (effective === previous && (prev.driverName !== row.driverName ||
        (prev.phone || '').replace(/\D/g,'') !== (row.phone || '').replace(/\D/g,''))) {
      byVehicle.set(row.vehicle, {...prev, conflict:true});
    }
  }
  return [...byVehicle.values()];
}

function sourceConfig(env) {
  const id = env.OPSMAP_STAGE_DRIVER_SHEET_ID;
  const gid = env.OPSMAP_STAGE_DRIVER_SHEET_GID;
  const center = env.OPSMAP_STAGE_DRIVER_SHEET_CENTER;
  if (!/^[A-Za-z0-9_-]{15,128}$/.test(id || '') || !/^(?:0|[1-9]\d{0,9})$/.test(gid || '') ||
      !Object.hasOwn(centers,center) || centers[center] !== center) throw fail('DRIVER_SHEET_CONFIG_INVALID');
  const file = env.OPSMAP_STAGE_DRIVER_GOOGLE_SERVICE_ACCOUNT_FILE;
  const encoded = env.OPSMAP_STAGE_DRIVER_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
  if (file && encoded) throw fail('DRIVER_CREDENTIALS_INVALID');
  if (!file && !encoded) throw fail('DRIVER_CREDENTIALS_MISSING');
  try {
    if (file && (!/^\/etc\/secrets\/[A-Za-z0-9._-]+\.json$/.test(file) || statSync(file).size > 16384)) throw Error();
    if (encoded && (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 22000)) throw Error();
    const credentials = JSON.parse(file ? readFileSync(file,'utf8') : Buffer.from(encoded,'base64').toString('utf8'));
    if (credentials.type !== 'service_account' || !/^[^\s@]{1,256}@[^@\s]{1,256}\.gserviceaccount\.com$/.test(credentials.client_email || '')) throw Error();
    const privateKey = createPrivateKey(credentials.private_key);
    if (privateKey.asymmetricKeyType !== 'rsa') throw Error();
    return {id, gid:Number(gid), center, account:credentials.client_email, privateKey};
  } catch {
    throw fail('DRIVER_CREDENTIALS_INVALID');
  }
}

function createSheetReader(config, fetchImpl, now) {
  const spreadsheet = sheetUrl + encodeURIComponent(config.id);
  let cached, pending, lastError, retryAt = 0;

  async function json(url, step, limit, signal, options) {
    let response;
    try { response = await fetchImpl(url,{...options,signal,redirect:'error',cache:'no-store'}); }
    catch { throw fail('DRIVER_'+step+(signal.aborted ? '_TIMEOUT' : '_UNAVAILABLE')); }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw fail('DRIVER_'+step+'_HTTP_'+response.status);
    }
    try { return JSON.parse(await readBoundedHubText(response,limit,signal)); }
    catch { throw fail('DRIVER_'+step+(signal.aborted ? '_TIMEOUT' : '_INVALID_RESPONSE')); }
  }

  async function load() {
    const signal = AbortSignal.timeout(10000);
    const issued = Math.floor(now() / 1000);
    const header = Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url');
    const claims = Buffer.from(JSON.stringify({iss:config.account,scope,aud:tokenUrl,iat:issued,exp:issued+3600})).toString('base64url');
    const unsigned = header+'.'+claims;
    const assertion = unsigned+'.'+sign('RSA-SHA256',Buffer.from(unsigned),config.privateKey).toString('base64url');
    const token = await json(tokenUrl,'TOKEN',16384,signal,{method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion})});
    if (!/^[\x21-\x7e]{1,4096}$/.test(token?.access_token || '')) throw fail('DRIVER_TOKEN_INVALID_RESPONSE');
    const headers = {Authorization:'Bearer '+token.access_token,Accept:'application/json'};
    const metadata = await json(spreadsheet+'?fields=sheets.properties(title,sheetId)','SHEET_METADATA',65536,signal,{headers});
    const tabs = Array.isArray(metadata?.sheets) ? metadata.sheets.filter(tab => tab?.properties?.sheetId === config.gid) : [];
    const title = tabs.length === 1 && tabs[0]?.properties?.title;
    if (typeof title !== 'string' || !title || title.length > 100 || /[\r\n]/.test(title)) throw fail('DRIVER_SHEET_TAB_NOT_FOUND');
    const range = "'"+title.replace(/'/g,"''")+"'!A1:S1001";
    const sheet = await json(spreadsheet+'/values/'+encodeURIComponent(range)+'?majorDimension=ROWS',
      'SHEET_VALUES',524288,signal,{headers});
    return {generatedAt:new Date(now()).toISOString(),rows:projectSheet(sheet.values)};
  }

  return async date => {
    const current = now();
    if (!cached || current - Date.parse(cached.generatedAt) >= 60000) {
      if (retryAt > current) throw lastError;
      pending ??= load().then(value => {
        cached = value;
      }).catch(error => {
        cached = null;
        lastError = error;
        retryAt = now()+30000;
        throw error;
      }).finally(() => { pending = null; });
      await pending;
    }
    return {generatedAt:cached.generatedAt,vehicles:effectiveVehicles(cached.rows,date)};
  };
}

function datedIdentity(input) {
  if (typeof input.center !== 'string' || !Object.hasOwn(centers,input.center) ||
      typeof input.deliveryId !== 'string' || !/^[a-f0-9]{64}$/.test(input.deliveryId)) throw badDatedIdentity();
  return {center:input.center, deliveryId:input.deliveryId};
}

export function createStageDriverContacts({env=process.env, fetchImpl=fetch, now=Date.now} = {}) {
  const enabled = env.RENDER_EXTERNAL_URL === STAGE_ORIGIN && env.RENDER_SERVICE_ID === STAGE_SERVICE &&
    env.OPSMAP_DRIVER_CONTACT_ENABLED === '1' && env.OPSMAP_STAGE_DRIVER_CONTACT_APPROVED === '1';
  let config, configError;
  if (enabled) {
    try { config = sourceConfig(env); }
    catch (error) { configError = error.code || 'DRIVER_SOURCE_NOT_CONFIGURED'; }
  }
  const readSheet = config && createSheetReader(config,fetchImpl,now);

  function mount(binding, {readBaseVehicles, readDatedAssignment} = {}) {
    const readBaseAssignment = createDriverAssignmentReader({readBaseVehicles});
    function validateQuery(query) {
      const keys = Object.keys(query);
      if (keys.some(key => !contactQueryFields.has(key) || typeof query[key] !== 'string' ||
          query[key].length > (key === 'deliveryId' ? 64 : 32)) ||
          query.context === 'BASE' && (keys.includes('center') || keys.includes('deliveryId'))) {
        throw fail('DRIVER_CONTACT_INVALID_INPUT',400);
      }
    }
    const readAssignment = async identity => {
      const today = kstDay(now());
      if (identity.date > today) throw fail('DRIVER_CONTACT_INVALID_INPUT',400);
      if (identity.context === 'BASE') {
        if (identity.date !== today) throw badDatedIdentity();
        const assignment = await readBaseAssignment(identity);
        if (assignment.center !== config.center) throw fail('DRIVER_CENTER_SOURCE_UNVERIFIED');
        return assignment;
      }
      if (centers[identity.center] !== config.center) throw fail('DRIVER_CENTER_SOURCE_UNVERIFIED');
      if (typeof readDatedAssignment !== 'function') throw fail('DRIVER_ASSIGNMENT_SOURCE_UNAVAILABLE');
      return readDatedAssignment(identity);
    };
    mountPrivateDriverContact({...binding, readDriverMaster:readSheet, readAssignment, datedIdentity, preferExactDatedContact:true, validateQuery,
      enabled:() => enabled, readiness:() => configError});
    binding.app.get(masterRoute, binding.requireStaff, async (req,res) => {
      res.set('Cache-Control','private, no-store').vary('Cookie');
      if (!enabled || !config) return res.status(503).json({ok:false,error:configError || 'DRIVER_CONTACT_DISABLED'});
      const {date, center} = req.query;
      if (Object.keys(req.query).length !== 2 || !validDay(date) || date !== kstDay(now()) || center !== config.center) {
        return res.status(400).json({ok:false,error:'DRIVER_CONTACT_INVALID_INPUT'});
      }
      try {
        const value = await readSheet(date);
        const vehicles = value.vehicles.filter(row => row.driverName && !row.conflict)
          .map(({vehicle,driverName,effectiveDate}) => ({vehicle,driverName,effectiveDate}));
        return binding.requireStaff(req,res,()=>res.json({ok:true,vehicles,generatedAt:value.generatedAt}));
      } catch (error) {
        const code = /^DRIVER_[A-Z_0-9]+$/.test(error.code || '') ? error.code : 'DRIVER_SOURCE_UNAVAILABLE';
        return res.status(503).json({ok:false,error:code});
      }
    });
  }
  return {configured:!!config, center:config?.center || null, mount};
}
