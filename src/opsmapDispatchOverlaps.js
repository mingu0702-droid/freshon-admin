import {createHash} from 'node:crypto';
import {open,realpath} from 'node:fs/promises';
import path from 'node:path';
import {coordinateAddressHash} from './opsmap-abc/opsmapAutoCoordinates.js';
import {readPostalAddressEvidence} from './shadowCoverage/postalAddressEvidence.js';
import {opsmapArchiveSite} from './stageScope.js';

const contract='opsmap-dispatch-overlaps-v1';
const center='osan';
const hash=/^[a-f0-9]{64}$/;
const customer=/^[A-Z]\d{1,20}$/;
const route=/^(?:\d+|(?:용|척)\d{1,5})$/;
const maxRows=30000;
const maxLocalEvidenceBytes=2*1024*1024;
const vehicleOrder=new Intl.Collator('ko',{numeric:true});
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validPostal=value=>typeof value==='string'&&/^\d{5}$/.test(value)&&value>='01000';
const unavailable=()=>Object.assign(Error('DISPATCH_OVERLAPS_UNAVAILABLE'),{status:503});
const changed=()=>Object.assign(Error('DISPATCH_OVERLAPS_VERSION_CHANGED'),{status:409});

function coordinate(row,stored) {
  const currentPoint=row.verifiedLocation;
  const saved=stored?.hasPoint===true&&stored.addressHash===coordinateAddressHash(row.basicAddress)?stored:null;
  const point=currentPoint?.addressHash===row.addressHash?currentPoint:saved;
  if(!Number.isFinite(point?.lat)||point.lat<33||point.lat>39.5||
      !Number.isFinite(point.lng)||point.lng<124||point.lng>132) {
    return {lat:null,lng:null,coordinateVerified:false};
  }
  return {lat:point.lat,lng:point.lng,coordinateVerified:true};
}

// Optional address-only evidence is bound to the same verified roster. These
// rows contribute no new point, polygon membership, or past delivery evidence.
export function createDispatchPostalEvidenceReader({env=process.env,appRoot=process.cwd()}={}) {
  if(env.OPSMAP_DISPATCH_POSTAL_ADDRESS_EVIDENCE_APPROVED!=='1')return undefined;
  const filename=env.OPSMAP_DISPATCH_POSTAL_ADDRESS_EVIDENCE_FILE;
  const expected=env.OPSMAP_DISPATCH_POSTAL_ADDRESS_EVIDENCE_SHA256;
  const encoded=env.OPSMAP_SHADOW_POSTAL_ASSET_KEY_B64||'';
  const key=Buffer.from(encoded,'base64');
  const fileIdentity=({dev,ino,size,mtimeMs,ctimeMs})=>[dev,ino,size,mtimeMs,ctimeMs].join(':');
  let cache;
  return async registry=>{
    if(!opsmapArchiveSite(env)||!path.isAbsolute(filename||'')||!hash.test(expected||'')||
        key.length!==32||key.toString('base64')!==encoded)throw unavailable();
    const filePath=await realpath(filename);
    const publicPath=path.relative(path.resolve(appRoot,'public'),filePath);
    if(!publicPath||!publicPath.startsWith('..'+path.sep)&&!path.isAbsolute(publicPath))throw unavailable();
    const file=await open(filePath,'r');
    let value, identity;
    try {
      const stat=await file.stat();
      const {size}=stat;
      if(!stat.isFile()||size<29||size>maxLocalEvidenceBytes)throw unavailable();
      identity=fileIdentity(stat);
      if(cache?.registry===registry.ref.version&&cache.path===filePath&&cache.identity===identity)return cache.checked;
      const buffer=Buffer.alloc(size);
      let offset=0;
      while(offset<size){
        const {bytesRead}=await file.read(buffer,offset,size-offset,offset);
        if(!bytesRead)throw unavailable();
        offset+=bytesRead;
      }
      if(fileIdentity(await file.stat())!==identity)throw unavailable();
      value=JSON.parse(buffer.toString('utf8'));
    } finally {await file.close();}
    if(value?.schema!=='opsmap-local-sealed-postal-address-evidence-v1'||value.reference?.sha256!==expected||
        !hash.test(value.reference?.registry||'')||typeof value.sealed!=='string')throw unavailable();
    const bytes=Buffer.from(value.sealed,'base64');
    if(bytes.toString('base64')!==value.sealed)throw unavailable();
    const checked=readPostalAddressEvidence(bytes,{approvedReference:value.reference,registry,key,retainMatchingOsan:true});
    cache={registry:registry.ref.version,path:filePath,identity,checked};
    return checked;
  };
}

