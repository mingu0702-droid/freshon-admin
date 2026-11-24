import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { customerRegistryAddressHash } from '../customerRegistry.js';

const schema = 'opsmap-postal-address-evidence-v1';
const context = Buffer.from(schema);
const issuer = 'MOIS_JUSO_BUILDING_DB';
const maxBytes = 1024 * 1024;
const maxRows = 4096;
const maxRegistryRows = 30000;
const digest = /^[a-f0-9]{64}$/;
const edition = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const code = /^[A-Z]\d{1,20}$/;
const building = /^[1-9]\d{24}$/;
const postal = /^\d{5}$/;
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
const invalid = () => Error('POSTAL_ADDRESS_EVIDENCE_INVALID');
const isDigest = value => typeof value === 'string' && digest.test(value);
const hasFields = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function assetKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw invalid();
  return Buffer.from(hkdfSync('sha256', key, context, Buffer.from('asset-encryption'), 32));
}

function checkedSource(source) {
  if (!hasFields(source, ['issuer', 'edition', 'datasetSha256', 'reviewSha256']) || source.issuer !== issuer ||
      typeof source.edition !== 'string' || !edition.test(source.edition) ||
      !isDigest(source.datasetSha256) || !isDigest(source.reviewSha256)) throw invalid();
  return { issuer, edition:source.edition, datasetSha256:source.datasetSha256, reviewSha256:source.reviewSha256 };
}

function checkedEvidence(value, registry) {
  if (!hasFields(value, ['schema', 'registry', 'source', 'rows']) || value.schema !== schema ||
      !isDigest(value.registry) || registry?.ref?.version !== value.registry ||
      !Array.isArray(registry.rows) || registry.rows.length > maxRegistryRows ||
      !Array.isArray(value.rows) || !value.rows.length || value.rows.length > maxRows) throw invalid();
  const source = checkedSource(value.source);
  const registryByCode = new Map();
  for (const row of registry.rows) {
    if (typeof row?.customerCode !== 'string' || !code.test(row.customerCode) ||
        registryByCode.has(row.customerCode)) throw invalid();
    registryByCode.set(row.customerCode, row);
  }
  const postalByBuilding = new Map();
  let previous = '';
  for (const row of value.rows) {
    if (!Array.isArray(row) || row.length !== 4) throw invalid();
    const [customerCode, addressSha256, buildingManagementNo, postalCode] = row;
    if (typeof customerCode !== 'string' || !code.test(customerCode) || customerCode <= previous ||
        !isDigest(addressSha256) || typeof buildingManagementNo !== 'string' || !building.test(buildingManagementNo) ||
        typeof postalCode !== 'string' || !postal.test(postalCode) || postalCode < '01000') throw invalid();
    const current = registryByCode.get(customerCode);
    if (current?.lifecycle !== 'ACTIVE' || typeof current.basicAddress !== 'string' || !current.basicAddress.trim() ||
        current.addressHash !== addressSha256 || customerRegistryAddressHash(current.basicAddress) !== addressSha256 ||
        (postalByBuilding.has(buildingManagementNo) && postalByBuilding.get(buildingManagementNo) !== postalCode)) throw invalid();
    postalByBuilding.set(buildingManagementNo, postalCode);
    previous = customerCode;
  }
  return { schema, registry:value.registry, source, rows:value.rows };
}

// Accepts only single-building evidence from an independently verified review.
// The returned reference is a candidate for approval. The reader requires a pinned approval.
export function sealPostalAddressEvidence({ registry, source, rows }, key) {
  if (!Array.isArray(rows) || !rows.length || rows.length > maxRows ||
      rows.some(row => !hasFields(row, ['customerCode', 'addressSha256', 'buildingManagementNo', 'postalCode']) ||
        typeof row.customerCode !== 'string')) throw invalid();
  const ordered = rows.map((row) => [row.customerCode, row.addressSha256, row.buildingManagementNo, row.postalCode])
    .sort((a, b) => a[0] === b[0] ? 0 : a[0] < b[0] ? -1 : 1);
  const checked = checkedEvidence({ schema, registry:registry?.ref?.version, source, rows:ordered }, registry);
  const plain = Buffer.from(JSON.stringify(checked));
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', assetKey(key), nonce);
  cipher.setAAD(context);
  const bytes = Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  if (bytes.length > maxBytes) throw invalid();
  return { bytes, reference:{ registry:checked.registry, source:checked.source, sha256:checksum(bytes) } };
}

export function readPostalAddressEvidence(bytes, { approvedReference, registry, key } = {}) {
  if (!hasFields(approvedReference, ['registry', 'source', 'sha256']) ||
      !isDigest(approvedReference.registry) || approvedReference.registry !== registry?.ref?.version ||
      !isDigest(approvedReference.sha256) || !Buffer.isBuffer(bytes) ||
      bytes.length < 29 || bytes.length > maxBytes || checksum(bytes) !== approvedReference.sha256) throw invalid();
  const approvedSource = checkedSource(approvedReference.source);

  let value;
  try {
    const decipher = createDecipheriv('aes-256-gcm', assetKey(key), bytes.subarray(0, 12));
    decipher.setAAD(context);
    decipher.setAuthTag(bytes.subarray(-16));
    const plain = Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
    value = JSON.parse(plain.toString('utf8'));
  } catch {
    throw invalid();
  }
  const verified = checkedEvidence(value, registry);
  if (verified.registry !== approvedReference.registry ||
      Object.keys(approvedSource).some(field => approvedSource[field] !== verified.source[field])) throw invalid();
  const byCode = new Map(verified.rows.map(([customerCode, addressSha256, buildingManagementNo, postalCode]) =>
    [customerCode, Object.freeze({ addressSha256, buildingManagementNo, postalCode })]));
  return Object.freeze({
    registry:verified.registry, source:Object.freeze(verified.source), count:byCode.size,
    lookup:customerCode => byCode.get(customerCode) || null
  });
}
