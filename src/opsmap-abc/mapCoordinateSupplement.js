// Separate, bounded coordinate evidence. Never writes Customer or model shards.
import crypto from 'node:crypto';
export const coordinateValid = row => Number(row?.lat)>=33 && Number(row?.lat)<=39.5 && Number(row?.lng)>=124 && Number(row?.lng)<=132;
const canonicalAddress=value=>String(value||'').replace(/\([^)]*\)/g,'').replace(/^경상남도/,'경남').replace(/^경상북도/,'경북').replace(/^전라남도/,'전남').replace(/^전라북도|^전북특별자치도/,'전북').replace(/광역시|특별시/g,'').replace(/\s+/g,'');
export function validateCoordinateSupplement(value){
  if(value?.schema!==1||!Array.isArray(value.rows)||value.rows.length>200||!Number.isFinite(Date.parse(value.checkedAt)))throw Error('COORDINATE_CONTRACT');
  const seen=new Set(),allowed=['customerCode','group','lat','lng','address','source','checkedAt'];
  for(const row of value.rows){
    if(Object.keys(row).some(k=>!allowed.includes(k))||!/^[A-Z]\d+$/.test(row.customerCode)||seen.has(row.customerCode)||!['yeongnam','honam'].includes(row.group)||!coordinateValid(row)||!['STORED_MATCH','KAKAO_EXACT_ADDRESS'].includes(row.source)||!Number.isFinite(Date.parse(row.checkedAt))||typeof row.address!=='string'||row.address.length>200||/[\r\n]|비밀번호|출입|공동현관|연락처|01[016789][- ]?\d{3,4}[- ]?\d{4}/.test(row.address))throw Error('COORDINATE_CONTRACT');
    seen.add(row.customerCode);
  }
  const body={schema:1,checkedAt:value.checkedAt,rows:value.rows};
  if(crypto.createHash('sha256').update(JSON.stringify(body),'utf8').digest('hex')!==value.hash)throw Error('COORDINATE_HASH');
  return {body,hash:value.hash};
}
export function createCoordinateSupplement({callHub,now=Date.now}={}){
  let value=null,pending=null,lastAttempt=null,lastError=null;
  async function refresh(){
    if(pending)return pending;
    if(lastAttempt!==null&&now()-lastAttempt<300000)return;
    lastAttempt=now();
    pending=(async()=>{try{
      const response=await callHub('mapCoordinateSupplement',{}, {useCache:false});
      const checked=validateCoordinateSupplement(response.data);
      if(value&&Date.parse(checked.body.checkedAt)<Date.parse(value.body.checkedAt))throw Error('COORDINATE_SUPERSEDED');
      value=checked;lastError=null;
    }catch{lastError='COORDINATE_SUPPLEMENT_UNAVAILABLE';}finally{pending=null;}})();
    return pending;
  }
  function join(rows){
    const byCode=new Map((value?.body.rows||[]).map(r=>[r.customerCode,r]));
    return rows.map(row=>{
      const extra=byCode.get(row.customerCode);
      if(coordinateValid(row)||!extra)return row;
      if(row.address&&extra.address&&canonicalAddress(row.address)!==canonicalAddress(extra.address))return row;
      return {...row,lat:extra.lat,lng:extra.lng,address:row.address||extra.address,coordinateSource:extra.source,coordinateCheckedAt:extra.checkedAt};
    });
  }
  return {refresh,join,status:()=>({state:value?'READY':pending?'LOADING':'UNAVAILABLE',checkedAt:value?.body.checkedAt||null,count:value?.body.rows.length||0,lastError})};
}
