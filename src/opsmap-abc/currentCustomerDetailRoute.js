import {staffCustomerDetail} from './mapStaffDetail.js';
import {createPrivateDetailReadScope,privateDetailFailure} from './privateDetailRequest.js';
export function mountCurrentCustomerDetailRoute(app,{requireStaff,previewEnabled,callHub,env=process.env}={}){
  app.get('/api/map-phase2b/private/customer-current-detail',async(req,res)=>{
    res.set('Cache-Control','private, no-store');
    if(res.locals.sensitiveAuthenticated!==true)return res.status(401).json({ok:false,data:null,error:'STAFF_LOGIN_REQUIRED'});
    if(!previewEnabled()||env.OPSMAP_PRIVATE_READER_ENABLED!=='true')return res.status(503).json({ok:false,data:null,error:'CURRENT_DETAIL_NOT_ENABLED'});
    const customerCode=String(req.query.customerCode||'').trim().toUpperCase();
    if(!/^[A-Z]\d{3,}$/.test(customerCode)||req.query.date)return res.status(400).json({ok:false,data:null,error:'INVALID_CURRENT_DETAIL_QUERY'});
    const scope=createPrivateDetailReadScope(req,res,{deadline:Date.now()+15000});
    try{
      const result=await callHub('customerDetail',{customerCode},{useCache:false,privateRead:true,maxResponseBytes:65536,deadline:scope.deadline,signal:scope.signal});
      if(result?.ok!==true||result.data?.customerCode!==customerCode||result.meta?.sourceBasis!=='CURRENT_CUSTOMER_LOOKUP')throw Object.assign(Error('HUB_INVALID_DETAIL_CONTRACT'),{failureType:'contract'});
      const data={...staffCustomerDetail(result.data,{customerCode,date:null}),sourceBasis:'CURRENT_CUSTOMER_LOOKUP'};
      if(!scope.canRespond())return;
      return await requireStaff(req,res,()=>scope.canRespond()&&res.json({ok:true,data,meta:{cache:{cache:'LIVE_SOURCE',checkedAt:new Date().toISOString(),stale:false,currentness:'LIVE_SOURCE'}},error:null}));
    }catch(error){if(!scope.canRespond())return;const failure=privateDetailFailure(error);return res.status(failure.status).json({ok:false,data:null,error:failure.code,meta:{failure}});}
    finally{scope.dispose();}
  });
}
