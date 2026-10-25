// Local candidate only. The caller supplies an already-authorized bounded reader.
// Raw addresses exist only in this private call; the returned object is hash-only.
import { coordinateAddressHash } from './opsmapAutoCoordinates.js';
export const ADDRESS_RULE = 'NFKC_LOWERCASE_WS_TRIM_SHA256_UTF8_V1';
export const SOURCE_PLAN = Object.freeze({ spreadsheetId:'1yXE6cq2OCz28TOHJwzF1Lr7Y7gLzsxUbzBBhclTsaHk', sheet:'daily_routes', sheetId:1661378703,
  date:'2026-10-23', firstRow:230800, lastRow:232837, rowCount:2038, uniqueCustomers:2036,
  ranges:Object.freeze(['A230800:A232837','H230800:H232837','L230800:L232837']), maxCalls:5, maxMs:60000 });
const version = value => typeof value === 'string' && /^\d+$/.test(value) ? value : null;
const fail = code => { throw Error(code); };
export async function collectPrivateCustomerAddressEvidence({ reader, now=Date.now, plan=SOURCE_PLAN }={}) {
  if (!reader || typeof reader.version!=='function' || typeof reader.values!=='function' || plan!==SOURCE_PLAN) fail('PRIVATE_SOURCE_CONTRACT');
  const started=now(); let calls=0;
  const invoke=async work => {
    if(++calls>plan.maxCalls || now()-started>=plan.maxMs) fail('PRIVATE_SOURCE_BUDGET');
    let result;
    try { result=await work(); } catch { fail('PRIVATE_SOURCE_READ_FAILED'); }
    if(now()-started>=plan.maxMs) fail('PRIVATE_SOURCE_BUDGET');
    return result;
  };
  const before=version(await invoke(()=>reader.version(plan.spreadsheetId)));
  if(!before) fail('SOURCE_VERSION_UNAVAILABLE');
  let dates, codes, addresses;
  try {
    // A is the confirmed deliveryDate column; do not rely on a caller's target label.
    dates=await invoke(()=>reader.values(plan.sheet,plan.ranges[0]));
    codes=await invoke(()=>reader.values(plan.sheet,plan.ranges[1]));
    addresses=await invoke(()=>reader.values(plan.sheet,plan.ranges[2]));
    const after=version(await invoke(()=>reader.version(plan.spreadsheetId)));
    if(!after) fail('SOURCE_VERSION_UNAVAILABLE');
    if(before!==after) fail('SOURCE_CHANGED');
    if([dates,codes,addresses].some(a=>!Array.isArray(a)||a.length!==plan.rowCount)) fail('SOURCE_RANGE_INCOMPLETE');
    const out=new Map(); let blanks=0;
    for(let i=0;i<plan.rowCount;i++) {
      const date=dates[i]?.[0], customerCode=codes[i]?.[0], address=addresses[i]?.[0];
      if(date!==plan.date || typeof customerCode!=='string' || !/^[A-Z]\d{1,20}$/.test(customerCode)) fail('SOURCE_IDENTITY_MISMATCH');
      const addressHash=coordinateAddressHash(address);
      if(!addressHash) { blanks++; continue; }
      const old=out.get(customerCode);
      if(old && old.addressHash!==addressHash) fail('SOURCE_ADDRESS_CONFLICT');
      if(old) old.deliveryRows++; else out.set(customerCode,{customerCode,deliveryDate:date,addressHash,deliveryRows:1});
    }
    if(blanks || out.size!==plan.uniqueCustomers) fail('SOURCE_ADDRESS_INCOMPLETE');
    return {schema:'opsmap-private-customer-address-v1', rule:ADDRESS_RULE, date:plan.date,
      source:{spreadsheetId:plan.spreadsheetId,sheetId:plan.sheetId,ranges:plan.ranges,versionBefore:before,versionAfter:after},
      rows:[...out.values()], summary:{sourceRows:plan.rowCount,customers:out.size,addressConflicts:0,externalCalls:calls,elapsedMs:now()-started},
      businessCompletenessVerified:false, rawAddressRetained:false};
  } finally {
    // Erase only this adapter's private temporary arrays; no source/cache mutation.
    dates=null; codes=null; addresses=null;
  }
}


