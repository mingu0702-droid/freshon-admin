import test from 'node:test';
import assert from 'node:assert/strict';
import {customerRegistryAddressHash} from '../src/customerRegistry.js';
import {projectCurrentPostalRegistration} from '../src/shadowCoverage/postalCurrentRegistration.js';

const makeRow=(customerCode,lng,{lat=37.5,centerGroup='osan',kind='BUILDING'}={})=>{
  const basicAddress='Synthetic Test Building '+customerCode;
  const addressHash=customerRegistryAddressHash(basicAddress);
  return {customerCode,basicAddress,addressHash,centerGroup,lifecycle:'ACTIVE',verifiedLocation:{kind,lat,lng,addressHash}};
};
const zone=(id,w,e)=>({id,box:[w*1e6,37e6,e*1e6,38e6],
  rings:[Int32Array.from([w*1e6,37e6,e*1e6,37e6,e*1e6,38e6,w*1e6,38e6])]});

test('current registration requires address-bound official proof and unique strict interior',async()=>{
  const bad=makeRow('S7',126.5);
  bad.verifiedLocation.addressHash='a'.repeat(64);
  const stale={...makeRow('S8',126.5),basicAddress:'Changed current address'};
  const rows=[makeRow('S1',126.5),makeRow('S2',126.75),makeRow('S3',127),makeRow('S4',128.5),
    makeRow('S5',126.51,{centerGroup:'unknown',kind:'ADDRESS'}),makeRow('S6',126.5,{kind:'PARCEL'}),
    bad,stale,makeRow('S9',126.5),{...makeRow('S10',126.5),lifecycle:'DELETED'}];
  const geometry=[
    {box:[126,37,127,38],zones:[zone(11111,126,127)]},
    {box:[126.6,37,127,38],zones:[zone(11112,126.6,127)]}
  ];
  const actual=await projectCurrentPostalRegistration(rows,new Set(['S9']),geometry);
  assert.deepEqual([...actual.assignments],[['S1',{area:11111,center:'osan'}],['S5',{area:11111,center:null}]]);
  assert.deepEqual(actual.counts,{alreadyScoped:1,missingProof:3,ambiguous:2,outside:1,matched:2});
});

test('rejects repeated current registration identity instead of choosing a row',async()=>{
  const row=makeRow('S1',126.5);
  await assert.rejects(()=>projectCurrentPostalRegistration([row,row],new Set(),[]),/POSTAL_CURRENT_REGISTRY_IDENTITY/);
});
