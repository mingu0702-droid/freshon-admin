import { staffStoreDetail } from './opsmap-abc/mapStaffDetail.js';

const rateError = retryAfter => Object.assign(Error('DETAIL_SOURCE_RATE_LIMITED'), {status:429,retryAfter});

export function createStageStoreDetails({publication, now = Date.now}) {
  const pending = new Map();
  let pausedUntil = 0;

  function preserved({customerCode,date}) {
    const {snapshot,asOf,generation} = publication() || {};
    if (!/^[a-f0-9]{64}$/.test(generation || '') || snapshot?.sourceGeneration !== generation || !Array.isArray(snapshot.rows) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(asOf || '')) return null;
    const matches = snapshot.rows.filter(row=>row.customerCode === customerCode);
    if (matches.length !== 1) return null;
    const [row] = matches;
    if (row.addressChanged || row.resolutionStatus === 'ADDRESS_CHANGED_REVIEW_REQUIRED' ||
        !/^[a-f0-9]{64}$/.test(row.originalAddressHash || row.addressHash || '')) return null;
    const detail = staffStoreDetail({customerCode,customerName:row.customerName,address:row.address,
      ...(row.detailAddress != null ? {detailAddress:row.detailAddress} : {})},{customerCode,date});
    if (!detail.address) return null;
    return {value:{...detail,sourceBasis:'STAGE_VERIFIED_REGISTRY',source:'검증된 매장 자료',sourceDate:asOf},
      meta:{cache:'PRESERVED'}};
  }

  return async function read(identity,{refresh,automatic,load}) {
    const saved = preserved(identity);
    if (saved && (!refresh || automatic)) return saved;
    const key = identity.customerCode + ':' + identity.date;
    const existing = pending.get(key);
    if (existing) {
      const result = await existing;
      return {...result,meta:{...result.meta,cache:'COALESCED'}};
    }
    if (automatic) throw Object.assign(Error('DETAIL_SELECTION_REQUIRED'),{status:503});
    if (pausedUntil > now()) throw rateError(Math.ceil((pausedUntil-now())/1000));
    if (pending.size) throw Object.assign(Error('DETAIL_SOURCE_BUSY'),{status:503,retryAfter:1});
    const source = Promise.resolve().then(load).catch(error=>{
      if (error?.upstreamStatus === 429 || error?.message === 'HUB_RATE_LIMITED') {
        const seconds = Math.max(60, Number(error.retryAfter) || 0);
        pausedUntil = now() + seconds * 1000;
        throw rateError(seconds);
      }
      throw error;
    }).finally(()=>pending.delete(key));
    pending.set(key,source);
    return source;
  };
}
