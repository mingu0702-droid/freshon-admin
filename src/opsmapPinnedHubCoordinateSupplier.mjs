import { createHash } from 'node:crypto';
import { coordinateAddressHash } from './opsmapAutoCoordinates.js';
import { projectStoredCoordinateDisplay } from './opsmapStoredCoordinateDisplay.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const digest = value => sha(JSON.stringify(value));
const codeValid = value => typeof value === 'string' && /^[A-Z]\d{1,20}$/.test(value);
const pointValid = row => typeof row?.[3] === 'number' && typeof row?.[4] === 'number' && Number.isFinite(row[3]) && Number.isFinite(row[4]) && row[3] >= 33 && row[3] <= 39.5 && row[4] >= 124 && row[4] <= 132;
const parsePinned = (bytes, pin) => { if (!(bytes instanceof Uint8Array) || sha(bytes) !== pin) throw Error('HUB_SUPPLIER_INPUT_PIN_MISMATCH'); return JSON.parse(Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/, '')); };
export const PINNED_HUB_STORED_SOURCES = Object.freeze({
  originalCoordinateInputSha256: 'ed7b63019a351a8e6c0ed564ee87b9550f141ce884c610216ed0757c799929a2',
  sourceManifestSha256: 'f9cf33660eea5baef810f13eb54187940b24e72cf2377272fca8384181ae355d',
  readOnlyPinsSha256: '84258f0367ddba6c0c6f9f6b9497515755cd307896172697859222e4f4989ea5',
  chunks: Object.freeze([
    Object.freeze({ name: 'public-0', fileId: '1IIOsJroBoUcqaxzO5IkQx1TkCoIEJL80', sha256: '251e1605070e4e7ace10837a4127779f296782ad187f76e3eaf53a4ae4d1eda2', count: 2874 }),
    Object.freeze({ name: 'public-1', fileId: '1Lerz2B1av54VMKWzQIJ2GErSQ2igpQ0X', sha256: '4df1b8e3d1d8ddd93c23b252336669b93b26d93235eba41c5e896eb186475fb0', count: 2928 })
  ])
});

