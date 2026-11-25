import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { customerRegistryAddressHash } from '../src/customerRegistry.js';
import { readPostalAddressEvidence, sealPostalAddressEvidence } from '../src/shadowCoverage/postalAddressEvidence.js';

const key = Buffer.alloc(32, 17);
const version = 'b'.repeat(64);
const address = '서울특별시 종로구 사직로 1';
const addressHash = customerRegistryAddressHash(address);
const current = { customerCode:'S123', basicAddress:address, addressHash, lifecycle:'ACTIVE' };
const registry = { ref:{ version }, rows:[current] };
const source = { issuer:'MOIS_JUSO_BUILDING_DB', edition:'2026-10', datasetSha256:'c'.repeat(64), reviewSha256:'d'.repeat(64) };
const row = { customerCode:'S123', addressSha256:addressHash, buildingManagementNo:'1'.repeat(25), postalCode:'03047' };
const seal = (rows = [row], snapshot = registry) => sealPostalAddressEvidence({ registry:snapshot, source, rows }, key);
const corrupt = { message:'POSTAL_ADDRESS_EVIDENCE_INVALID' };

test('reads an approved postal address proof on the exact active address without coordinates', () => {
  const { bytes, reference } = seal();
  const data = readPostalAddressEvidence(bytes, { approvedReference:reference, registry, key });

  assert.equal(data.count, 1);
  assert.equal(data.registry, version);
  assert.equal(data.lookup('S000'), null);
  assert.deepEqual(data.lookup('S123'), {
    addressSha256:addressHash, buildingManagementNo:row.buildingManagementNo, postalCode:'03047'
  });
});

test('rejects unavailable approval, wrong digest, different approved source, wrong key, and tampering', () => {
  const { bytes, reference } = seal();
  assert.throws(() => readPostalAddressEvidence(bytes, { registry, key }), corrupt);
  assert.throws(() => readPostalAddressEvidence(bytes, {
    approvedReference:{ ...reference, sha256:'e'.repeat(64) }, registry, key
  }), corrupt);
  assert.throws(() => readPostalAddressEvidence(bytes, {
    approvedReference:{ ...reference, source:{ ...source, edition:'2026-11' } }, registry, key
  }), corrupt);
  assert.throws(() => readPostalAddressEvidence(bytes, { approvedReference:reference, registry, key:Buffer.alloc(32) }), corrupt);
  const changed = Buffer.from(bytes);
  changed[15] ^= 1;
  const sha256 = createHash('sha256').update(changed).digest('hex');
  assert.throws(() => readPostalAddressEvidence(changed, { approvedReference:{ ...reference, sha256 }, registry, key }), corrupt);
});

test('rejects a stale registry, changed address, deleted store, and duplicate current identity', () => {
  const { bytes, reference } = seal();
  const snapshots = [
    { ...registry, ref:{ version:'1'.repeat(64) } },
    { ...registry, rows:[{ ...current, basicAddress:'서울특별시 종로구 사직로 2' }] },
    { ...registry, rows:[{ ...current, lifecycle:'DELETED' }] },
    { ...registry, rows:[current, current] }
  ];
  for (const snapshot of snapshots) {
    assert.throws(() => readPostalAddressEvidence(bytes, { approvedReference:reference, registry:snapshot, key }), corrupt);
  }
});

test('revalidates unchanged active Osan addresses across daily registry versions without a new approval', () => {
  const {bytes,reference}=seal();
  const moved={...current,centerGroup:'osan'};
  const original=readPostalAddressEvidence(bytes,{approvedReference:reference,registry,key});
  const options={approvedReference:reference,key,retainMatchingOsan:true};
  for(const currentVersion of ['f'.repeat(64),'a'.repeat(64)]){
    const snapshot={ref:{version:currentVersion},rows:[{...moved,basicAddress:address.replace(' 종로구 ', '  종로구 ')}]};
    const accepted=readPostalAddressEvidence(bytes,{...options,registry:snapshot});
    assert.equal(accepted.registry,currentVersion);
    assert.deepEqual(accepted.lookup(row.customerCode),original.lookup(row.customerCode));
  }
  const snapshot={ref:{version:'e'.repeat(64)},rows:[moved]};
  for(const rows of [[],[{...moved,centerGroup:'yeongnam'}],[{...moved,lifecycle:'DELETED'}],
    [{...moved,basicAddress:address+'-2'}],[{...moved,addressHash:'0'.repeat(64)}],
    [{...moved,customerCode:'S124'}]]){
    const result=readPostalAddressEvidence(bytes,{...options,registry:{...snapshot,rows}});
    assert.equal(result.count,0);
    assert.equal(result.lookup(row.customerCode),null);
  }
  assert.throws(()=>readPostalAddressEvidence(bytes,{...options,registry:{...snapshot,rows:[moved,moved]}}),corrupt);
  assert.throws(()=>readPostalAddressEvidence(bytes,{...options,registry:snapshot,
    approvedReference:{...reference,registry:snapshot.ref.version}}),corrupt);
  const changed=Buffer.from(bytes);
  changed[29]^=1;
  assert.throws(()=>readPostalAddressEvidence(changed,{...options,registry:snapshot}),corrupt);
});

test('a changed proof row does not erase unrelated current address evidence or give evidence to a new customer',()=>{
  const other={...current,customerCode:'S124'};
  const {bytes,reference}=seal([row,{...row,customerCode:other.customerCode}],{
    ...registry,rows:[current,other]});
  const newCustomer={...current,customerCode:'S125',centerGroup:'osan'};
  const live={ref:{version:'a'.repeat(64)},rows:[{...current,centerGroup:'osan'},
    {...other,centerGroup:'honam'},newCustomer]};
  const checked=readPostalAddressEvidence(bytes,{approvedReference:reference,key,retainMatchingOsan:true,registry:live});
  assert.equal(checked.count,1);
  assert.equal(checked.lookup('S123').postalCode,'03047');
  assert.equal(checked.lookup('S124'),null);
  assert.equal(checked.lookup('S125'),null);
});

test('rejects duplicate evidence, conflicting postal codes per building, invalid identifiers, and geometry', () => {
  const duplicateBuilding = { ...row, customerCode:'S124', postalCode:'03048' };
  const twoStores = { ...registry, rows:[current, { ...current, customerCode:'S124' }] };
  assert.throws(() => seal([row, duplicateBuilding], twoStores), corrupt);
  const invalidRows = [
    [row, row],
    [{ ...row, postalCode:3047 }],
    [{ ...row, buildingManagementNo:'0'.repeat(25) }],
    [{ ...row, lat:37.5, lng:127 }]
  ];
  for (const rows of invalidRows) {
    assert.throws(() => seal(rows), corrupt);
  }
});
