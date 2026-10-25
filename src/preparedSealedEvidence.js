/** Read the EXISTING Pilot/SealedV4/RangeEngine artifacts, never live Sheets.
 * This verifies persisted snapshot evidence. It intentionally DOES NOT turn
 * capture/RangeEngine completion into upstream business collection completion.
 * Caller supplies the existing PRIVATE, owner/parent-checked, metered text IO.
 * Only small metadata is read; day bodies, writes and source scans are absent.
 */
import {createHash} from 'node:crypto';
import {validDay, shiftDay} from './hybridMapPlan.js';
const sha = v => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const hashOK = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const token = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const fail = code => { throw Error('PREPARED_EVIDENCE_' + code); };
const authentic = new WeakSet();
function freeze(v) { if(v && typeof v === 'object') {Object.values(v).forEach(freeze);Object.freeze(v);} return v; }
function copy(v) { return JSON.parse(JSON.stringify(v)); }
function fileRef(v, max) {
 if(!v || !token(v.id) || !hashOK(v.hash) || !Number.isSafeInteger(v.bytes) || v.bytes < 2 || v.bytes > max) fail('REF');
 return freeze(copy(v));
}
function assertActive(signal, deadline, now) {
 signal?.throwIfAborted();
 if(!Number.isFinite(deadline) || now() >= deadline) fail('DEADLINE');
}
function unwrap(value) {
 if(value?.schema !== 'CAPTURE_PREFIX_TYPED_V1') return value;
 const v=value.metadata?.value;
 if(value.seq !== 0 || !Array.isArray(value.rows) || value.rows.length || value.metadata?.type !== 'SEALED_INDEX_OBJECT'
  || !v || value.captureId !== 'idx-' + sha(v)) fail('INDEX_WRAPPER');
 return v;
}
function span(start, end) {
 if(!validDay(start)||!validDay(end)||start>end) fail('PERIOD');
 const dates=[]; for(let d=start;d<=end;d=shiftDay(d,1)){if(dates.length===90)fail('PERIOD');dates.push(d);}return dates;
}
function shard(v) {
 // Reused legacy refs can legitimately omit bytes. Metadata comparison does not
 // read them or invent a size. The existing body reader still must check size.
 if(!v||!token(v.id)||!hashOK(v.hash)||!Number.isSafeInteger(v.count)||v.count<1||v.count>8000
  ||v.bytes!==undefined&&(!Number.isSafeInteger(v.bytes)||v.bytes<2||v.bytes>4194304))fail('SHARD');
 return copy(v);
}
export async function readPreparedSealedEvidence({refs,seed,binding,priority,readVerifiedText,signal,deadline,now=Date.now}) {
 if(typeof readVerifiedText!=='function'||typeof now!=='function')fail('IO');
 // Read/checkpoint limits are inherited from the supplied capture/range code.
 const max=196608,pins={seal:fileRef(refs?.seal,max),index:fileRef(refs?.index,max),prepared:fileRef(refs?.prepared,max)};
 if(!seed||!binding||!Array.isArray(priority)||priority.length!==4)fail('BINDING');
 // Own the input before first await; no asynchronous caller mutation changes a pin.
 const own=freeze(copy({seed,binding,priority}));seed=own.seed;binding=own.binding;priority=own.priority;
 let reads=0,bytes=0;
 async function read(ref){
  assertActive(signal,deadline,now);const text=await readVerifiedText(ref,{maxBytes:ref.bytes,signal,deadline});
  reads++;assertActive(signal,deadline,now);
  if(typeof text!=='string'||Buffer.byteLength(text,'utf8')!==ref.bytes||sha(text)!==ref.hash)fail('READBACK');
  bytes+=ref.bytes;let value;try{value=JSON.parse(text);}catch{fail('JSON');}return unwrap(value);
 }
 const seal=await read(pins.seal);
 if(!seal||seal.status!=='SEALED'||seal.publication!=='HELD'||seal.fullCompletion!==true||seal.partialCapture===true||seal.pending
  ||seal.requireVersionVector!==true||!Number.isSafeInteger(seal.sealedAt)||!Number.isSafeInteger(seal.until)||seal.sealedAt>=seal.until
  ||!Array.isArray(seal.sources)||seal.sources.length!==4||!seal.manifest)fail('UNSEALED');
 const dates=span(seal.period?.from,seal.period?.to);
 if(seed.startDate!==dates[0]||seed.endDate!==dates.at(-1)||seed.publication!=='HELD'||seed.phase!=='BUILD')fail('SEED_PERIOD');
 const identities=new Set(),ids=[...new Set(seal.sources.map(s=>s.id))].sort();let pages=0;
 if(ids.length!==2)fail('SOURCES');
 for(const s of seal.sources){
  const key=[s.kind,s.id,s.sheetId].join('|');
  if(!['history','period'].includes(s.kind)||!token(s.id)||!Number.isSafeInteger(s.sheetId)||s.sheetId<0
   ||!Number.isSafeInteger(s.last)||s.last<1||!Number.isSafeInteger(s.width)||s.width<1||s.width>64
   ||!Array.isArray(s.headers)||s.headers.length!==s.width||s.headers.some(h=>typeof h!=='string'||h.length>200)
   ||identities.has(key))fail('SOURCES');identities.add(key);pages+=Math.ceil((s.last-1)/128);
 }
 for(const id of ids)if(seal.sources.filter(s=>s.id===id).map(s=>s.kind).sort().join(',')!=='history,period')fail('SOURCES');
 if(pages>8192||seal.pages!==pages||seal.sourcePagesRequired!==pages)fail('SOURCE_COVERAGE');
 for(const v of [seal.sourceVersions,seal.sourceVersionsAtSeal]){
  if(!v||Object.keys(v).sort().join('|')!==ids.join('|')||ids.some(id=>typeof v[id]!=='string'||!/^\d{1,32}$/.test(v[id])))fail('SOURCE_VERSION');
 }
 if(ids.some(id=>seal.sourceVersions[id]!==seal.sourceVersionsAtSeal[id]))fail('SOURCE_VERSION_CHANGED');
 const index=await read(pins.index);
 if(!index||index.schema!=='SEALED_V4_INDEX'||index.publication!=='HELD'||index.sealHash!==sha(seal)||index.captureId!==seal.id
  ||sha(index.sources)!==sha(seal.sources)||sha(index.period)!==sha(seal.period)||sha(index.manifest)!==sha(seal.manifest)
  ||index.pages!==pages||!Array.isArray(index.blocks))fail('INDEX_BINDING');
 let next=0;for(const b of index.blocks){
  if(b.first!==next||!Number.isSafeInteger(b.last)||b.last<b.first||b.last-b.first>=128)fail('INDEX_COVERAGE');
  fileRef(b.ref,max);next=b.last+1;
 }
 if(next!==pages)fail('INDEX_COVERAGE');
 if(priority.map(s=>s.kind).join(',')!=='history,history,period,period')fail('PRIORITY');
 const mapping=priority.map(s=>index.sources.findIndex(v=>v.kind===s.kind&&v.id===s.id&&v.sheetId===s.sheetId));
 if(mapping.some(i=>i<0)||new Set(mapping).size!==4)fail('PRIORITY');
 const sources=mapping.map(i=>({...index.sources[i],version:'SEALED:'+pins.index.hash+':'+i}));
 if(binding.schema!==2||binding.seed!==sha(seed)||binding.sources!==sha(sources)||!hashOK(binding.codec)
  ||Object.keys(binding).sort().join(',')!=='codec,schema,seed,sources')fail('RANGE_BINDING');
 const state=await read(pins.prepared);
 if(!state||state.schema!==2||state.bindingHash!==sha(binding)||state.originalUntil!==seed.until||state.publication!=='HELD'
  ||state.phase!=='PREPARED_HELD'||state.wholeRangeCompletenessVerified!==true||state.verified!==dates.length*2||state.unitAt!==dates.length*2
  ||state.sourceReads!==pages*2||!hashOK(state.chain)||state.firstChain!==state.chain
  ||!state.shards||Array.isArray(state.shards)||!Array.isArray(state.empty)||typeof state.atomicSnapshotVerified!=='boolean')fail('PREPARATION_INCOMPLETE');
 if(state.manifestHash!==sha({shards:state.shards,empty:state.empty}))fail('PREPARATION_MANIFEST');
 const keys=new Set(dates.flatMap(d=>['history:'+d,'period:'+d]));
 if(Object.keys(state.shards).some(k=>!keys.has(k)))fail('EXTRA_UNIT');
 const empties=new Map();for(const e of state.empty){
  if(!e||!keys.has(e.key)||state.shards[e.key]||empties.has(e.key)||e.hash!==sha([]))fail('EMPTY_PROOF');empties.set(e.key,e);
 }
 for(const k of keys){if(state.shards[k])shard(state.shards[k]);else if(!empties.has(k))fail('UNIT_GAP');}
 for(const [k,v]of Object.entries(seed.shards||{}))if(!state.shards[k]||sha(state.shards[k])!==sha(v))fail('REUSE_CHANGED');
 const days=dates.map(date=>{
  const key='period:'+date,ref=state.shards[key];
  return ref?{date,status:'STORED_ROWS',ref:shard(ref),count:ref.count,hash:ref.hash}:
   {date,status:'OBSERVED_EMPTY',ref:null,count:0,hash:empties.get(key).hash,emptyBasis:empties.get(key).collectionCompleteness??null};
 });
 const result=freeze({schema:'prepared-sealed-evidence-v1',scope:'STORED_SOURCE_SNAPSHOT',pins,sealHash:sha(seal),bindingHash:sha(binding),
  sourceVersions:copy(seal.sourceVersions),startDate:dates[0],endDate:dates.at(-1),days,sourceCoverageVerified:true,
  businessCollectionComplete:false,publicationAllowed:false,currentLiveVersionVerified:false,
  atomicSnapshotVerified:state.atomicSnapshotVerified,allDayBodiesReadBack:false,reads,metadataBytes:bytes});
 authentic.add(result);return result;
}
/** Metadata-only diff within VERIFIED stored coverage, not an upstream change feed.
 * Dates outside new coverage are NOT deletions. Missing days are never zero rows.
 */
