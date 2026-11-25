import {promisify} from 'node:util';
import {gzip} from 'node:zlib';
import {transferVersion} from './opsmapTransferVersion.js';

const zip = promisify(gzip);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const code = value => typeof value === 'string' && /^[A-Z]\d{1,20}$/.test(value);
const maxRows = 30_000;
const maxClearBytes = 18 * 1024 * 1024;
const source = 'STAGE_FRESHON_NATIONAL_REGISTRY';
const basis = 'FIXED_DISPATCH_PRIMARY';

export function createMapStartupReader({readSnapshot, readRegistry, readFixed, snapshotMeta, projectSnapshot}) {
  let saved, pending;
  async function build() {
    const [snapshot, national] = await Promise.all([readSnapshot(), readRegistry()]);
    if (!digest(snapshot?.sourceGeneration) || !snapshot.rows?.length ||
        !digest(national?.ref?.version) || !Number.isFinite(Date.parse(national.ref.checkedAt)) ||
        !national.rows?.length || national.rows.length !== national.ref.count ||
        snapshot.rows.length > maxRows || national.rows.length > maxRows) return null;

    // A newer registry may use the same fixed object. Only materialize that
    // object's rows when building a new representation.
    const fixed = await readFixed(saved?.fixedTransfer);
    const fm = fixed?.meta;
    if (!fixed?.ok || !digest(fixed.transferVersion) || !digest(fm?.version) ||
        fm.basis !== basis || !Number.isFinite(Date.parse(fm.checkedAt)) ||
        typeof fm.stale !== 'boolean') return null;
    const registryVersion = national.ref.version;
    const checkedAt = national.ref.checkedAt;
    const mapMeta = snapshotMeta(snapshot);
    const stamp = transferVersion([mapMeta, registryVersion, checkedAt, fixed.transferVersion]);
    if (fixed.notModified && saved?.snapshot === snapshot && saved.version === stamp) return saved;
    const fullFixed = fixed.notModified ? await readFixed() : fixed;
    if (!fullFixed?.ok || fullFixed.transferVersion !== fixed.transferVersion ||
        !Array.isArray(fullFixed.data) || fullFixed.data.length !== fm.total || !fm.total || fm.total > maxRows) return null;

    const codes = new Set();
    const registryRows = [];
    for (const row of national.rows) {
      if (!code(row.customerCode) || codes.has(row.customerCode)) return null;
      codes.add(row.customerCode);
      const {customerCode, customerName, basicAddress, addressHash, sourceUpdatedAt, lifecycle, centerGroup, verifiedLocation} = row;
      registryRows.push({customerCode, customerName, basicAddress, addressHash, sourceUpdatedAt, lifecycle,
        centerGroup, ...(verifiedLocation ? {verifiedLocation} : {}), nationalRegistry:true});
    }
    for (const row of snapshot.rows) {
      if (!code(row.customerCode)) return null;
      codes.add(row.customerCode);
    }
    if (codes.size > maxRows) return null;
    const byCode = new Map();
    for (const row of fullFixed.data) {
      const {customerCode,baseVehicle,baseVehicleGroup,baseVehicleState,baseVehicleEmptyVerified,weekdays,baseVehicleStale} = row;
      if (!code(customerCode) || byCode.has(customerCode) || row.baseVehicleVersion !== fm.version ||
          row.baseVehicleCheckedAt !== fm.checkedAt || row.baseVehicleSource !== basis) return null;
      if (codes.has(customerCode)) byCode.set(customerCode,{customerCode,baseVehicle,baseVehicleGroup,baseVehicleState,
        baseVehicleEmptyVerified,weekdays,baseVehicleStale});
    }
    // Absence in a completely verified master is a confirmed absence. It
    // does not remove a registered customer or assign a delivery vehicle.
    const fixedRows = [...codes].map(customerCode=>byCode.get(customerCode) ?? {
      customerCode,baseVehicle:'',baseVehicleGroup:'',baseVehicleState:'NOT_IN_MASTER',baseVehicleStale:fm.stale
    });
    const meta = {registryVersion,checkedAt,source,fixedVersion:fm.version};
    const body = Buffer.from(JSON.stringify({ok:true,meta,data:{
      snapshot:{rows:projectSnapshot(snapshot),meta:mapMeta},
      registry:{contract:'customer-registry-v1',version:registryVersion,sourceVersion:registryVersion,
        mode:'FULL',complete:true,deletionPolicy:'EXPLICIT_ONLY',afterCursor:null,nextCursor:null,total:registryRows.length,rows:registryRows},
      fixed:{rows:fixedRows,meta:fm}
    }}));
    if (body.length > maxClearBytes) return null;
    const compressed = await zip(body,{level:4});
    saved = {snapshot,version:stamp,fixedTransfer:fixed.transferVersion,meta,body,compressed};
    return saved;
  }
  return function read() {
    pending ??= build().finally(()=>{pending=null;});
    return pending;
  };
}

export function mountMapStartup(app,{requireStaff,read,recovery,restoreMs}) {
  app.get('/api/map-phase2b/private/map-startup',requireStaff,async(req,res)=>{
    res.set('Cache-Control','private, no-store').vary('Cookie').vary('Accept-Encoding');
    const started=recovery?performance.now():null;
    let result;
    try { if (!Object.keys(req.query).length) result=await read(); }
    catch { /* Keep the initial view unpopulated until both archives are verified. */ }
    const prepareMs=started===null?null:performance.now()-started;
    return requireStaff(req,res,()=>{
      if (prepareMs!==null) res.set('Server-Timing',`opsmap-startup-prepare;dur=${prepareMs.toFixed(2)}`);
      const restored=restoreMs?.();
      if (Number.isFinite(restored)) res.set('X-Opsmap-Restore-Ms',String(restored));
      if (!result) {
        const restoring = !recovery || recovery()==='RESTORING';
        if (restoring) res.set('Retry-After','2');
        return res.status(503).json({error:restoring?'OPSMAP_STARTUP_NOT_READY':'OPSMAP_STARTUP_UNAVAILABLE'});
      }
      res.set('X-Opsmap-Startup-Version',result.version);
      if (req.get('X-Opsmap-Known-Startup')===result.version)
        return res.json({ok:true,notModified:true,meta:result.meta});
      res.type('application/json');
      if (req.acceptsEncodings('gzip','identity')==='gzip')
        return res.set('Content-Encoding','gzip').send(result.compressed);
      return res.send(result.body);
    });
  });
}