// A separate stored-Hub supplier, not a synthetic B day or a RAW_GPS claim.
// Raw addresses are hashed in memory; returned provenance contains hashes only.
export function supplementPinnedHubStoredCoordinates({ sourceBytes, targetPin, originalCoordinateInputBytes, hubChunkBytes, sourceManifestBytes, readOnlyPinsBytes } = {}) {
  const pins = PINNED_HUB_STORED_SOURCES;
  const original = parsePinned(originalCoordinateInputBytes, pins.originalCoordinateInputSha256);
  const manifest = parsePinned(sourceManifestBytes, pins.sourceManifestSha256), receipt = parsePinned(readOnlyPinsBytes, pins.readOnlyPinsSha256);
  const before = projectStoredCoordinateDisplay({ sourceBytes, targetPin, ...original });
  const envelope = JSON.parse(Buffer.from(sourceBytes).toString('utf8'));
  if (!Array.isArray(hubChunkBytes) || hubChunkBytes.length !== pins.chunks.length || manifest.operationalWrites !== 0 ||
      receipt.schema !== 1 || receipt.purpose !== 'READ_ONLY_UNPUBLISHED_CANDIDATE_REVIEW' || receipt.remoteWritesApproved !== false ||
      receipt.published !== false || receipt.coverageComplete !== false || receipt.currentness !== 'UNCONFIRMED' ||
      receipt.sourceRange?.startDate !== '2026-07-01' || receipt.sourceRange?.endDate !== '2026-09-28') throw Error('HUB_SUPPLIER_SCOPE_UNVERIFIED');
  const latest = new Map(envelope.data.map(row => [row[0], row])), current = new Map(), existing = new Set(original.verifiedCoordinates.map(row => row.customerCode));
  for (const row of original.currentAddressEvidence.rows) {
    const hashes = current.get(row.customerCode) || new Set(); hashes.add(row.addressHash); current.set(row.customerCode, hashes);
  }
  const seen = new Set(), rows = [], provenance = [], rejected = {}, counts = { sourceRows: 0, validStoredPoints: 0, latestCodeOverlap: 0 };
  const reject = reason => { rejected[reason] = (rejected[reason] || 0) + 1; };
  for (const [chunkIndex, pin] of pins.chunks.entries()) {
    const source = parsePinned(hubChunkBytes[chunkIndex], pin.sha256), reference = receipt.chunks?.[pin.name], manifestPin = manifest.hub?.find(row => row.name === pin.name + '.json');
    if (!Array.isArray(source) || source.length !== pin.count || reference?.id !== pin.fileId || reference.hash !== pin.sha256 || reference.count !== source.length ||
        reference.bytes !== hubChunkBytes[chunkIndex].byteLength || manifestPin?.fileId !== pin.fileId || manifestPin.sha256 !== pin.sha256) throw Error('HUB_SUPPLIER_SOURCE_REFERENCE_MISMATCH');
    for (const [sourceRowIndex, row] of source.entries()) {
      counts.sourceRows++;
      if (!Array.isArray(row) || row.length !== 10 || !codeValid(row[0]) || seen.has(row[0])) throw Error('HUB_SUPPLIER_CUSTOMER_CONFLICT');
      seen.add(row[0]);
      if (!pointValid(row)) continue;
      counts.validStoredPoints++;
      const target = latest.get(row[0]); if (!target) continue;
      counts.latestCodeOverlap++;
      if (existing.has(row[0])) { reject('EXISTING_VERIFIED_CUSTOMER_UNCHANGED'); continue; }
      if (typeof row[1] !== 'string' || !row[1] || row[1] !== target[1]) { reject('CUSTOMER_IDENTITY_MISMATCH'); continue; }
      const addressHash = coordinateAddressHash(row[2]), hashes = current.get(row[0]);
      if (!addressHash || hashes?.size !== 1 || !hashes.has(addressHash)) { reject('CURRENT_ADDRESS_HASH_MISMATCH_OR_CONFLICT'); continue; }
      rows.push({ customerCode: row[0], addressHash, lat: row[3], lng: row[4], coordinateSource: 'STORED_MATCH', geocodeStatus: 'OK', verified: true });
      provenance.push({ customerCode: row[0], customerNameHash: digest(row[1]), addressHash, pointHash: digest({ lat: row[3], lng: row[4] }), sourceFileSha256: pin.sha256, sourceFileId: pin.fileId, sourceRowIndex, sourceRowNumber: sourceRowIndex + 1, coordinateSource: 'STORED_MATCH', verificationScope: 'PINNED_HUB_STORED_POINT_EXACT_CURRENT_CODE_NAME_ADDRESS_HASH', rawGpsAttested: false });
    }
  }
  const coordinateInput = { ...original, verifiedCoordinates: [...original.verifiedCoordinates, ...rows], hubStoredSupplement: { schema: 'opsmap-pinned-hub-stored-supplement-v1', pins, sourceRange: receipt.sourceRange, rows: provenance, originalVerifiedRowsSha256: digest(original.verifiedCoordinates), rawAddressesRetained: false, collectionReceiptAvailable: false, publicationReceiptAvailable: false, businessCoverage: 'UNCONFIRMED', currentness: 'UNCONFIRMED', published: false, productionEligible: false } };
  const after = projectStoredCoordinateDisplay({ sourceBytes, targetPin, ...coordinateInput });
  return { coordinateInput, before, after, summary: { ...counts, addedVerifiedRows: rows.length, totalVerifiedRows: coordinateInput.verifiedCoordinates.length, beforeMatched: before.summary.matched, afterMatched: after.summary.matched, rejected }, proof: { addedCodeSetSha256: digest(rows.map(row => row.customerCode).sort()), addedPointSetSha256: digest(rows.map(row => [row.customerCode, row.addressHash, row.lat, row.lng]).sort(([a], [b]) => a.localeCompare(b))), provenanceSha256: digest(provenance), originalVerifiedRowsUnchanged: digest(coordinateInput.verifiedCoordinates.slice(0, original.verifiedCoordinates.length)) === digest(original.verifiedCoordinates), criterion: 'B_STORED_MATCH_SAME_CODE_EXACT_NAME_PINNED_HUB_ADDRESS_VALID_STORED_POINT', ...coordinateInput.hubStoredSupplement, rows: undefined } };
}