export function createOpsmapDispatchOverlapsReader({getPublication,postalGenerationFor=publication=>publication?.postalGeneration,readRegistry,readFixed,readPostcodes,
  readPostalEvidence}) {
  let saved, pending, lastFixed;

  async function build() {
    const publication=getPublication?.();
    const postalGeneration=postalGenerationFor(publication);
    if(!hash.test(postalGeneration||''))throw unavailable();
    const registry=await readRegistry?.();
    const registryVersion=registry?.ref?.version;
    if(!hash.test(registryVersion||'')||!Array.isArray(registry.rows)||registry.rows.length>maxRows)throw unavailable();
    const rows=registry.rows.filter(row=>row.lifecycle==='ACTIVE'&&row.centerGroup===center);
    const registryCodes=new Set(rows.map(row=>row.customerCode));
    if(!rows.length||registryCodes.size!==rows.length||[...registryCodes].some(code=>!customer.test(code)))throw unavailable();
    const [fixed,postal,evidence]=await Promise.all([
      readFixed?.([...registryCodes],lastFixed?.transferVersion),
      readPostcodes?.({registry:registryVersion,generation:postalGeneration}),
      readPostalEvidence?.(registry)
    ]);
    if(getPublication()!==publication)throw changed();
    if(postal?.registryVersion!==registryVersion||!(postal?.postcodes instanceof Map)||
        evidence&&evidence.registry!==registryVersion)throw unavailable();
    if(fixed?.ok!==true||fixed.meta?.basis!=='FIXED_DISPATCH_PRIMARY'||fixed.meta.stale!==false||
        !hash.test(fixed.meta.version||''))throw unavailable();
    if(!fixed.notModified) {
      if(!Array.isArray(fixed.data)||fixed.data.length!==rows.length)throw unavailable();
      lastFixed=fixed;
    }
    if(!lastFixed||lastFixed.meta.version!==fixed.meta.version||lastFixed.transferVersion!==fixed.transferVersion)throw unavailable();
    if(saved?.registry===registry&&saved.publication===publication&&saved.fixed===lastFixed&&
        saved.postcodes===postal.postcodes&&saved.evidence===evidence)return saved.value;

    const fixedRows=new Map(lastFixed.data.map(row=>[row.customerCode,row]));
    if(fixedRows.size!==registryCodes.size||[...registryCodes].some(code=>!fixedRows.has(code)))throw unavailable();
    const counts={registeredStores:rows.length,verifiedFixedStores:0,verifiedPostalStores:0,eligibleStores:0};
    const groups=new Map();
    for(const row of rows){
      const {customerCode,customerName}=row;
      const binding=fixedRows.get(customerCode);
      const vehicle=binding.baseVehicle;
      const fixedVerified=binding.baseVehicleSource==='FIXED_DISPATCH_PRIMARY'&&
        binding.baseVehicleVersion===fixed.meta.version&&binding.baseVehicleStale!==true&&
        binding.baseVehicleGroup===center&&binding.baseVehicleState==='VERIFIED_MASTER'&&route.test(vehicle||'');
      if(fixedVerified)counts.verifiedFixedStores++;
      const currentPostal=postal.postcodes.get(customerCode);
      const independentPostal=evidence?.lookup(customerCode)?.postalCode;
      const postalCode=validPostal(currentPostal)?currentPostal:independentPostal;
      if(!validPostal(postalCode))continue;
      counts.verifiedPostalStores++;
      if(!fixedVerified)continue;
      counts.eligibleStores++;
      if(!groups.has(postalCode))groups.set(postalCode,{routes:new Map(),stores:[]});
      const group=groups.get(postalCode);
      group.routes.set(vehicle,(group.routes.get(vehicle)||0)+1);
      group.stores.push({customerCode,customerName,vehicle,
        ...coordinate(row,publication.registry?.get(customerCode))});
    }
    if(!counts.verifiedFixedStores||!counts.verifiedPostalStores)throw unavailable();
    const details=[...groups].filter(([,group])=>group.routes.size>1).map(([postalCode,group])=>({
      postalCode,routeCount:group.routes.size,storeCount:group.stores.length,
      routes:[...group.routes].sort(([a],[b])=>vehicleOrder.compare(a,b)||a.localeCompare(b)).map(([vehicle,storeCount])=>({vehicle,storeCount})),
      stores:group.stores.sort((a,b)=>vehicleOrder.compare(a.vehicle,b.vehicle)||a.customerCode.localeCompare(b.customerCode))
    })).sort((a,b)=>b.routeCount-a.routeCount||b.storeCount-a.storeCount||a.postalCode.localeCompare(b.postalCode));
    const fixedVersion=fixed.meta.version;
    const version=digest([registryVersion,fixedVersion,postalGeneration,counts,details]);
    const meta={contract,state:'VERIFIED',center,version,registryVersion,fixedVersion,
      fixedObservedAt:fixed.meta.sourceObservedAt??fixed.meta.checkedAt??null,counts};
    const value={...meta,candidates:details.map(({stores,...summary})=>summary),details:new Map(details.map(item=>[item.postalCode,item]))};
    saved={registry,publication,fixed:lastFixed,postcodes:postal.postcodes,evidence,value};
    return value;
  }

  return async ({postalCode,version}={})=>{
    pending??=build().finally(()=>{pending=null;});
    const {details,candidates,...meta}=await pending;
    if(postalCode===undefined)return {...meta,candidates};
    if(version!==meta.version)throw changed();
    const candidate=details.get(postalCode);
    if(!candidate)throw Object.assign(Error('DISPATCH_OVERLAPS_NOT_FOUND'),{status:404});
    return {...meta,candidate};
  };
}

