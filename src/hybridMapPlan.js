// Local release candidate contract. Not registered with any production route.
const DAY = 86400000;
import {validActualVehicle} from '../public/hybrid-map-contract.mjs';
import {createHash} from 'node:crypto';
const fail = code => { throw new Error(code); };
export function validDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function kstDay(now = Date.now()) {
  if (!Number.isFinite(now)) fail('INVALID_CLOCK');
  return new Date(now + 9 * 3600000).toISOString().slice(0, 10);
}
export function shiftDay(day, offset) {
  if (!validDay(day) || !Number.isInteger(offset)) fail('INVALID_DATE');
  return new Date(Date.parse(day) + offset * DAY).toISOString().slice(0, 10);
}
export function rollingWindow(today) {
  if (!validDay(today)) fail('INVALID_DATE');
  return Object.freeze({ startDate: shiftDay(today, -89), endDate: today });
}
function checkedRef(ref, today) {
  if (!ref || !validDay(ref.date) || ref.date >= today || ref.kind !== 'period'
      || ref.source !== 'Freshon' || ref.verified !== true || ref.complete !== true
      || !/^[a-f0-9]{64}$/.test(ref.hash || '') || !Number.isSafeInteger(ref.count) || ref.count < 0
      || typeof ref.revision !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(ref.revision)
      || typeof ref.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(ref.id)) fail('UNVERIFIED_DAY_REFERENCE');
  // No raw rows or private data can enter the resident manifest.
  return Object.freeze(Object.fromEntries(['date','kind','source','verified','complete','hash','count','revision','id'].map(k => [k, ref[k]])));
}
export function makeHybridManifest({ version, expectedVersion, currentVersion, today, baseVersion, baseEndDate, baseRefs, deltaRefs = [], latestStores }) {
  if (!validDay(today) || !validDay(baseEndDate) || baseEndDate >= today
      || typeof version !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(version)
      || typeof baseVersion !== 'string' || !baseVersion || !Array.isArray(baseRefs) || !Array.isArray(deltaRefs)) fail('INVALID_MANIFEST');
  if (expectedVersion !== currentVersion) fail('MANIFEST_POINTER_CHANGED');
  if (!latestStores || latestStores.scope !== 'ALL_LATEST_STORES' || latestStores.verified !== true
      || !/^[a-f0-9]{64}$/.test(latestStores.hash || '') || !/^[A-Za-z0-9_-]{1,128}$/.test(latestStores.id || '')) fail('LATEST_STORES_REQUIRED');
  const window = rollingWindow(today), refs = new Map();
  for (const input of baseRefs) {
    const ref = checkedRef(input, today);
    if (ref.date > baseEndDate || refs.has(ref.date)) fail('BASE_REFERENCE_CONFLICT');
    refs.set(ref.date, ref);
  }
  const changed = new Set();
  for (const input of deltaRefs) {
    const ref = checkedRef(input, today);
    if (changed.has(ref.date)) fail('DUPLICATE_DELTA_DATE');
    changed.add(ref.date); refs.set(ref.date, ref); // A corrected day replaces, never appends to its old revision.
  }
  const days = [...refs.values()].filter(ref => ref.date >= window.startDate && ref.date <= window.endDate).sort((a,b) => a.date.localeCompare(b.date));
  // Retiring a reference is metadata-only. No source/package file delete is exposed.
  return Object.freeze({ schema: 'hybrid-period-candidate-v1', version, baseVersion, baseEndDate, ...window,
    latestStores: Object.freeze({ scope: latestStores.scope, id: latestStores.id, hash: latestStores.hash, verified: true }),
    days: Object.freeze(days), expectedVersion });
}
export function planHybridPeriod(manifest, { startDate, endDate, today, vehicle = '' }) {
  if (!manifest || manifest.schema !== 'hybrid-period-candidate-v1' || !Array.isArray(manifest.days)) fail('INVALID_MANIFEST');
  if (!validDay(startDate) || !validDay(endDate) || !validDay(today) || startDate > endDate || endDate > today) fail('INVALID_RANGE');
  const window = rollingWindow(today);
  if (startDate < window.startDate) fail('ARCHIVE_SEPARATE_QUERY_REQUIRED');
  if (manifest.endDate !== today) fail('MANIFEST_DAY_ROLLOVER');
  if (vehicle && !validActualVehicle(vehicle)) fail('INVALID_VEHICLE');
  const refs = new Map(manifest.days.map(ref => [ref.date, checkedRef(ref, today)])), steps = [];
  for (let day = startDate; day <= endDate; day = shiftDay(day, 1)) {
    if (day === today) steps.push(Object.freeze({ mode: 'CURRENT_FRESHON_DAY', date: day, vehicle, version: manifest.version }));
    else {
      const ref = refs.get(day);
      if (!ref) fail('DAY_COVERAGE_UNCONFIRMED'); // A missing date is not a successful zero-result day.
      steps.push(Object.freeze({ mode: 'VERIFIED_DAY', date: day, vehicle, version: manifest.version, ref }));
    }
  }
  return Object.freeze({ version: manifest.version, startDate, endDate, steps: Object.freeze(steps), archiveIncluded: false });
}

