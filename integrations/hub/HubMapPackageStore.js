/** Independent immutable lookup store. No legacy restore/build or source writes.
 * Read path: fresh property pointer -> one small manifest -> one hashed bucket.
 * Customer/Stage properties, triggers and published pointers are never changed.
 */
const HUB_MAP_PACKAGES=Object.freeze({property:'PRODUCTION_MAP_PACKAGES_V1',detailProperty:'PRODUCTION_MAP_DETAILS_V1',schema:'map-public-package-v1',maxManifest:98304,maxChunk:1572864,maxBucket:524288});
// Owner API-executable entry; metadata only, no HTTP nonce/rate-limit mutation.
// Does not read source/day bodies, acquire locks, schedule or publish anything.
function hubMapReadOnlyPublicationMetadata(scope){
 if(scope!==undefined&&scope!=='PREPARATION')throw Error('READ_METADATA_SCOPE');
 const preparation=scope==='PREPARATION';
 const started=Date.now(),limits={nativeCalls:512,closeCalls:100,propertyGets:preparation?20:4,files:preparation?10:2,metadataBytes:preparation?1966080:196608,triggers:20,wallMs:60000,closeMs:preparation?10000:5000};
 const used={nativeCalls:0,propertyGets:0,files:0,metadataBytes:0},keys=preparation?['PRODUCTION_MAP_PACKAGE_PREPARATION_V1','PRODUCTION_MAP_PRIVATE_SELECTED_CAPTURE_1790624623844_V1','PRODUCTION_MAP_PRIVATE_SELECTED_CAPTURE_HANDOFF_1790624623844_V1','PHASE2B_STAGE_READ_MODEL_V1','PHASE2B_STAGE_RESTORE_V1','PHASE2B_PRODUCTION_RESTORE_V1','PHASE2B_PRODUCTION_INCREMENTAL_V1','PRODUCTION_MAP_PACKAGES_V1','PRODUCTION_MAP_DETAILS_V1','ROLLING_MAP_PUBLICATION_V1']:['PRODUCTION_MAP_PACKAGES_V1','ROLLING_MAP_PUBLICATION_V1'];
 let closing=false,properties,before=[],triggersBefore=[],report={readOnly:true,sourceRows:0,dayRows:0,writes:0,sealed:'UNCONFIRMED_NOT_IN_PUBLIC_READ_CONTRACT'};
 function sdk(fn){if(Date.now()-started>=limits.wallMs-(closing?0:limits.closeMs)||used.nativeCalls>=limits.nativeCalls-(closing?0:limits.closeCalls))throw Error('READ_METADATA_BUDGET');used.nativeCalls++;return fn();}
 function sha(text){return sdk(()=>Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,text,Utilities.Charset.UTF_8)).map(b=>('0'+((b+256)%256).toString(16)).slice(-2)).join('');}
 function bytes(text){const blob=sdk(()=>Utilities.newBlob(text));return sdk(()=>blob.getBytes()).length;}
 function token(v){return typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,200}$/.test(v)?v:null;}
 function ref(v){return v&&typeof v==='object'?{id:token(v.id),hash:typeof v.hash==='string'&&/^[a-f0-9]{64}$/.test(v.hash)?v.hash:null,bytes:Number.isSafeInteger(v.bytes)?v.bytes:null}:null;}
 function get(key){if(++used.propertyGets>limits.propertyGets)throw Error('READ_PROPERTY_BUDGET');return sdk(()=>properties.getProperty(key));}
 function triggers(){const all=sdk(()=>ScriptApp.getProjectTriggers());if(all.length>limits.triggers)throw Error('READ_TRIGGER_BUDGET');return all.map(t=>({handler:token(sdk(()=>t.getHandlerFunction())),id:token(String(sdk(()=>t.getUniqueId())))})).sort((a,b)=>String(a.id).localeCompare(String(b.id)));}
 function metadataFile(r){
  if(!r||!r.id||!r.hash||r.bytes<2||r.bytes>98304||++used.files>limits.files||used.metadataBytes+r.bytes>limits.metadataBytes)throw Error('READ_METADATA_REF');
  const file=sdk(()=>DriveApp.getFileById(r.id));
  if(sdk(()=>file.isTrashed())||sdk(()=>file.getSharingAccess())!==DriveApp.Access.PRIVATE||Number(sdk(()=>file.getSize()))!==r.bytes)throw Error('READ_METADATA_FILE');
  const owner=sdk(()=>file.getOwner()),ownerEmail=sdk(()=>owner.getEmail());
  const actor=sdk(()=>Session.getEffectiveUser()),actorEmail=sdk(()=>actor.getEmail());
  if(ownerEmail!==actorEmail)throw Error('READ_METADATA_OWNER');
  const parents=sdk(()=>file.getParents());if(!sdk(()=>parents.hasNext()))throw Error('READ_METADATA_PARENT');
  const parent=sdk(()=>parents.next()),parentId=sdk(()=>parent.getId());if(sdk(()=>parents.hasNext()))throw Error('READ_METADATA_PARENT');
  const blob=sdk(()=>file.getBlob()),text=sdk(()=>blob.getDataAsString('UTF-8'));used.metadataBytes+=r.bytes;
  if(bytes(text)!==r.bytes||sha(text)!==r.hash)throw Error('READ_METADATA_HASH');
  return {value:JSON.parse(text),location:{parentId:token(parentId),ownerMatchesExecutingUser:true,private:true},ref:r};
 }
 // Existing checkpoint refs only; no search, shard/body traversal or source access.
 const checkpoints={};
 function checkpoint(r){
  if(!r||!r.id||!/^[-\w]{1,200}$/.test(r.id))throw Error('READ_CHECKPOINT_REF');
  if(checkpoints[r.id]){const m=checkpoints[r.id];if(r.hash&&r.hash!==m.ref.hash||r.bytes&&r.bytes!==m.ref.bytes)throw Error('READ_CHECKPOINT_REF_CHANGED');return m;}
  if(used.files>=limits.files)throw Error('READ_METADATA_FILES');
  const f=sdk(()=>DriveApp.getFileById(r.id));
  if(sdk(()=>f.isTrashed())||sdk(()=>f.getSharingAccess())!==DriveApp.Access.PRIVATE)throw Error('READ_CHECKPOINT_PRIVATE');
  const size=Number(sdk(()=>f.getSize()));
  if(!Number.isSafeInteger(size)||size<2||size>196608||r.bytes&&r.bytes!==size||used.metadataBytes+size>limits.metadataBytes)throw Error('READ_CHECKPOINT_SIZE');
  const owner=sdk(()=>f.getOwner()),email=sdk(()=>owner.getEmail()),actor=sdk(()=>Session.getEffectiveUser()),actorEmail=sdk(()=>actor.getEmail());
  if(email!==actorEmail)throw Error('READ_METADATA_OWNER');
  const parents=sdk(()=>f.getParents());if(!sdk(()=>parents.hasNext()))throw Error('READ_METADATA_PARENT');
  const parent=sdk(()=>parents.next()),parentId=sdk(()=>parent.getId());if(sdk(()=>parents.hasNext()))throw Error('READ_METADATA_PARENT');
  used.files++;used.metadataBytes+=size;
  const blob=sdk(()=>f.getBlob()),text=sdk(()=>blob.getDataAsString('UTF-8'));
  if(bytes(text)!==size||Number(sdk(()=>f.getSize()))!==size)throw Error('READ_CHECKPOINT_CHANGED');
  const hash=sha(text);if(r.hash&&hash!==r.hash)throw Error('READ_METADATA_HASH');
  const value=JSON.parse(text);if(!value||typeof value!=='object'||Array.isArray(value))throw Error('READ_CHECKPOINT_OBJECT');
  return checkpoints[r.id]={value:value,ref:{id:r.id,hash:hash,bytes:size},expectedHashMatched:!!r.hash,location:{parentId:token(parentId),ownerMatchesExecutingUser:true,private:true}};
 }
 function count(v){return Array.isArray(v)?v.length:v&&typeof v==='object'?Object.keys(v).length:null;}
 function scalar(v){return Number.isSafeInteger(v)?v:token(v);}
 function coverage(v){return v&&typeof v==='object'?{proof:token(v.proof),verifiedDates:count(v.verifiedDates),unconfirmedDates:count(v.unconfirmedDates),complete:v.complete===true}:null;}
 function receipt(v){return v&&typeof v==='object'?{version:scalar(v.version),rootHash:token(v.rootHash),verified:Number.isSafeInteger(v.verified)?v.verified:null,expected:Number.isSafeInteger(v.expected)?v.expected:null}:null;}
 function summary(m){const v=m.value,out={ref:m.ref,location:m.location,expectedHashMatched:m.expectedHashMatched,phase:token(v.phase),generation:scalar(v.generation),version:scalar(v.version),sourceGeneration:scalar(v.sourceGeneration),startDate:hubMapPackageDateValid_(v.startDate)?v.startDate:null,endDate:hubMapPackageDateValid_(v.endDate)?v.endDate:null,publication:token(v.publication),referenceCounts:{shards:count(v.shards),sources:count(v.sources),prepared:count(v.prepared),parts:count(v.parts),verifiedParts:count(v.verifiedParts)},coverage:coverage(v.coverage||(v.manifest&&v.manifest.coverage)),receipts:{public:receipt(v.receipts&&v.receipts.public),private:receipt(v.receipts&&v.receipts.private)},verification:v.verification?{at:scalar(v.verification.at),total:scalar(v.verification.total)}:null};
  ['candidate','privateCandidate','manifest','base','index','aggregate'].forEach(k=>{const r=ref(v[k]);if(r&&r.id)out[k]=r;});
  ['sourceAt','historyRows','periodRows','capturedCount','verifiedCount','prefixAt'].forEach(k=>{out[k]=Number.isSafeInteger(v[k])?v[k]:null;});
  out.sourceVersions=Array.isArray(v.epochs)?v.epochs.slice(0,4).map(e=>({id:token(e.id),version:scalar(e.revision)})):null;
  out.lastError=typeof v.lastError==='string'&&/^[A-Z][A-Z0-9_]{1,100}$/.test(v.lastError)?v.lastError:null;
  out.sourceCompletenessVerified=false;return out;
 }
 function preparationMetadata(key,raw){
  const out={key:key,present:raw!==null,status:'NOT_READY',role:key.indexOf('PHASE2B_')===0?'LEGACY_PREPARATION_NOT_ROLLING_ROOT':'PREPARATION_METADATA'};
  if(raw===null)return out;
  try{
   if(typeof raw!=='string'||raw.length>8192)throw Error('READ_POINTER_SIZE');out.pointerHash=sha(raw);
   const legacyId=/^[-\w]{1,200}$/.test(raw)&&key.indexOf('PHASE2B_')===0;
   let p;if(legacyId)p={id:raw};else p=JSON.parse(raw);
   let r=ref(p),v=p;if(key==='PRODUCTION_MAP_PACKAGES_V1'||key==='PRODUCTION_MAP_DETAILS_V1')r=ref(p.current);
   if(key==='ROLLING_MAP_PUBLICATION_V1')r=ref(p.catalog);
   if(key==='PRODUCTION_MAP_PRIVATE_SELECTED_CAPTURE_HANDOFF_1790624623844_V1')r=ref(p.job);
   if(!r||!r.id){out.status='PRESENT_UNVERIFIED';out.reason='NO_SUPPORTED_CHECKPOINT_REF';return out;}
   if(!legacyId&&(!r.hash||!Number.isSafeInteger(r.bytes)||r.bytes<2))throw Error('READ_CHECKPOINT_REF');
   const m=checkpoint(r);v=m.value;Object.assign(out,summary(m));out.status='PRESENT_UNVERIFIED';
   if(key==='PRODUCTION_MAP_PACKAGE_PREPARATION_V1'){
    const refs=[ref(v.candidate),ref(v.privateCandidate)],rs=[v.receipts&&v.receipts.public,v.receipts&&v.receipts.private];
    out.publisherReceiptContract=!!v.verification&&v.verification.at===v.verification.total&&['VERIFIED','PUBLISHED'].indexOf(v.phase)>=0&&refs.every((q,i)=>q&&q.id&&rs[i]&&rs[i].version===v.version&&rs[i].rootHash===q.hash&&Number.isSafeInteger(rs[i].expected)&&rs[i].expected>0&&rs[i].verified===rs[i].expected);
    if(out.publisherReceiptContract){out.candidateMetadata=refs.map(q=>summary(checkpoint(q)));if(out.candidateMetadata.some(q=>!q.expectedHashMatched||q.version!==v.version))throw Error('READ_ROOT_VERSION');out.status='VERIFIED';out.verificationScope='CHECKPOINT_AND_TWO_ROOT_HASH_RECEIPTS_ONLY_NOT_FULL_COVERAGE';}
   }
   if(v.phase==='SEALED'&&ref(v.manifest)&&ref(v.manifest).id){out.sealedManifest=summary(checkpoint(ref(v.manifest)));out.sealedMetadataHashVerified=out.sealedManifest.expectedHashMatched;out.sealedFullInputVerified=false;}
   out.preparationComplete=['VERIFIED','PUBLISHED','SEALED'].indexOf(v.phase)>=0;
  }catch(e){out.status='READ_FAILED';out.error=/^[A-Z][A-Z0-9_]{1,100}$/.test(String(e.message||''))?String(e.message):'READ_METADATA_FAILED';}
  return out;
 }
 try{
  properties=sdk(()=>PropertiesService.getScriptProperties());triggersBefore=triggers();before=keys.map(get);report.pointerPresence=before.map((v,i)=>({key:keys[i],present:v!==null}));
  if(preparation){report.scope='PREPARATION';report.candidates=keys.map((key,i)=>preparationMetadata(key,before[i]));report.sealed='SEE_CANDIDATES_NOT_FULL_INPUT_VERIFICATION';}
  else report.roots=keys.map((key,i)=>{const raw=before[i];if(raw===null)return {key,present:false,status:'NOT_READY'};
   if(typeof raw!=='string'||raw.length>8192)throw Error('READ_POINTER_SIZE');
   let p;try{p=JSON.parse(raw);}catch(e){return {key,present:true,status:'INVALID_JSON',rawHash:sha(raw)};}
   const out={key,present:true,rawHash:sha(raw),version:typeof p.version==='string'?token(p.version):Number.isSafeInteger(p.version)?p.version:null};
   if(i===0){if(p.schema!==1||!p.current||!Number.isSafeInteger(p.current.version))return {...out,status:'INVALID_POINTER'};
    out.version=p.current.version;const m=metadataFile(ref(p.current));if(m.value.schema!==1||m.value.version!==out.version||!m.value.manifest)throw Error('READ_PACKAGE_MANIFEST');
    const manifest=m.value.manifest;hubMapPackageCheckManifest_(manifest);
    out.status='MANIFEST_VERIFIED';out.ref=m.ref;out.location=m.location;out.startDate=manifest.startDate;out.endDate=manifest.endDate;out.coverage=manifest.coverage;out.sourceGeneration=manifest.sourceGeneration;out.customerCompletedThrough=hubMapPackageDateValid_(manifest.customerCompletedThrough)?manifest.customerCompletedThrough:null;out.sourceEvidencePresent=!!manifest.dependencies.publicSource;out.sourceEvidenceHash=manifest.dependencies.publicSource?sha(manifest.dependencies.publicSource):null;out.chunkCount=manifest.chunks.length;
   }else{out.publication=token(p.publication);if(p.publication!=='PUBLISHED'||!p.version||!p.catalog)return {...out,status:'NOT_PUBLISHED'};
    const m=metadataFile(ref(p.catalog)),c=m.value;if(c.schema!=='hybrid-date-catalog-v1'||c.version!==p.version||!Array.isArray(c.days)||c.days.length>5000)throw Error('READ_CATALOG_CONTRACT');
    out.status='CATALOG_HASH_VERIFIED';out.ref=m.ref;out.location=m.location;out.basis=token(c.basis);['startDate','endDate','completedThrough','expectedThrough'].forEach(k=>{out[k]=hubMapPackageDateValid_(c[k])?c[k]:null;});out.completionVerified=c.completionVerified===true;out.gapCount=Array.isArray(c.gaps)?c.gaps.length:null;
    const d=c.days.find(d=>d.date==='2026-10-22');out.selectedDate=d?{date:d.date,ref:ref(d),count:Number.isSafeInteger(d.count)?d.count:null,revision:token(d.revision),basis:token(d.basis),verified:d.verified===true,complete:d.complete===true}:null;
   }return out;
  });
 }catch(e){report.error=/^[A-Z][A-Z0-9_]{1,100}$/.test(String(e.message||''))?String(e.message):'READ_METADATA_FAILED';}
 finally{closing=true;try{if(properties&&before.length===keys.length){const after=keys.map(get);report.pointersUnchanged=after.every((v,i)=>v===before[i]);}else report.pointersUnchanged=null;report.triggersAfter=triggers();report.triggersBefore=triggersBefore;report.triggersUnchanged=JSON.stringify(report.triggersAfter)===JSON.stringify(triggersBefore);}catch(e){report.closeError='READ_METADATA_CLOSE_UNCONFIRMED';}report.triggerVisibility='CURRENT_EXECUTING_USER_ONLY';report.otherOwnersConfirmed=false;report.used=used;report.limits=limits;report.elapsedMs=Date.now()-started;}
 return report;
}
function hubMapPackageFail_(code){throw new Error(code);}
// Kept byte-for-byte semantically aligned with the browser contract by tests.
// Business identifiers remain strings; fixed-master validation is separate.
function hubMapPackageActualVehicleType_(value){
 if(typeof value!=='string'||value.length>24)return 'INVALID';
 if(value==='')return 'EMPTY';
 // Confirmed initial-store labels, distinct from fixed-master assignment.
 if(/^(?:이천신규|오산신규|영남신규)$/.test(value))return 'INITIAL_STORE';
 if(/^\d{1,3}(?:호|호차)?$/.test(value))return 'NUMERIC';
 if(/^(?:용|용차)[-_]?\d{1,3}(?:[-_]\d{1,2})?(?:호|호차)?$/.test(value))return 'RENTAL';
 if(/^척[-_]?\d{1,3}(?:[-_]\d{1,2})?(?:호|호차)?$/.test(value))return 'VARIABLE_CHARTER';
 if(/^(?:임|임시|대차)[-_]?\d{1,3}(?:[-_]\d{1,2})?(?:호|호차)?$/.test(value))return 'TEMPORARY';
 if(/^\d{1,3}[-_]\d{1,2}(?:호|호차)?$/.test(value))return 'SUB_VEHICLE';
 if(/^(?:-|미지정|미배정|미할당|없음|N\/A)$/.test(value))return 'UNASSIGNED';
 if(/^(?:용차|택배|직송|직배|자차|자가|기타)$/.test(value))return 'TRANSPORT_LABEL';
 return 'INVALID';
}
function hubMapPackageActualVehicleValid_(value){return hubMapPackageActualVehicleType_(value)!=='INVALID';}
function hubMapPackageSafeError_(error){
  const code=error&&error.message;
  const codes={PACKAGE_NOT_READY:503,PACKAGE_VERSION_UNAVAILABLE:409,PACKAGE_RANGE_NOT_READY:409,PACKAGE_REQUEST:400,PACKAGE_CUSTOMER_CODE:400,PACKAGE_HISTORICAL_SELECTION_REQUIRED:400,
    PACKAGE_FILE_CONTRACT:502,PACKAGE_HASH:502,PACKAGE_JSON:502,PACKAGE_POINTER:502,PACKAGE_MANIFEST:502,PACKAGE_DEPENDENCIES:502,PACKAGE_COVERAGE:502,PACKAGE_CHUNKS:502,PACKAGE_COUNTS:502,
    PACKAGE_CHUNK_NOT_FOUND:404,PACKAGE_COUNT:502,PACKAGE_PUBLIC_CONTRACT:502,PACKAGE_HISTORY_CONTRACT:502,PACKAGE_HISTORY_DUPLICATE:502,PACKAGE_DETAIL_CONTRACT:502,PACKAGE_DETAIL_STATE_VALUES:502,
    PACKAGE_DRIVER_CONTRACT:502,PACKAGE_DRIVER_DUPLICATE:502,PACKAGE_DRIVER_COUNT:502};
  if(typeof code!=='string'||!Object.prototype.hasOwnProperty.call(codes,code))return null;
  return{code:code,message:code,httpStatus:codes[code],retryable:false};
}
function hubMapPackageHashText_(text){return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,text,Utilities.Charset.UTF_8).map(function(n){return('0'+(n&255).toString(16)).slice(-2);}).join('');}
function hubMapPackageUtf8Size_(text){return Utilities.newBlob(text,'application/json').getBytes().length;}
function hubMapPackageBucket_(code){if(!/^[A-Z]\d+$/.test(code||''))hubMapPackageFail_('PACKAGE_CUSTOMER_CODE');return hubMapPackageHashText_(code).slice(0,2);}
function hubMapPackageDateValid_(date){return typeof date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&Number.isFinite(Date.parse(date))&&new Date(date).toISOString().slice(0,10)===date;}
function hubMapPackageCoverage_(coverage,start,end){
  if(!coverage||Object.keys(coverage).some(function(k){return ['verifiedDates','unconfirmedDates','proof'].indexOf(k)<0;})||!Array.isArray(coverage.verifiedDates)||!Array.isArray(coverage.unconfirmedDates)||typeof coverage.proof!=='string'||!/^[A-Z_]{1,128}$/.test(coverage.proof))hubMapPackageFail_('PACKAGE_COVERAGE');
  const seen={};coverage.verifiedDates.concat(coverage.unconfirmedDates).forEach(function(date){if(!hubMapPackageDateValid_(date)||date<start||date>end||seen[date])hubMapPackageFail_('PACKAGE_COVERAGE');seen[date]=true;});
  if(Object.keys(seen).length!==(Date.parse(end)-Date.parse(start))/86400000+1)hubMapPackageFail_('PACKAGE_COVERAGE');
  return coverage;
}
function hubMapPackageCheckHistory_(rows,code,start,end){
  const fields=['deliveryDate','customerCode','deliveryId','vehicle','driverName','driverPhone','kind','sourceVersion','updatedAt'],seen={};
  if(!Array.isArray(rows)||rows.length>3000)hubMapPackageFail_('PACKAGE_HISTORY_CONTRACT');
  rows.forEach(function(row){
    if(!row||row.customerCode!==code||Object.keys(row).some(function(k){return fields.indexOf(k)<0;})||fields.some(function(k){return typeof row[k]!=='string'||row[k].length>300;})
      ||!hubMapPackageDateValid_(row.deliveryDate)||row.deliveryDate<start||row.deliveryDate>end||!row.deliveryId||!row.sourceVersion||!hubMapPackageActualVehicleValid_(row.vehicle)||['ASSIGNED','COMPLETED'].indexOf(row.kind)<0)hubMapPackageFail_('PACKAGE_HISTORY_CONTRACT');
    const key=JSON.stringify([row.deliveryDate,row.deliveryId]);if(seen[key])hubMapPackageFail_('PACKAGE_HISTORY_DUPLICATE');seen[key]=true;
  });
}
function hubMapPackageCheckDetails_(rows,code){
  const fields=['customerCode','accessInfo','password','specialRemark','deliveryPattern','sourceRecordDate','sourceVersion','sourceObservedAt','sourceModifiedAt','publishedAt','state'];
  if(!Array.isArray(rows)||rows.length>100)hubMapPackageFail_('PACKAGE_DETAIL_CONTRACT');
  let previous=null;
  rows.forEach(function(row){
    if(!row||row.customerCode!==code||Object.keys(row).some(function(k){return fields.indexOf(k)<0;})||fields.some(function(k){return !Object.prototype.hasOwnProperty.call(row,k);})
      ||['accessInfo','password','specialRemark','deliveryPattern'].some(function(k){return row[k]!==null&&(typeof row[k]!=='string'||row[k].length>2000);})
      ||!hubMapPackageDateValid_(row.sourceRecordDate)||previous&&row.sourceRecordDate>=previous||typeof row.sourceVersion!=='string'||!row.sourceVersion||row.sourceVersion.length>300
      ||['sourceObservedAt','publishedAt'].some(function(k){return typeof row[k]!=='string'||!Number.isFinite(Date.parse(row[k]));})
      ||row.sourceModifiedAt!==null&&(typeof row.sourceModifiedAt!=='string'||!Number.isFinite(Date.parse(row.sourceModifiedAt)))||['READY','DELETED','UNCONFIRMED','CONFLICT'].indexOf(row.state)<0)hubMapPackageFail_('PACKAGE_DETAIL_CONTRACT');
    if(row.state!=='READY'&&['accessInfo','password','specialRemark','deliveryPattern'].some(function(k){return row[k]!==null;}))hubMapPackageFail_('PACKAGE_DETAIL_STATE_VALUES');
    previous=row.sourceRecordDate;
  });
}
function hubMapPackageReadFile_(entry,maxBytes){
  if(!entry||typeof entry.id!=='string'||!/^[-\w]+$/.test(entry.id)||!Number.isSafeInteger(entry.bytes)||entry.bytes<2||entry.bytes>maxBytes||!/^[a-f0-9]{64}$/.test(entry.hash))hubMapPackageFail_('PACKAGE_FILE_CONTRACT');
  // Fail closed on sharing/size/hash; no file search, TextFinder or fallback scan.
  const file=DriveApp.getFileById(entry.id);
  if(file.getSharingAccess()!==DriveApp.Access.PRIVATE||Number(file.getSize())!==entry.bytes)hubMapPackageFail_('PACKAGE_FILE_CONTRACT');
  const text=file.getBlob().getDataAsString('UTF-8');
  if(hubMapPackageUtf8Size_(text)!==entry.bytes||hubMapPackageHashText_(text)!==entry.hash)hubMapPackageFail_('PACKAGE_HASH');
  let value;try{value=JSON.parse(text);}catch(ignored){hubMapPackageFail_('PACKAGE_JSON');}
  return value;
}
function hubMapPackagePointer_(detail){
  // Never CacheService: an old browser may reuse immutable chunks, not this pointer.
  const text=PropertiesService.getScriptProperties().getProperty(detail?HUB_MAP_PACKAGES.detailProperty:HUB_MAP_PACKAGES.property);
  if(!text)hubMapPackageFail_('PACKAGE_NOT_READY');
  let p;try{p=JSON.parse(text);}catch(ignored){hubMapPackageFail_('PACKAGE_POINTER');}
  if(p.schema!==1||!p.current||!Number.isSafeInteger(p.current.version)||p.current.version<1||p.previous&&p.previous.version>=p.current.version)hubMapPackageFail_('PACKAGE_POINTER');
  return p;
}
function hubMapPackageRoot_(version,detail){
  const p=hubMapPackagePointer_(detail),entry=version===undefined||version===null?p.current:[p.current,p.previous].find(function(e){return e&&e.version===version;});
  if(!entry)hubMapPackageFail_('PACKAGE_VERSION_UNAVAILABLE');
  const root=hubMapPackageReadFile_(entry,HUB_MAP_PACKAGES.maxManifest);
  if(root.version!==entry.version||root.schema!==1||!root.manifest||root.manifest.version!==entry.version)hubMapPackageFail_('PACKAGE_MANIFEST');
  if(entry.publishedAt!==undefined){
    if(typeof entry.publishedAt!=='string'||!Number.isFinite(Date.parse(entry.publishedAt)))hubMapPackageFail_('PACKAGE_POINTER');
    root.manifest.publishedAt=entry.publishedAt;root.publicationAt=entry.publishedAt;
  }
  return root;
}
function hubMapPackageManifest_(params){
  hubMapHttpValidateOnlyKeys_(params,[]);
  const root=hubMapPackageRoot_();
  hubMapPackageCheckManifest_(root.manifest);
  return{data:root.manifest,cached:false,meta:{checkedAt:new Date().toISOString(),store:'PRIVATE_IMMUTABLE_DRIVE',restoreRequired:false}};
}
function hubMapPackageCheckManifest_(m){
  const fields=['schema','version','sourceGeneration','startDate','endDate','sourceObservedAt','publishedAt','customerCompletedThrough','coverage','dependencies','chunks','customerCount','visitCount'];
  if(!m||Object.keys(m).some(function(k){return fields.indexOf(k)<0;})||m.schema!==HUB_MAP_PACKAGES.schema||!Number.isSafeInteger(m.version)||!Number.isSafeInteger(m.sourceGeneration)
    ||!/^\d{4}-\d{2}-\d{2}$/.test(m.startDate||'')||!/^\d{4}-\d{2}-\d{2}$/.test(m.endDate||'')||!Number.isFinite(Date.parse(m.sourceObservedAt))||!Number.isFinite(Date.parse(m.publishedAt)))hubMapPackageFail_('PACKAGE_MANIFEST');
  const span=(Date.parse(m.endDate)-Date.parse(m.startDate))/86400000;
  if(span<0||span>89||!Array.isArray(m.chunks)||!m.chunks.length||m.chunks.length>32)hubMapPackageFail_('PACKAGE_MANIFEST');
  if(!m.dependencies||Object.keys(m.dependencies).some(function(k){return ['baseVehicle','coordinates','publicSource'].indexOf(k)<0;})||Object.keys(m.dependencies).some(function(k){return m.dependencies[k]!==null&&(typeof m.dependencies[k]!=='string'||m.dependencies[k].length>128);}))hubMapPackageFail_('PACKAGE_DEPENDENCIES');
  const c=m.coverage;if(!c||Object.keys(c).some(function(k){return ['verifiedDates','unconfirmedDates','proof'].indexOf(k)<0;})||!Array.isArray(c.verifiedDates)||!Array.isArray(c.unconfirmedDates)||typeof c.proof!=='string'||!/^[A-Z_]+$/.test(c.proof))hubMapPackageFail_('PACKAGE_COVERAGE');
  const dates=c.verifiedDates.concat(c.unconfirmedDates),seen={};
  dates.forEach(function(d){if(!/^\d{4}-\d{2}-\d{2}$/.test(d)||d<m.startDate||d>m.endDate||seen[d])hubMapPackageFail_('PACKAGE_COVERAGE');seen[d]=true;});if(dates.length!==span+1)hubMapPackageFail_('PACKAGE_COVERAGE');
  let customers=0,visits=0;const keys={};m.chunks.forEach(function(e){
    if(Object.keys(e).some(function(k){return ['key','hash','bytes','count','visits'].indexOf(k)<0;})||!/^public-\d{1,3}$/.test(e.key)||keys[e.key]||!/^[a-f0-9]{64}$/.test(e.hash)||!Number.isSafeInteger(e.bytes)||e.bytes<2||e.bytes>HUB_MAP_PACKAGES.maxChunk||!Number.isSafeInteger(e.count)||e.count<0||!Number.isSafeInteger(e.visits)||e.visits<0)hubMapPackageFail_('PACKAGE_CHUNKS');
    keys[e.key]=true;customers+=e.count;visits+=e.visits;
  });if(customers!==m.customerCount||visits!==m.visitCount||customers>15000)hubMapPackageFail_('PACKAGE_COUNTS');
}
function hubMapPackageChunk_(params){
  hubMapHttpValidateOnlyKeys_(params,['version','key']);
  if(!Number.isSafeInteger(params.version)||!/^public-\d{1,3}$/.test(params.key||''))hubMapPackageFail_('PACKAGE_REQUEST');
  const root=hubMapPackageRoot_(params.version),entry=root.public&&root.public[params.key];
  if(!entry)hubMapPackageFail_('PACKAGE_CHUNK_NOT_FOUND');
  const rows=hubMapPackageReadFile_(entry,HUB_MAP_PACKAGES.maxChunk);
  if(!Array.isArray(rows)||rows.length!==entry.count)hubMapPackageFail_('PACKAGE_COUNT');
  hubMapPackageCheckPublic_(rows,root.manifest,entry);
  return{data:rows,cached:false,meta:{version:root.version,key:params.key,hash:entry.hash,bytes:entry.bytes,count:entry.count,visits:entry.visits,manifestRange:{startDate:root.manifest.startDate,endDate:root.manifest.endDate}}};
}
function hubMapPackageCheckPublic_(rows,m,entry){
  const seen={},dayMax=(Date.parse(m.endDate)-Date.parse(m.startDate))/86400000;let visits=0;
  const plain=function(v,max){return typeof v==='string'&&v.length<=max&&!/[\r\n\x00-\x1f]|비밀번호|출입비번|도어락|(?:01[016789])[- ]?\d{3,4}[- ]?\d{4}/.test(v);};
  if(dayMax<0||dayMax>89||!Array.isArray(rows)||rows.length!==entry.count)hubMapPackageFail_('PACKAGE_PUBLIC_CONTRACT');
  rows.forEach(function(r){
    if(!Array.isArray(r)||r.length!==10||!/^[A-Z]\d+$/.test(r[0]||'')||seen[r[0]]||!plain(r[1],200)||!plain(r[2],250)
      ||!(r[3]===null&&r[4]===null||Number.isFinite(r[3])&&r[3]>=33&&r[3]<=39.5&&Number.isFinite(r[4])&&r[4]>=124&&r[4]<=132)
      ||!plain(r[5],80)||!/^\d{0,3}$/.test(r[6])||!Array.isArray(r[7])||r[7].length!==7||r[7].some(function(v){return !/^\d{0,3}$/.test(v);})
      ||r[8]!==null&&!Number.isFinite(Date.parse(r[8]))||!Array.isArray(r[9])||r[9].length>2000)hubMapPackageFail_('PACKAGE_PUBLIC_CONTRACT');
    seen[r[0]]=true;const keys={};r[9].forEach(function(v){
      if(!Array.isArray(v)||v.length!==3||!Number.isInteger(v[0])||v[0]<0||v[0]>dayMax||!hubMapPackageActualVehicleValid_(v[1])||!Number.isInteger(v[2])||v[2]<1||v[2]>100||keys[v[0]+'|'+v[1]])hubMapPackageFail_('PACKAGE_PUBLIC_CONTRACT');
      keys[v[0]+'|'+v[1]]=true;visits+=v[2];
    });
  });if(visits!==entry.visits)hubMapPackageFail_('PACKAGE_COUNT');
}
function hubMapPackageHistory_(params){
  hubMapHttpValidateOnlyKeys_(params,['customerCode','startDate','endDate','version']);
  const code=hubMapHttpCustomerCode_(params.customerCode),start=hubMapHttpDate_(params.startDate,'startDate'),end=hubMapHttpDate_(params.endDate,'endDate'),root=hubMapPackageRoot_(params.version);
  if(start>end||(Date.parse(end)-Date.parse(start))/86400000>89||start<root.manifest.startDate||end>root.manifest.endDate)hubMapPackageFail_('PACKAGE_RANGE_NOT_READY');
  const entry=root.history&&root.history[hubMapPackageBucket_(code)];
  const bucket=entry?hubMapPackageReadFile_(entry,HUB_MAP_PACKAGES.maxBucket):null;
  const found=bucket&&Object.prototype.hasOwnProperty.call(bucket,code)?bucket[code]:[];
  hubMapPackageCheckHistory_(found,code,root.manifest.startDate,root.manifest.endDate);
  // Freshon completeness must never certify Delivery history completeness.
  const coverage=hubMapPackageCoverage_(root.historyCoverage,root.manifest.startDate,root.manifest.endDate);
  return{data:found.filter(function(r){return r.deliveryDate>=start&&r.deliveryDate<=end;}),cached:false,meta:{version:root.version,startDate:start,endDate:end,coverage:coverage,filesRead:entry?2:1,restoreRequired:false}};
}
function hubMapPackageDriverIndex_(root){
  const list=hubMapPackageReadFile_(root.driverIndex,131072),seen={};
  if(!Array.isArray(list)||list.length!==root.driverIndex.count||list.length>1000)hubMapPackageFail_('PACKAGE_DRIVER_CONTRACT');
  list.forEach(function(row){if(!row||Object.keys(row).some(function(k){return ['driverKey','driverName','rows'].indexOf(k)<0;})||typeof row.driverKey!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(row.driverKey)||seen[row.driverKey]||typeof row.driverName!=='string'||!row.driverName||row.driverName.length>100||!Number.isSafeInteger(row.rows)||row.rows<1)hubMapPackageFail_('PACKAGE_DRIVER_CONTRACT');seen[row.driverKey]=true;});return list;
}
function hubMapPackageCheckDriverRows_(rows,start,end){
  if(!Array.isArray(rows)||rows.length>10000)hubMapPackageFail_('PACKAGE_DRIVER_CONTRACT');const seen={};
  rows.forEach(function(row){if(!Array.isArray(row)||row.length!==3||!hubMapPackageDateValid_(row[0])||row[0]<start||row[0]>end||typeof row[1]!=='string'||!/^[A-Z]\d+$/.test(row[1])||!hubMapPackageActualVehicleValid_(row[2]))hubMapPackageFail_('PACKAGE_DRIVER_CONTRACT');const key=JSON.stringify(row);if(seen[key])hubMapPackageFail_('PACKAGE_DRIVER_DUPLICATE');seen[key]=true;});
}
function hubMapPackageDriverList_(params){
  hubMapHttpValidateOnlyKeys_(params,['version']);const root=hubMapPackageRoot_(params.version),list=hubMapPackageDriverIndex_(root);
  return{data:list,cached:false,meta:{version:root.version,startDate:root.manifest.startDate,endDate:root.manifest.endDate,filesRead:2,restoreRequired:false}};
}
function hubMapPackageDriverFilter_(params){
  hubMapHttpValidateOnlyKeys_(params,['version','driverKey','startDate','endDate']);
  if(typeof params.driverKey!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(params.driverKey))hubMapPackageFail_('PACKAGE_REQUEST');
  const root=hubMapPackageRoot_(params.version),start=hubMapHttpDate_(params.startDate,'startDate'),end=hubMapHttpDate_(params.endDate,'endDate');
  if(start>end||start<root.manifest.startDate||end>root.manifest.endDate||(Date.parse(end)-Date.parse(start))/86400000>89)hubMapPackageFail_('PACKAGE_RANGE_NOT_READY');
  const prefix=hubMapPackageHashText_(params.driverKey).slice(0,2),entry=root.drivers&&root.drivers[prefix],bucket=entry?hubMapPackageReadFile_(entry,HUB_MAP_PACKAGES.maxBucket):null;
  const rows=bucket&&Object.prototype.hasOwnProperty.call(bucket,params.driverKey)?bucket[params.driverKey]:[];hubMapPackageCheckDriverRows_(rows,root.manifest.startDate,root.manifest.endDate);
  return{data:rows.filter(function(row){return row[0]>=start&&row[0]<=end;}),cached:false,meta:{version:root.version,driverKey:params.driverKey,startDate:start,endDate:end,filesRead:entry?2:1,restoreRequired:false}};
}
function hubMapPackageDetail_(params){
  hubMapHttpValidateOnlyKeys_(params,['customerCode','date','allowHistorical']);
  const code=hubMapHttpCustomerCode_(params.customerCode),date=params.date?hubMapHttpDate_(params.date,'date'):null,root=hubMapPackageRoot_(null,true);
  const entry=root.details&&root.details[hubMapPackageBucket_(code)],bucket=entry?hubMapPackageReadFile_(entry,HUB_MAP_PACKAGES.maxBucket):null;
  const records=bucket&&Object.prototype.hasOwnProperty.call(bucket,code)?bucket[code]:[];
  hubMapPackageCheckDetails_(records,code);
  const row=date?records.find(function(r){return r.sourceRecordDate===date;}):records[0];
  if(!row)return{data:null,cached:false,meta:{state:'NOT_FOUND',version:root.version,filesRead:entry?2:1}};
  // Unconfirmed/latest-pending values are NOT silently shown as current passwords.
  const markers=root.sourceMarkers;
  let sourceUnchanged=false;
  if(Array.isArray(markers)&&markers.length>0&&markers.length<=2){
    try{sourceUnchanged=markers.every(function(m){return m&&(m.id===HUB_DEFAULT_SOURCE_ID||m.id===HUB_STAFF_DETAIL_ARCHIVE)&&Number.isSafeInteger(m.modifiedAt)&&DriveApp.getFileById(m.id).getLastUpdated().getTime()===m.modifiedAt;});}catch(ignored){sourceUnchanged=false;}
  }
  const current=root.currentness==='VERIFIED_STORED_SOURCE'&&['READY','DELETED'].indexOf(row.state)>=0&&sourceUnchanged;
  if(!date&&!current)return{data:null,cached:false,meta:{state:'CURRENTNESS_UNCONFIRMED',version:root.version,sourceRecordDate:row.sourceRecordDate,sourceObservedAt:row.sourceObservedAt,filesRead:entry?2:1}};
  if(date&&params.allowHistorical!==true)hubMapPackageFail_('PACKAGE_HISTORICAL_SELECTION_REQUIRED');
  return{data:root.publicationAt?Object.assign({},row,{publishedAt:root.publicationAt}):row,cached:false,meta:{state:date?'HISTORICAL':'READY',version:root.version,filesRead:entry?2:1,currentness:root.currentness,sourceLimit:'CUSTOMER_STORED_DATA_NOT_REALTIME_UPSTREAM'}};
}
function hubMapPackageCreateFile_(folder,name,value,maxBytes){
  if(folder.getSharingAccess()!==DriveApp.Access.PRIVATE)hubMapPackageFail_('PACKAGE_STORAGE_NOT_PRIVATE');
  const text=JSON.stringify(value),bytes=hubMapPackageUtf8Size_(text);if(bytes>maxBytes)hubMapPackageFail_('PACKAGE_FILE_TOO_LARGE');
  const file=folder.createFile(name,text,MimeType.PLAIN_TEXT),entry={id:file.getId(),bytes:bytes,hash:hubMapPackageHashText_(text)};
  hubMapPackageReadFile_(entry,maxBytes);return entry;
}
function hubMapPackageVerify_(candidate,detail){
  const root=hubMapPackageReadFile_(candidate,HUB_MAP_PACKAGES.maxManifest);let verified=0,expected=0,historyRows=0;
  if(root.schema!==1||!Number.isSafeInteger(root.version)||root.version<1||!root.manifest||root.manifest.version!==root.version)hubMapPackageFail_('PACKAGE_MANIFEST');
  if(!detail){
    hubMapPackageCheckManifest_(root.manifest);hubMapPackageCoverage_(root.historyCoverage,root.manifest.startDate,root.manifest.endDate);const customers={};
    root.manifest.chunks.forEach(function(e){
      const entry=root.public&&root.public[e.key];if(!entry||entry.hash!==e.hash||entry.bytes!==e.bytes||entry.count!==e.count||entry.visits!==e.visits)hubMapPackageFail_('PACKAGE_MANIFEST');
      expected++;const rows=hubMapPackageReadFile_(entry,HUB_MAP_PACKAGES.maxChunk);hubMapPackageCheckPublic_(rows,root.manifest,entry);
      rows.forEach(function(row){if(customers[row[0]])hubMapPackageFail_('PACKAGE_DUPLICATE_CUSTOMER');customers[row[0]]=true;});verified++;
    });
  }
  const buckets=detail?root.details:root.history;
  if(!buckets||Object.keys(buckets).length>256)hubMapPackageFail_('PACKAGE_BUCKET_INDEX');
  Object.keys(buckets).forEach(function(prefix){
    if(!/^[a-f0-9]{2}$/.test(prefix))hubMapPackageFail_('PACKAGE_BUCKET_INDEX');expected++;
    const entry=buckets[prefix],data=hubMapPackageReadFile_(entry,HUB_MAP_PACKAGES.maxBucket);let count=0;
    if(!data||Array.isArray(data)||typeof data!=='object')hubMapPackageFail_('PACKAGE_BUCKET_KEY');
    Object.keys(data).forEach(function(code){if(hubMapPackageBucket_(code)!==prefix||!Array.isArray(data[code]))hubMapPackageFail_('PACKAGE_BUCKET_KEY');
      if(detail)hubMapPackageCheckDetails_(data[code],code);else hubMapPackageCheckHistory_(data[code],code,root.manifest.startDate,root.manifest.endDate);
      count+=data[code].length;
    });
    if(count!==entry.count)hubMapPackageFail_('PACKAGE_COUNT');historyRows+=count;verified++;
  });
  if(!detail&&historyRows!==root.historyRows)hubMapPackageFail_('PACKAGE_HISTORY_COUNT');
  if(detail&&(!Number.isSafeInteger(root.detailRows)||historyRows!==root.detailRows||['VERIFIED_STORED_SOURCE','UNCONFIRMED'].indexOf(root.currentness)<0))hubMapPackageFail_('PACKAGE_DETAIL_COUNT');
  if(!detail){
    const index=hubMapPackageDriverIndex_(root),counts={};expected++;verified++;
    if(!root.drivers||Object.keys(root.drivers).length>256)hubMapPackageFail_('PACKAGE_DRIVER_CONTRACT');let total=0;
    Object.keys(root.drivers).forEach(function(prefix){
      if(!/^[a-f0-9]{2}$/.test(prefix))hubMapPackageFail_('PACKAGE_DRIVER_CONTRACT');const entry=root.drivers[prefix],bucket=hubMapPackageReadFile_(entry,HUB_MAP_PACKAGES.maxBucket);expected++;let count=0;
      Object.keys(bucket).forEach(function(key){if(!/^[A-Za-z0-9_-]{1,128}$/.test(key)||hubMapPackageHashText_(key).slice(0,2)!==prefix||counts[key]!==undefined)hubMapPackageFail_('PACKAGE_DRIVER_CONTRACT');hubMapPackageCheckDriverRows_(bucket[key],root.manifest.startDate,root.manifest.endDate);counts[key]=bucket[key].length;count+=bucket[key].length;});
      if(count!==entry.count)hubMapPackageFail_('PACKAGE_DRIVER_COUNT');total+=count;verified++;
    });
    if(index.length!==Object.keys(counts).length||index.some(function(row){return counts[row.driverKey]!==row.rows;})||total!==root.driverRows||!Number.isSafeInteger(root.unidentifiedDriverRows)||root.unidentifiedDriverRows<0||total+root.unidentifiedDriverRows!==root.manifest.visitCount)hubMapPackageFail_('PACKAGE_DRIVER_COUNT');
  }
  return{version:root.version,rootHash:candidate.hash,verified:verified,expected:expected};
}
// Caller must validate every candidate chunk/bucket first. The immutable receipt
// binds that verification to THIS root; pointer CAS is the only short lock.
function hubMapPackagePublish_(candidate,receipt,expectedPointer,detail){
  const root=hubMapPackageReadFile_(candidate,HUB_MAP_PACKAGES.maxManifest);
  if(!receipt||receipt.rootHash!==candidate.hash||receipt.version!==root.version||receipt.verified!==receipt.expected||receipt.expected<1)hubMapPackageFail_('PACKAGE_VERIFY_REQUIRED');
  const lock=LockService.getScriptLock();if(!lock.tryLock(1000))hubMapPackageFail_('PACKAGE_PUBLISH_BUSY');
  try{
    const props=PropertiesService.getScriptProperties(),key=detail?HUB_MAP_PACKAGES.detailProperty:HUB_MAP_PACKAGES.property,before=props.getProperty(key);
    if(before!==expectedPointer)hubMapPackageFail_('PACKAGE_POINTER_CHANGED');
    const old=before?JSON.parse(before):null;
    if(old&&root.version<=old.current.version)hubMapPackageFail_('PACKAGE_VERSION_REGRESSION');
    const next=JSON.stringify({schema:1,current:Object.assign({version:root.version,publishedAt:new Date().toISOString()},candidate),previous:old?old.current:null});
    props.setProperty(key,next);if(props.getProperty(key)!==next)hubMapPackageFail_('PACKAGE_POINTER_VERIFY');
  }finally{lock.releaseLock();}
}
