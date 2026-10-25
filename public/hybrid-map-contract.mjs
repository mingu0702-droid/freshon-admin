// Public immutable package contract, shared by server and browser. No private fields.
export const isDay=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
export function validActualVehicle(v){
 if(typeof v!=='string'||v.length>24)return false;
 return v===''||/^(?:이천신규|오산신규|영남신규)$/.test(v)||/^\d{1,3}(?:호|호차)?$/.test(v)
  ||/^(?:용|용차|척|임|임시|대차)[-_]?\d{1,3}(?:[-_]\d{1,2})?(?:호|호차)?$/.test(v)
  ||/^\d{1,3}[-_]\d{1,2}(?:호|호차)?$/.test(v)||/^(?:-|미지정|미배정|미할당|없음|N\/A|용차|택배|직송|직배|자차|자가|기타)$/.test(v);
}
export const matchesVehicle=(actual,selected)=>!selected||actual.replace(/호(?:차)?$/,'')===selected.replace(/호(?:차)?$/,'');
const fail=code=>{throw Error(code);};
const plain=(v,n)=>typeof v==='string'&&v.length<=n&&!/[\r\n\x00-\x1f]|비밀번호|출입번호|도어락|(?:01[016789])[- ]?\d{3,4}[- ]?\d{4}/.test(v);
export function checkPublicManifest(m){
 const allowed=['schema','version','sourceGeneration','startDate','endDate','sourceObservedAt','publishedAt','customerCompletedThrough','coverage','dependencies','chunks','customerCount','visitCount'];
 if(!m||Object.keys(m).some(k=>!allowed.includes(k))||m.schema!=='map-public-package-v1'||!Number.isSafeInteger(m.version)||m.version<1
  ||!Number.isSafeInteger(m.sourceGeneration)||m.sourceGeneration<1||!isDay(m.startDate)||!isDay(m.endDate)||m.startDate>m.endDate
  ||!Number.isFinite(Date.parse(m.sourceObservedAt))||!Number.isFinite(Date.parse(m.publishedAt)))fail('HYBRID_PACKAGE_CONTRACT');
 const span=(Date.parse(m.endDate)-Date.parse(m.startDate))/86400000;
 if(span>89||!Array.isArray(m.chunks)||!m.chunks.length||m.chunks.length>32)fail('HYBRID_PACKAGE_CONTRACT');
 const c=m.coverage;
 if(!c||Object.keys(c).some(k=>!['verifiedDates','unconfirmedDates','proof'].includes(k))||!Array.isArray(c.verifiedDates)||!Array.isArray(c.unconfirmedDates)||!/^[A-Z_]+$/.test(c.proof||''))fail('HYBRID_PACKAGE_COVERAGE');
 const dates=[...c.verifiedDates,...c.unconfirmedDates];
 if(dates.length!==span+1||new Set(dates).size!==dates.length||dates.some(d=>!isDay(d)||d<m.startDate||d>m.endDate))fail('HYBRID_PACKAGE_COVERAGE');
 if(!m.dependencies||Object.keys(m.dependencies).some(k=>!['baseVehicle','coordinates','publicSource'].includes(k)||m.dependencies[k]!==null&&(typeof m.dependencies[k]!=='string'||m.dependencies[k].length>128)))fail('HYBRID_PACKAGE_CONTRACT');
 let count=0,visits=0;const keys=new Set();
 for(const e of m.chunks){
  if(!e||Object.keys(e).some(k=>!['key','hash','bytes','count','visits'].includes(k))||!/^public-\d{1,3}$/.test(e.key||'')||keys.has(e.key)
    ||!/^[a-f0-9]{64}$/.test(e.hash||'')||!Number.isSafeInteger(e.bytes)||e.bytes<2||e.bytes>1572864
    ||!Number.isSafeInteger(e.count)||e.count<0||!Number.isSafeInteger(e.visits)||e.visits<0)fail('HYBRID_PACKAGE_CONTRACT');
  keys.add(e.key);count+=e.count;visits+=e.visits;
 }
 if(count!==m.customerCount||visits!==m.visitCount||count>15000)fail('HYBRID_PACKAGE_CONTRACT');
 return m;
}
export function checkPublicChunk(rows,m,entry){
 if(!Array.isArray(rows)||rows.length!==entry.count)fail('HYBRID_PACKAGE_CONTRACT');
 const seen=new Set(),maxDay=(Date.parse(m.endDate)-Date.parse(m.startDate))/86400000;let visits=0;
 for(const r of rows){
  if(!Array.isArray(r)||r.length!==10||!/^[A-Z]\d+$/.test(r[0]||'')||seen.has(r[0])||!plain(r[1],200)||!plain(r[2],250)
   ||!(r[3]===null&&r[4]===null||Number.isFinite(r[3])&&r[3]>=33&&r[3]<=39.5&&Number.isFinite(r[4])&&r[4]>=124&&r[4]<=132)
   ||!plain(r[5],80)||!validActualVehicle(r[6])||!Array.isArray(r[7])||r[7].length!==7||r[7].some(v=>!validActualVehicle(v))
   ||r[8]!==null&&!Number.isFinite(Date.parse(r[8]))||!Array.isArray(r[9])||r[9].length>2000)fail('HYBRID_PACKAGE_CONTRACT');
  seen.add(r[0]);const triples=new Set();
  for(const v of r[9]){
   if(!Array.isArray(v)||v.length!==3||!Number.isInteger(v[0])||v[0]<0||v[0]>maxDay||!validActualVehicle(v[1])||!Number.isInteger(v[2])||v[2]<1||v[2]>100||triples.has(`${v[0]}|${v[1]}`))fail('HYBRID_PACKAGE_CONTRACT');
   triples.add(`${v[0]}|${v[1]}`);visits+=v[2];
  }
 }
 if(visits!==entry.visits)fail('HYBRID_PACKAGE_CONTRACT');return rows;
}
