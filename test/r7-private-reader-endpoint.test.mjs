import test from 'node:test';import assert from 'node:assert/strict';
import {privateReaderEndpoint} from '../src/opsmap-abc/privateReaderEndpoint.js';
const env={HUB_API_URL:'https://existing.example/exec',HUB_API_SECRET:'SYNTHETIC_OLD_SECRET_'.repeat(3),OPSMAP_PRIVATE_READER_ENABLED:'true',OPSMAP_PRIVATE_READER_URL:'https://script.google.com/macros/s/SYNTHETIC_DEPLOYMENT_REFERENCE_1234/exec',OPSMAP_PRIVATE_READER_SECRET:'SYNTHETIC_NEW_SECRET_'.repeat(3)};
test('only the two selected-customer reads use the dedicated endpoint and HMAC secret',()=>{
 for(const action of ['customerDetail','staffCustomerDetail'])assert.deepEqual(privateReaderEndpoint(action,env),{url:env.OPSMAP_PRIVATE_READER_URL,secret:env.OPSMAP_PRIVATE_READER_SECRET,isolated:true});
 for(const action of ['mapBounds','periodAssignments','datedAssignments','customerDetailPrepared','customerDetailsSyncRequest','mapRoadBudgetReserve'])assert.deepEqual(privateReaderEndpoint(action,env),{url:env.HUB_API_URL,secret:env.HUB_API_SECRET,isolated:false});
});
test('enabled misconfiguration fails closed without falling back to the old secret or URL',()=>{
 for(const change of [{OPSMAP_PRIVATE_READER_URL:''},{OPSMAP_PRIVATE_READER_SECRET:''},{OPSMAP_PRIVATE_READER_URL:'http://script.google.com/macros/s/SYNTHETIC_DEPLOYMENT_REFERENCE_1234/exec'},{OPSMAP_PRIVATE_READER_URL:env.OPSMAP_PRIVATE_READER_URL+'?key=DISALLOWED'},{OPSMAP_PRIVATE_READER_URL:env.OPSMAP_PRIVATE_READER_URL.replace('script.google.com','untrusted.example')}])assert.throws(()=>privateReaderEndpoint('staffCustomerDetail',{...env,...change}),/PRIVATE_READER_CONFIGURATION/);
});
test('disabled configuration preserves every old Hub contract',()=>{
 assert.deepEqual(privateReaderEndpoint('staffCustomerDetail',{...env,OPSMAP_PRIVATE_READER_ENABLED:'false'}),{url:env.HUB_API_URL,secret:env.HUB_API_SECRET,isolated:false});
});
