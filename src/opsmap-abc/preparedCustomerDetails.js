// Prepared Customer data is the primary detail source; never loads all customers
// into Render memory. Missing fields, blank values and confirmed removals differ.
import '../../integrations/opsmap-abc/hub/HubCustomerDetailContract.js';
const contract=globalThis.OpsmapCustomerDetailContract;
export const {observation:detailObservation,merge:mergeCustomerDetail,project:projectCustomerDetail}=contract;
const notReady=e=>/^(?:HUB_)?(?:INVALID_ACTION|CUSTOMER_DETAILS_NOT_READY|PACKAGE_NOT_READY)$/.test(e?.code||e?.message||'');
const fail=code=>Object.assign(new Error(code),{code,failureType:'contract'});
export function validatePreparedDetail(payload,{customerCode,view='notes',date}){
  const d=payload?.data,m=payload?.meta;
  if(!d||d.customerCode!==customerCode||m?.source!=='CUSTOMER_PRIVATE_PREPARED'||!Number.isSafeInteger(m.version)||m.version<1||!contract.instant(m.checkedAt))throw fail('HUB_INVALID_PREPARED_DETAIL');
  if(!['SOURCE_UNCHANGED','SOURCE_CHANGED','UNCONFIRMED'].includes(m.currentness))throw fail('HUB_INVALID_PREPARED_DETAIL');
  const fields=view==='store'?['customerName','address','detailAddress','deliveryPattern']:['accessInfo','password','securityKey','generalKey','specialRemark','deliveryPattern'];
  const output={customerCode},states={};
  for(const field of fields){const value=d[field],state=d.fieldState?.[field];
    if(!['UNOBSERVED','PRESENT','TIME_UNCONFIRMED','CLEARED','DELETED','CONFLICT'].includes(state))throw fail('HUB_INVALID_PREPARED_DETAIL');
    if(['CLEARED','DELETED','CONFLICT','UNOBSERVED'].includes(state)&&value!==null)throw fail('HUB_INVALID_PREPARED_DETAIL');
    if(value!==null&&contract.normalize(field,value)!==value)throw fail('HUB_INVALID_PREPARED_DETAIL');
    output[field]=value;states[field]=state;
  }
  output.fieldState=states;
  if(view==='store'){output.detailDate=date;output.detailAddressState=states.detailAddress==='CLEARED'?'EMPTY':states.detailAddress;output.businessCoverageVerified=false;}
  else{if(!['REGISTERED','UNREGISTERED','NEEDS_CONFIRMATION','DELETED'].includes(d.memoState))throw fail('HUB_INVALID_PREPARED_DETAIL');output.memoDate=date;output.memoState=d.memoState;}
  output.source='Customer 저장자료';
  // Only safe freshness metadata leaves the private transport.
  return {value:output,meta:{cache:'PREPARED',source:'CUSTOMER_PRIVATE_PREPARED',sourceVersion:String(m.version),checkedAt:m.checkedAt,stale:m.currentness!=='SOURCE_UNCHANGED',currentness:m.currentness,refreshing:false,revision:Number.isSafeInteger(m.revision)?m.revision:null}};
}
export function createPreparedCustomerDetailReader({callHub,now=Date.now}={}){
  if(typeof callHub!=='function')throw TypeError('callHub required');
  let unsupportedUntil=0;
  return {async read(identity,{legacyLoader,refresh=false}={}){
    if(!/^[A-Z]\d{1,20}$/.test(identity.customerCode||'')||!['notes','store'].includes(identity.view))throw fail('DETAIL_IDENTITY');
    if(refresh||now()>=unsupportedUntil){
      try{
        const payload=await callHub('customerDetailPrepared',{customerCode:identity.customerCode,view:identity.view,requestedDate:identity.date},{privateRead:true,useCache:false,maxResponseBytes:32768,deadline:now()+8000});
        unsupportedUntil=0;return validatePreparedDetail(payload,identity);
      }catch(e){
        // Permissions, corruption and transient failures MUST NOT turn into an
        // apparently current old password or an expensive fallback source scan.
        if(!notReady(e))throw e;unsupportedUntil=now()+30000;
      }
    }
    if(typeof legacyLoader!=='function')throw fail('CUSTOMER_DETAILS_NOT_READY');
    const legacy=await legacyLoader();
    return {...legacy,meta:{...legacy.meta,cache:legacy.meta?.cache||'LEGACY',prepared:false,currentness:'UNCONFIRMED',stale:true,refreshing:false,source:'CUSTOMER_LEGACY_UNVERIFIED'}};
  }};
}
