import {createOpsmapCDailyCandidate} from './opsmapCIntegration.js';
import {createLocalCoordinateSuccessBoundary} from './opsmapCoordinateSuccessBoundary.mjs';

// Registration is inert; no collection, bridge, provider or storage call occurs.
export function createOpsmapCoordinateRegistration({enabled=false,privateReceiptBridge=null,durableAccountStoreConfirmed=false,coordinates={}}={}) {
  const blockers=[];
  if(privateReceiptBridge?.kind!=='EXISTING_PRIVATE_CUSTOMER_SUCCESS'||typeof privateReceiptBridge?.bindSuccessCallback!=='function')blockers.push('PRIVATE_RECEIPT_BRIDGE_MISSING');
  if(durableAccountStoreConfirmed!==true||typeof coordinates.store?.transaction!=='function')blockers.push('DURABLE_ACCOUNT_STORE_MISSING');
  const active=enabled===true&&blockers.length===0;
  const boundary=createLocalCoordinateSuccessBoundary({createOpsmapCDailyCandidate,coordinates,enabled:active});
  return Object.freeze({status:Object.freeze({enabled:active,requestedEnabled:enabled===true,state:blockers.length?'BLOCKED':active?'LOCAL_CALLBACK_READY_NOT_AUTO_CONNECTED':'OFF',blockers:Object.freeze(blockers),collectionReceiptAvailable:false,autoCall:false,externalEnabled:false,maxRequestsPerRun:0,maxDailyRequests:0,maxDailyCostMicros:0}),begin:boundary.begin,afterCustomerDailyCollection:boundary.afterCustomerDailyCollection});
}