export function comparePreparedSnapshots(previous,next){
 if(!authentic.has(previous)||!authentic.has(next))fail('UNVERIFIED_SNAPSHOT');
 const before=new Map(previous.days.map(d=>[d.date,d])),after=new Map(next.days.map(d=>[d.date,d]));
 const changed=[],added=[],unchanged=[],outsideCoverage=[];
 for(const [date,d]of after){const old=before.get(date);
  if(!old)added.push(date);else if(old.hash!==d.hash||old.count!==d.count||old.status!==d.status)
   changed.push({date,change:d.count===0&&old.count>0?'ROWS_REMOVED_TO_OBSERVED_EMPTY':'REPLACED',beforeHash:old.hash,afterHash:d.hash});
  else unchanged.push(date);
 }
 for(const date of before.keys())if(!after.has(date))outsideCoverage.push(date);
 return freeze({schema:'prepared-snapshot-date-diff-v1',previousPreparedHash:previous.pins.prepared.hash,nextPreparedHash:next.pins.prepared.hash,
  changed,added,unchanged,outsideCoverage,sourceScope:'STORED_SNAPSHOTS_ONLY',liveChangeFeedComplete:false,publicationAllowed:false});
}

// Binding to directCustomerDriveIO_'s EXISTING validated JSON reader. Do not
// bypass its actor/owner/parent guards or fetch a second copy of a metadata file.
// Its writer emits canonical JSON. A noncanonical serialized file is rejected,
// not reconstructed as an allegedly byte-identical source.
export async function readExistingPreparedSealedEvidence({configuration,preparedResult,io,signal,deadline,now=Date.now}){
 if(!configuration||configuration.inputMode!=='SEALED'||!configuration.captureFolderId
  ||!configuration.sealedCapture||!Array.isArray(configuration.capturePriority)
  ||preparedResult?.phase!=='PREPARED_HELD'||!preparedResult.head
  ||!io||['seed','sources','read','guard'].some(k=>typeof io[k]!=='function')||!hashOK(io.codecId))fail('EXISTING_BINDING');
 const cfg=freeze(copy(configuration)),head=fileRef(preparedResult.head,196608);
 assertActive(signal,deadline,now);io.guard();
 const seed=io.seed(),sources=io.sources();
 const binding={schema:2,seed:sha(seed),sources:sha(sources),codec:io.codecId};
 const refs={seal:cfg.sealedCapture.sealRef,index:cfg.sealedCapture.pin?.index,prepared:head};
 const evidence=await readPreparedSealedEvidence({refs,seed,binding,priority:cfg.capturePriority,signal,deadline,now,
  readVerifiedText:async(ref,options)=>{
   assertActive(signal,deadline,now);io.guard();
   const capture=ref.id===refs.seal?.id||ref.id===refs.index?.id;
   const value=await io.read(ref,options.maxBytes,options.deadline,capture?cfg.captureFolderId:undefined);
   assertActive(signal,deadline,now);io.guard();const text=JSON.stringify(value);
   if(Buffer.byteLength(text)!==ref.bytes||sha(text)!==ref.hash)fail('EXISTING_TEXT_NOT_EXACT');return text;
  }});
 return evidence;
}
