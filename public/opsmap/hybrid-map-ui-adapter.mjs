import {createHybridMapClient} from './hybrid-map-client.mjs';

// A verified package can still be held. Never infer permission from VERIFIED alone.
export function createHybridMapUiAdapter({fetcher=globalThis.fetch,client=createHybridMapClient({fetcher}),onState=()=>{},readTimeoutMs=10000}={}) {
  if(!Number.isInteger(readTimeoutMs)||readTimeoutMs<1||readTimeoutMs>10000)throw Error('HYBRID_UI_TIMEOUT');
  async function bounded(task,work){let timer;try{return await Promise.race([Promise.resolve().then(work),new Promise((_,reject)=>{timer=setTimeout(()=>{if(task.id===epoch)controller?.abort();reject(Error('HYBRID_UI_STATUS_TIMEOUT'));},readTimeoutMs);})]);}finally{clearTimeout(timer);}}
  let epoch=0, controller,lastGood=null,masterRows=[],selectedPeriod=null,rangeIterator=null,windowPending=null,windowOwner=null,rangeTotals=new Map(),totalBytes=0,rollingReady=false;
  const cancel=()=>{epoch++;controller?.abort();client.cancel();rangeTotals.clear();totalBytes=0;windowPending=null;rangeIterator=null;selectedPeriod=null;};
  function begin(){cancel();controller=new AbortController();return {id:epoch,signal:controller.signal};}
  function current(task){if(task.id!==epoch||task.signal.aborted)throw Object.assign(Error('QUERY_CANCELLED'),{name:'AbortError'});}
  async function availability(task){
    rollingReady=false;if(globalThis.window)globalThis.window.MAP_ROLLING_DATE_INDEX_ENABLED=false;
    const response=await bounded(task,()=>fetcher('/api/map-phase2b/hybrid/ui-status',{credentials:'same-origin',cache:'no-store',signal:task.signal}));current(task);
    if([401,404].includes(response.status))return 'legacy';
    if(!response.ok)throw Error('HYBRID_UI_STATUS_FAILED');
    const status=await bounded(task,()=>response.json());current(task);
    if(status.verification!=='VERIFIED'||status.publicationHeld!==false)return 'held';
    rollingReady=status.rollingDateIndexEnabled===true;if(globalThis.window)globalThis.window.MAP_ROLLING_DATE_INDEX_ENABLED=rollingReady;
    return 'ready';
  }
  async function read(kind,date,{masterOnly=false}={}){
    const task=begin();const cacheToken=kind==='general'?await client.cacheToken?.():null;current(task);onState({state:'loading'});
    try {
      const status=await availability(task);current(task);
      if(status!=='ready'){onState({state:status});return null;}
      if(kind==='date'){
        if(rollingReady){
          // Reuse the verified stored-date path, never live Current assignments.
          const page=await readPeriodWindow(date,date,masterRows);
          if(!page||page.meta.complete!==true||page.meta.aggregateComplete!==true)throw Error('HYBRID_STORED_DATE_INCOMPLETE');
          const data=page.data.flatMap(row=>(row.history||[]).map(h=>({...row,history:[h],relations:[h],deliveryDate:date,lastDeliveryDate:date,vehicle:h.vehicle,confirmedVehicle:h.vehicle,deliveryCount:h.count})));
          return {ok:true,data,meta:{...page.meta,date,complete:true,coverageComplete:true,source:'HUB_PUBLISHED_SEALED'}};
        }
        const result=await client.readSelectedDate(date);current(task);
        const value={...result,data:result.data.map(row=>({...row,vehicle:row.confirmedVehicle})),meta:{...result.meta,complete:true}};
        onState({state:value.data.length?'ready':'empty'});return value;
      }
      const manifest=await client.openPackage();current(task);
      const data=[],codes=new Set();let viewBytes=0;
      for(const entry of manifest.chunks){
        const chunk=await client.readChunk(manifest,entry.key);current(task);
        for(const row of chunk.data){
          if(codes.has(row[0]))throw Error('HYBRID_PACKAGE_DUPLICATE');codes.add(row[0]);
          const history=masterOnly?[]:row[9].map(([offset,vehicle,count])=>({deliveryDate:new Date(Date.parse(manifest.startDate)+offset*86400000).toISOString().slice(0,10),vehicle,deliveryCount:count}));
          if(data.length>=15000)throw Error('HYBRID_MASTER_LIMIT');
          const valueRow={customerCode:row[0],customerName:row[1],address:row[2],lat:row[3],lng:row[4],deliveryPattern:row[5],vehicle:row[6],baseVehicle:row[6],weekdayVehicles:row[7],lastDeliveryDate:history.map(r=>r.deliveryDate).sort().at(-1)||'',history,relations:history};
          if(masterOnly){const summary={verified:manifest.coverage.unconfirmedDates.length===0&&manifest.coverage.proof==='VERIFIED_SOURCE',scope:'PUBLISHED_ONLY',startDate:manifest.startDate,endDate:manifest.endDate,count:0,lastDeliveryDate:''};
            for(const [offset,,count]of row[9]){summary.count+=count;const date=new Date(Date.parse(manifest.startDate)+offset*86400000).toISOString().slice(0,10);if(date>summary.lastDeliveryDate)summary.lastDeliveryDate=date;}
            valueRow.residentSummary=summary;valueRow.lastDeliveryDate=summary.lastDeliveryDate;viewBytes+=new TextEncoder().encode(JSON.stringify(valueRow)).length;if(viewBytes>6291456)throw Error('HYBRID_MASTER_MEMORY_LIMIT');}
          data.push(valueRow);
        }
      }
      const pinned=await client.openPackage();current(task);
      if(JSON.stringify(pinned)!==JSON.stringify(manifest))throw Error('HYBRID_GENERATION_CHANGED');
      const value={ok:true,data,meta:{complete:true,periodHistoryLoaded:!masterOnly,sourceObservedAt:manifest.sourceObservedAt,startDate:manifest.startDate,endDate:manifest.endDate,coverage:manifest.coverage,version:manifest.version,sourceGeneration:manifest.sourceGeneration,registryComplete:false}};
      if(masterOnly&&client.cacheGeneral){current(task);await client.cacheGeneral(value,cacheToken,{signal:task.signal});current(task);}
      masterRows=data;lastGood=value;onState({state:data.length?'ready':'empty',meta:value.meta});return value;
    }catch(error){if(task.id===epoch)onState({state:error.name==='AbortError'?'cancelled':'error',retained:Boolean(lastGood)});throw error;}
  }
  async function readPeriod(startDate,endDate){
    const task=begin();onState({state:'loading'});const status=await availability(task);current(task);
    if(status!=='ready'||!rollingReady){onState({state:status==='ready'?'held':status,retained:Boolean(lastGood)});return null;}
    selectedPeriod=Object.freeze({startDate,endDate});rangeIterator=client.readPeriod({...selectedPeriod,includeNextDaySize:true});return nextPeriodPage();
  }
  async function nextPeriodPage(){
    if(!rangeIterator)throw Error('PERIOD_NOT_SELECTED');
    const id=epoch,iterator=rangeIterator;
    try{const r=await iterator.next();if(id!==epoch||iterator!==rangeIterator)throw Object.assign(Error('QUERY_CANCELLED'),{name:'AbortError'});if(r.done)return null;const p=r.value;
      // Period rows are history summaries only: do not overwrite current store/access metadata.
      onState({state:p.meta.status==='PREPARING'?'preparing':p.meta.status==='UNCONFIRMED'?'unconfirmed':p.meta.status==='MISSING'?'missing':p.meta.provisional?'checking':p.data.length?'ready':'empty',meta:p.meta,selectedPeriod});return p;
    }catch(error){if(id===epoch&&iterator===rangeIterator)onState({state:error.name==='AbortError'?'cancelled':'error',retained:Boolean(lastGood),selectedPeriod});throw error;}
  }
  function catalogReady(c){
    if(!c||Date.parse(c.endDate)-Date.parse(c.startDate)!==89*86400000)return false;
    const dates=new Set(c.days.map(r=>r.date));for(let d=c.startDate;d<=c.endDate;d=new Date(Date.parse(d)+86400000).toISOString().slice(0,10))if(!dates.has(d))return false;
    return true;
  }
  async function refreshLatest(){
    const before=selectedPeriod,id=epoch;const c=await client.refreshDateCatalog();if(id!==epoch)throw Object.assign(Error('QUERY_CANCELLED'),{name:'AbortError'});
    if(before===selectedPeriod)onState({state:'latest-available',version:c.version,selectedPeriod:before});return {...c,ready:catalogReady(c)};
  }
  // Existing period renderer receives at most seven complete dates. Long queries
  // use an explicit next-page action; a page is never an entire-period aggregate.
  async function readPeriodWindow(startDate,endDate,masters=[],next=false){
    if(next&&windowOwner?.generation===epoch)throw Error('PERIOD_READ_BUSY');
    const generation=next?epoch:epoch+1,startedAt=Date.now(),owner={generation};windowOwner=owner;
    try{
      if(!Array.isArray(masters)||masters.length>15000)throw Error('PERIOD_MASTER_LIMIT');
      let p;
      if(!next){windowPending=null;rangeTotals=new Map();totalBytes=0;p=await readPeriod(startDate,endDate);if(!p)return null;}
      else{if(selectedPeriod?.startDate!==startDate||selectedPeriod?.endDate!==endDate)throw Error('PERIOD_QUERY_CHANGED');
        const task={id:epoch,signal:controller.signal},status=await availability(task);current(task);if(status!=='ready'||!rollingReady)throw Error('PERIOD_ACCESS_UNAVAILABLE');
        const pending=windowPending;windowPending=null;if(!pending)return null;
        const pinned=await client.refreshDateCatalog({catalogVersion:pending.catalogVersion});current(task);
        if(pinned.version!==pending.catalogVersion||pinned.basis!==pending.basis)throw Error('HYBRID_GENERATION_CHANGED');
        p=await nextPeriodPage();if(!p)throw Error('PERIOD_READ_INCOMPLETE');}
      const rows=new Map(),dates=new Set();let bytes=2,last;
      for(let pages=0;p&&pages<469;pages++){
        if(Date.now()-startedAt>30000)throw Error('PERIOD_WINDOW_DEADLINE');
        if(generation!==epoch)throw Object.assign(Error('QUERY_CANCELLED'),{name:'AbortError'});
        if(!p.meta.verified)throw Error('PERIOD_'+p.meta.status);
        dates.add(p.meta.date);
        for(const r of p.data){bytes+=new TextEncoder().encode(JSON.stringify(r)).length+1;if(bytes>4194304)throw Error('PERIOD_WINDOW_PAGINATION_REQUIRED');
          const list=rows.get(r.customerCode)||[];list.push({deliveryDate:r.deliveryDate,vehicle:r.confirmedVehicle,count:r.count});rows.set(r.customerCode,list);
          const key=r.customerCode+'|'+r.confirmedVehicle,prior=rangeTotals.get(key);
          if(prior){prior.count+=r.count;if(!Number.isSafeInteger(prior.count))throw Error('PERIOD_COUNT_LIMIT');prior.lastDeliveryDate=r.deliveryDate;}
          else{const value={customerCode:r.customerCode,vehicle:r.confirmedVehicle,count:r.count,lastDeliveryDate:r.deliveryDate};totalBytes+=new TextEncoder().encode(JSON.stringify(value)).length+64;
            if(rangeTotals.size>=20000||totalBytes>2097152)throw Error('PERIOD_AGGREGATE_PAGINATION_REQUIRED');rangeTotals.set(key,value);}
        }
        last=p.meta;
        if(last.readComplete||last.dayComplete&&(dates.size===7||Number.isSafeInteger(last.nextDayBytes)&&bytes+last.nextDayBytes>4194304))break;
        p=await nextPeriodPage();if(!p)throw Error('PERIOD_READ_INCOMPLETE');
      }
      if(!last?.dayComplete)throw Error('PERIOD_READ_INCOMPLETE');
      windowPending=last.readComplete?null:{catalogVersion:last.catalogVersion,basis:last.basis};
      if(Date.now()-startedAt>30000)throw Error('PERIOD_WINDOW_DEADLINE');
      if(generation!==epoch)throw Object.assign(Error('QUERY_CANCELLED'),{name:'AbortError'});
      const master=new Map(masters.map(r=>[r.customerCode,r])),missingMasters=new Set();
      // Retired/unregistered stores can have valid historical records. Do not
      // invent a current address, coordinate or access detail for those records.
      const currentMaster=code=>{if(master.has(code))return master.get(code);missingMasters.add(code);return {
        customerCode:code,customerName:code,address:'',lat:null,lng:null,baseVehicle:'',currentMasterStatus:'UNAVAILABLE'};};
      const aggregate=new Map();if(last.readComplete)for(const r of rangeTotals.values()){const list=aggregate.get(r.customerCode)||[];list.push({...r});aggregate.set(r.customerCode,list);}
      const data=[...(last.readComplete?aggregate:rows)].map(([code,values])=>{const history=rows.get(code)||[];return {...currentMaster(code),history,relations:history,
        ...(last.readComplete?{periodAggregate:{verified:true,startDate,endDate,groups:values},historyCoverage:'DISPLAY_PAGE_ONLY'}:{})};});
      const value={ok:true,data,meta:{segmented:true,startDate,endDate,displayStartDate:[...dates][0],displayEndDate:[...dates].at(-1),displayComplete:true,
        complete:last.readComplete,historyComplete:dates.size===Math.round((Date.parse(endDate)-Date.parse(startDate))/86400000)+1&&last.readComplete,
        queryReadComplete:last.readComplete,aggregateComplete:last.aggregateComplete,
        more:Boolean(windowPending),currentMasterMissingCount:missingMasters.size,basis:last.basis,catalogVersion:last.catalogVersion,protectedHistory:'SEPARATE_AUTHENTICATED_READ'}};
      // Only a fully verified displayed page can replace the previously good view.
      lastGood=value;return value;
    }catch(error){if(generation===epoch){client.cancel();windowPending=null;rangeIterator=null;rangeTotals.clear();totalBytes=0;onState({state:({'PERIOD_PREPARING':'preparing','PERIOD_UNCONFIRMED':'unconfirmed','PERIOD_MISSING':'missing'})[error.message]||(error.name==='AbortError'?'cancelled':'error'),retained:Boolean(lastGood),selectedPeriod});}throw error;}
    finally{if(windowOwner===owner)windowOwner=null;}
  }
  function closePeriod(){cancel();const cleanup=client.closePeriod();rangeIterator=null;windowPending=null;selectedPeriod=null;rangeTotals.clear();totalBytes=0;if(lastGood?.meta?.segmented)lastGood=null;return cleanup;}
  async function readPeriodStatus(){const task=begin(),status=await availability(task);current(task);if(status!=='ready'||!rollingReady)return {ready:false};const c=await client.openDateCatalog();current(task);
    if(Date.parse(c.endDate)-Date.parse(c.startDate)!==89*86400000)return {ready:false};
    const dates=new Set(c.days.map(r=>r.date));let covered=0;for(let d=c.startDate;d<=c.endDate;d=new Date(Date.parse(d)+86400000).toISOString().slice(0,10))if(dates.has(d))covered++;
    return {ready:covered===90&&Date.parse(c.endDate)-Date.parse(c.startDate)===89*86400000,...c};}
  const unsubscribe=client.onCacheChange?.(event=>{if(event?.type==='logout'){cancel();lastGood=null;masterRows=[];onState({state:'logged-out'});}else if(event?.type==='publication')onState({state:'latest-available',external:true,version:event.version,selectedPeriod});});
  async function readCachedGeneral(){const id=epoch,value=await client.readCachedGeneral?.();if(id!==epoch)return null;if(value){lastGood=value;masterRows=value.data;onState({state:'cached',meta:value.meta});}return value||null;}
  async function logout(){cancel();lastGood=null;masterRows=[];await client.logout?.();onState({state:'logged-out'});}
  function dispose(){cancel();lastGood=null;masterRows=[];unsubscribe?.();client.dispose?.();}
  return {readCachedGeneral,logout,dispose,readGeneral:options=>read('general',undefined,options),readDate:date=>read('date',date),readPeriod,nextPeriodPage,readPeriodWindow,readPeriodStatus,closePeriod,refreshLatest,
    state:()=>({selectedPeriod,lastGoodAvailable:Boolean(lastGood)}),cancel};
}