export function mountOpsmapDispatchOverlaps(app,{requireStaff,read}) {
  app.get('/api/map-phase2b/private/dispatch-reference-overlaps',requireStaff,async(req,res)=>{
    res.set('Cache-Control','private, no-store').vary('Cookie');
    const query=new URLSearchParams(req.originalUrl.split('?').slice(1).join('?'));
    const postalCode=query.get('postalCode')??undefined, version=query.get('version')??undefined;
    if(query.size!==0&&(query.size!==2||!validPostal(postalCode)||typeof version!=='string'||!hash.test(version))) {
      return res.status(400).json({error:'DISPATCH_OVERLAPS_QUERY_INVALID'});
    }
    try {
      const result=await read({postalCode,version});
      if(res.destroyed||res.writableEnded)return;
      return requireStaff(req,res,()=>res.json(result));
    } catch(error) {
      if(res.destroyed||res.writableEnded)return;
      const known=error?.message==='DISPATCH_OVERLAPS_VERSION_CHANGED'||
        error?.message==='DISPATCH_OVERLAPS_NOT_FOUND';
      return requireStaff(req,res,()=>res.status(known?error.status:503)
        .json({state:'UNAVAILABLE',error:known?error.message:'DISPATCH_OVERLAPS_UNAVAILABLE'}));
    }
  });
}