// Existing date-ref replacement, extended to a closed collection watermark.
// Authenticated completion and change-log verification are mandatory injected IO.
// Snapshot only data, never IO. Values read from JSON lose Object.freeze; keep an
// owned, bounded snapshot across awaits so verification and CAS see the same data.
function rollingDataSnapshot_(input) {
 const budget={bytes:0,nodes:0};
 function charge(n){budget.bytes+=n;if(budget.bytes>4194304||++budget.nodes>150000)fail('ROLLING_INPUT_LIMIT');}
 function stringSize(v){
  // Exact UTF-8 JSON-string bytes, without materializing an escaped copy.
  let size=2;for(let i=0;i<v.length;i++){
   const c=v.charCodeAt(i);
   if(c===34||c===92)size+=2;
   else if(c<32)size+=[8,9,10,12,13].includes(c)?2:6;
   else if(c<128)size++;
   else if(c<2048)size+=2;
   else if(c>=0xd800&&c<=0xdbff){const n=v.charCodeAt(i+1);if(n>=0xdc00&&n<=0xdfff){size+=4;i++;}else size+=6;}
   else if(c>=0xdc00&&c<=0xdfff)size+=6;
   else size+=3;
   if(size+budget.bytes>4194304)fail('ROLLING_INPUT_LIMIT');
  }return size;
 }
 function visit(v,depth){
  if(depth>16)fail('ROLLING_INPUT_LIMIT');
  if(v===null||typeof v==='boolean'){charge(5);return v;}
  if(typeof v==='string'){charge(stringSize(v));return v;}
  if(typeof v==='number'){if(!Number.isFinite(v))fail('ROLLING_INPUT_DATA');charge(24);return v;}
  if(typeof v!=='object')fail('ROLLING_INPUT_DATA');
  charge(2);
  if(Array.isArray(v)){
   if(v.length>5000||Object.keys(v).length!==v.length)fail('ROLLING_INPUT_LIMIT');
   charge(Math.max(0,v.length-1)); // JSON commas count toward the serialized cap.
   return Object.freeze(Array.from({length:v.length},(_,i)=>{
    const d=Object.getOwnPropertyDescriptor(v,String(i));if(!d||!('value'in d))fail('ROLLING_INPUT_DATA');
    return visit(d.value,depth+1);
   }));
  }
  if(Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null)fail('ROLLING_INPUT_DATA');
  const out={};let fields=0;for(const k of Reflect.ownKeys(v)){
   if(typeof k!=='string'||k==='__proto__'||k==='constructor'||k==='prototype')fail('ROLLING_INPUT_DATA');
   const d=Object.getOwnPropertyDescriptor(v,k);if(!d?.enumerable||!('value'in d))fail('ROLLING_INPUT_DATA');
   charge(stringSize(k)+1+(fields++?1:0));out[k]=visit(d.value,depth+1);
  }
  return Object.freeze(out);
 }
 return visit(input,0);
}
export async function prepareRollingPublication(args){
 if(!args||typeof args!=='object')fail('ROLLING_BINDING');
 const io=args.io;
 const {previous,version,completion,changes,initialRefs,latestStores}=rollingDataSnapshot_({
  previous:args.previous??null,version:args.version,completion:args.completion,changes:args.changes,
  initialRefs:args.initialRefs??[],latestStores:args.latestStores});
 if(!io||typeof io.verifyCompletion!=='function'||typeof io.verifyChanges!=='function'||typeof io.verifyRef!=='function')fail('ROLLING_VERIFIER_REQUIRED');
 if(!completion||!validDay(completion.expectedThrough)||completion.completedThrough!==completion.expectedThrough
  ||!Array.isArray(completion.gaps)||completion.gaps.length||await io.verifyCompletion(completion)!==true)fail('COLLECTION_INCOMPLETE');
 if(!changes||changes.complete!==true||changes.previousVersion!==(previous?.version??null)
  ||changes.fromSequence!==(previous?.sequence??null)||typeof changes.throughSequence!=='string'
  ||!Array.isArray(changes.refs)||changes.refs.length>5000||await io.verifyChanges(changes,completion)!==true)fail('CHANGE_COVERAGE_UNCONFIRMED');
 if(typeof version!=='string'||!revisionToken(version)||version===previous?.version||!revisionToken(changes.basis)||!revisionToken(changes.throughSequence)
  ||!Array.isArray(initialRefs)||initialRefs.length>5000||previous&&(previous.basis!==changes.basis||previous.publication!=='PUBLISHED'||previous.schema!=='hybrid-rolling-publication-v1'||previous.days?.length!==90||completion.completedThrough<previous.completedThrough)
  ||!latestStores||latestStores.scope!=='ALL_LATEST_STORES'||latestStores.verified!==true||!revisionToken(latestStores.id)||!/^[a-f0-9]{64}$/.test(latestStores.hash||'')
  ||Object.keys(latestStores).some(k=>!['scope','verified','id','hash'].includes(k)))fail('ROLLING_BINDING');
 const anchor=completion.completedThrough,window=rollingWindow(anchor),refs=new Map(),changed=new Set();
 for(const ref of previous?.days||initialRefs){if(refs.has(ref.date))fail('DUPLICATE_DAY');refs.set(ref.date,ref);}
 for(const ref of changes.refs){if(changed.has(ref.date))fail('DUPLICATE_DELTA_DATE');changed.add(ref.date);refs.set(ref.date,ref);}
 const historicalUpdates=[];
 for(const ref of changes.refs){checkRollingRef(ref,changes.basis);if(ref.date>anchor)fail('COLLECTION_INCOMPLETE');if(ref.date<window.startDate){if(await io.verifyRef(ref)!==true)fail('DAY_VERIFICATION_FAILED');historicalUpdates.push(Object.freeze({...ref}));}}
 const days=[];
 for(let date=window.startDate;date<=anchor;date=shiftDay(date,1)){
  const ref=refs.get(date);checkRollingRef(ref,changes.basis);if(ref.date!==date)fail('DAY_COVERAGE_UNCONFIRMED');
  if(!previous||changed.has(date)||!previous.days.some(old=>old.date===date&&old.hash===ref.hash&&old.revision===ref.revision)){
   if(await io.verifyRef(ref)!==true)fail('DAY_VERIFICATION_FAILED');
  }
  days.push(Object.freeze({...ref}));
 }
 return Object.freeze({schema:'hybrid-rolling-publication-v1',version,expectedVersion:previous?.version??null,sequence:changes.throughSequence,
  basis:changes.basis,...window,completedThrough:anchor,expectedThrough:completion.expectedThrough,completionVerified:true,gaps:Object.freeze([]),publication:'HELD',coverageComplete:true,
  latestStores:Object.freeze({...latestStores}),days:Object.freeze(days),historicalUpdates:Object.freeze(historicalUpdates),retiredRefs:Object.freeze((previous?.days||[]).filter(r=>r.date<window.startDate)),retiredDates:Object.freeze((previous?.days||[]).filter(r=>r.date<window.startDate).map(r=>r.date)),sourceDeletes:0});
}
const revisionToken=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
export function checkRollingRef(ref,basis){
 if(!ref||!validDay(ref.date)||!revisionToken(ref.id)||!revisionToken(ref.revision)||ref.basis!==basis||ref.kind!=='period'||ref.source!=='Freshon'
  ||ref.complete!==true||ref.verified!==true||!/^[a-f0-9]{64}$/.test(ref.hash||'')||!Number.isSafeInteger(ref.count)||ref.count<0||ref.count>20000
  ||!Number.isSafeInteger(ref.bytes)||ref.bytes<2||ref.bytes>4194304
  ||Object.keys(ref).some(k=>!['date','id','revision','basis','kind','source','complete','verified','hash','count','bytes'].includes(k)))fail('DAY_COVERAGE_UNCONFIRMED');
 return ref;
}
// The injected PRIVATE verifier must still check ownership/readback. This local
// guard additionally prevents a mismatched or incomplete catalog from reaching CAS.
function assertPublicationCatalogBinding(candidate,catalog){
 const catalogFields=['schema','version','basis','completedThrough','expectedThrough','completionVerified','gaps','startDate','endDate','days','publication'];
 if(Object.keys(catalog).some(k=>!catalogFields.includes(k)))fail('PUBLICATION_INDEX_BINDING');
 const names=['startDate','endDate','completedThrough','expectedThrough','completionVerified'];
 if(names.some(k=>candidate[k]!==catalog[k])||candidate.completionVerified!==true
  ||!validDay(candidate.endDate)||candidate.startDate!==shiftDay(candidate.endDate,-89)
  ||candidate.completedThrough!==candidate.endDate||candidate.expectedThrough!==candidate.endDate
  ||!Array.isArray(candidate.gaps)||candidate.gaps.length||!Array.isArray(catalog.gaps)||catalog.gaps.length
  ||!Array.isArray(candidate.days)||candidate.days.length!==90||!Array.isArray(catalog.days)||catalog.days.length>5000)
  fail('PUBLICATION_INDEX_BINDING');
 const actual=new Map();
 for(const ref of catalog.days){checkRollingRef(ref,candidate.basis);if(actual.has(ref.date))fail('PUBLICATION_INDEX_BINDING');actual.set(ref.date,ref);}
 const resident=new Map();
 for(const ref of candidate.days){checkRollingRef(ref,candidate.basis);if(resident.has(ref.date))fail('PUBLICATION_INDEX_BINDING');resident.set(ref.date,ref);}
 for(let date=candidate.startDate;date<=candidate.endDate;date=shiftDay(date,1))if(!resident.has(date))fail('PUBLICATION_INDEX_BINDING');
 const wanted=new Map();
 for(const ref of [...(candidate.retiredRefs||[]),...(candidate.historicalUpdates||[]),...candidate.days]){
  checkRollingRef(ref,candidate.basis);wanted.set(ref.date,ref);
 }
 for(const [date,ref]of wanted){const got=actual.get(date);if(!got||Object.keys(ref).some(k=>ref[k]!==got[k]))fail('PUBLICATION_INDEX_BINDING');}
}
export async function commitRollingPublication(input,io){
 const candidate=rollingDataSnapshot_(input);
 const candidateFields=['schema','version','expectedVersion','sequence','basis','startDate','endDate','completedThrough','expectedThrough','completionVerified','gaps','publication','coverageComplete','latestStores','days','historicalUpdates','retiredRefs','retiredDates','sourceDeletes'];
 if(candidate&&Object.keys(candidate).some(k=>!candidateFields.includes(k)))fail('PUBLICATION_NOT_READY');
 if(!candidate||candidate.schema!=='hybrid-rolling-publication-v1'||candidate.publication!=='HELD'||candidate.coverageComplete!==true
  ||!revisionToken(candidate.version)||!revisionToken(candidate.basis)||!revisionToken(candidate.sequence)
  ||candidate.expectedVersion!==null&&!revisionToken(candidate.expectedVersion)
  ||candidate.version===candidate.expectedVersion||candidate.sourceDeletes!==0
  ||!candidate.latestStores||candidate.latestStores.scope!=='ALL_LATEST_STORES'||candidate.latestStores.verified!==true
  ||!revisionToken(candidate.latestStores.id)||!/^[a-f0-9]{64}$/.test(candidate.latestStores.hash||'')
  ||Object.keys(candidate.latestStores).some(k=>!['scope','verified','id','hash'].includes(k))
  ||!io||typeof io.prepareCatalog!=='function'||typeof io.verifyCandidate!=='function'||typeof io.compareAndSwap!=='function')fail('PUBLICATION_NOT_READY');
 const staged=rollingDataSnapshot_(await io.prepareCatalog(candidate));
 if(!staged||staged.schema!=='hybrid-date-catalog-v1'||staged.version!==candidate.version||staged.basis!==candidate.basis||staged.publication!=='HELD')fail('PUBLICATION_INDEX_NOT_READY');
 assertPublicationCatalogBinding(candidate,staged);
 const catalog=Object.freeze({...staged,publication:'PUBLISHED'});
 const published=Object.freeze({...candidate,publication:'PUBLISHED',dateCatalogHash:createHash('sha256').update(JSON.stringify(catalog)).digest('hex')});
 if(await io.verifyCandidate(published,catalog)!==true)fail('PUBLICATION_VERIFICATION_FAILED');
 // Existing PRIVATE persistence must save/verify the immutable catalog first,
 // then atomically swap ONE root bound to its hash. Keep the prior root alive.
 if(await io.compareAndSwap(candidate.expectedVersion,published,catalog)!==true)fail('MANIFEST_POINTER_CHANGED');
 return published;
}
