import {createHash} from 'node:crypto';

// Host identities are fixed in code and never inferred from a request header.
export const STAGE_ORIGIN = 'https://freshon-admin-stage-preview-template.onrender.com';
export const STAGE_SERVICE = 'srv-da47hugu01pc73etpfa0';
export const PRIMARY_ORIGIN = 'https://freshon-admin-1.onrender.com';
export const PRIMARY_SERVICE = 'srv-d87gc5rtqb8s7398t37g';

export function primaryPreservationEvidence(env) {
  const raw=env.OPSMAP_PRIMARY_PRESERVATION_JSON;
  if(typeof raw!=='string'||raw.length>4096||
      createHash('sha256').update(raw).digest('hex')!==env.OPSMAP_PRIMARY_PRESERVATION_SHA256)return null;
  let value;
  try {value=JSON.parse(raw);}catch{return null;}
  if(value?.schema!==1||value.destination!==PRIMARY_ORIGIN||
      !['operationsArchive','wmsArchive','legacySnapshotArchive','legacyAuthArchive','legacyPinsArchive','stagePinsArchive'].every(
        key=>/^[a-f0-9]{40}$/.test(value[key]||''))||
      value.legacyRegistryVerified!==true||value.legacyRegistryUnconfirmed!==0||value.legacyFixedUnconfirmed!==0||value.stagePinsUnconfirmed!==0||
      !Number.isSafeInteger(value.legacyRegistryChecked)||value.legacyRegistryChecked<1||
      !Number.isSafeInteger(value.legacyFixedChecked)||value.legacyFixedChecked<1)return null;
  return value;
}

export function opsmapArchiveSite(env) {
  if(env.RENDER_SERVICE_ID===STAGE_SERVICE&&env.RENDER_EXTERNAL_URL===STAGE_ORIGIN)return 'stage';
  if(env.RENDER_SERVICE_ID===PRIMARY_SERVICE&&env.RENDER_EXTERNAL_URL===PRIMARY_ORIGIN&&
      env.OPSMAP_PRIMARY_CUTOVER_APPROVED==='1'&&env.OPSMAP_PRIMARY_ARCHIVE_READ_APPROVED==='1'&&
      env.OPSMAP_PRIMARY_ARCHIVE_READ_TOKEN&&primaryPreservationEvidence(env))return 'primary';
  return null;
}

export function opsmapArchiveWriteApproved(env) {
  const site=opsmapArchiveSite(env);
  return site==='stage'||site==='primary'&&env.OPSMAP_PRIMARY_SYNC_OWNER==='1'&&
    env.OPSMAP_PRIMARY_ARCHIVE_WRITE_APPROVED==='1'&&Boolean(env.OPSMAP_PRIMARY_ARCHIVE_WRITE_TOKEN);
}
export const STAGE_BUNDLE_ROUTE = '/api/map-phase2b/private/stage-validation-bundle';
export const STAGE_NEARBY_ROUTE = '/api/map-phase2b/private/stage-nearby-evidence';
export const STAGE_VEHICLE_DELIVERY_ROUTE = '/api/map-phase2b/private/stage-vehicle-delivery-evidence';
export const STAGE_ADDRESS_BATCH_ROUTE = '/api/map-phase2b/private/stage-address-evidence';
export const MAX_STAGE_BUNDLE_BYTES = 1088 * 1024;
