import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {createPrivateDetailReadScope,privateDetailFailure} from '../src/opsmap-abc/privateDetailRequest.js';

test('request completion is not a disconnect; selection disconnect cancels only its upstream read',()=>{
 const request=new EventEmitter(),response=new EventEmitter();response.writableEnded=false;response.destroyed=false;
 const scope=createPrivateDetailReadScope(request,response,{deadline:123});
 request.emit('close');assert.equal(scope.signal.aborted,false);assert.equal(scope.canRespond(),true);assert.equal(scope.deadline,123);
 response.emit('close');assert.equal(scope.signal.aborted,true);assert.equal(scope.canRespond(),false);
 scope.dispose();assert.equal(request.listenerCount('aborted'),0);assert.equal(response.listenerCount('close'),0);
});
test('completed response does not cancel and invalidate a successful read',()=>{
 const request=new EventEmitter(),response=new EventEmitter();response.writableEnded=true;
 const scope=createPrivateDetailReadScope(request,response);response.emit('close');assert.equal(scope.signal.aborted,false);assert.equal(scope.canRespond(),false);scope.dispose();
});
test('source authentication, source absence, transport failures and employee authentication are distinct',()=>{
 assert.equal(privateDetailFailure({upstreamStatus:401,failureType:'auth'}).status,502);
 assert.equal(privateDetailFailure({upstreamStatus:403}).code,'DETAIL_SOURCE_FORBIDDEN');
 assert.equal(privateDetailFailure({upstreamStatus:404,failureType:'upstream'}).code,'DETAIL_NOT_FOUND');
 assert.equal(privateDetailFailure({upstreamStatus:404,failureType:'output'}).status,502);
 assert.equal(privateDetailFailure({name:'AbortError'}).status,504);
 assert.equal(privateDetailFailure({name:'AbortError'},{cancelledBy:'CALLER'}).code,'DETAIL_REQUEST_CANCELLED');
 const sourceError=privateDetailFailure({upstreamStatus:404,failureType:'upstream'},{phase:'CONTRACT',requestStage:'OUTPUT',upstreamStatus:200});
 assert.equal(sourceError.transportStatus,200);assert.equal(sourceError.upstreamStatus,404);
 assert.equal(JSON.stringify(privateDetailFailure({message:'secret-raw-body'},{requestId:'unsafe-token'})).includes('secret'),false);
});
