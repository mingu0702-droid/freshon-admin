import {preparePrivateCoordinateAddress,coordinateAddressHash,kakaoCoordinateResult} from './opsmap-abc/opsmapAutoCoordinates.js';

// Search grammar only. Customer identity always uses the unchanged basic-address hash.
export function prepareRecoveryCoordinateAddress(basic,detail='') {
 const value=preparePrivateCoordinateAddress(basic,detail);
 if(!value.query)return value;
 let query=value.query.replace(/(대로|로|길)(\d+(?:-\d+)?)(?=$)/,'$1 $2');
 // Administrative annotations are not a street/building identifier. Do not remove arbitrary names.
 query=query.replace(/\s*\(([가-힣0-9]+(?:동(?:\d+가)?|리))\)\s*$/,'').trim();
 const kind=/(?:대로|로|길)\s+(?:지하\s+)?\d+(?:-\d+)?/.test(query)?'ROAD':/(?:동\d+가|동|리|가|읍|면)\s+(?:산\s*)?\d+(?:-\d+)?/.test(query)?'LOT':'UNCONFIRMED';
 return {...value,query,queryHash:coordinateAddressHash(query),addressKind:kind,queryRuleVersion:'EXPLICIT_ROAD_NUMBER_ADMIN_ANNOTATION_V2'};
}

// The exact predicate is unchanged. All provider coordinates remain request-only.
export function classifyCoordinateLookup(body,query) {
 const documents=body?.documents;
 if(!Array.isArray(documents))return {point:null,resolution:{kind:'INVALID_RESPONSE',candidateCount:0}};
 const count=documents.length,point=kakaoCoordinateResult(body,query);
 const kind=point?'EXACT':body.meta?.is_end===false?'TRUNCATED':!count?'ZERO_RESULT':count>1||body.meta?.total_count>1?'MULTIPLE_CANDIDATES':'ADDRESS_OR_COORDINATE_MISMATCH';
 return {point,resolution:{kind,candidateCount:count}};
}
