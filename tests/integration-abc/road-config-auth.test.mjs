import test from 'node:test';
import assert from 'node:assert/strict';
import {mountRoadRouteRoutes} from '../../src/roadRouteService.js';
function setup(){
 let authorized=true,resolve;
 const pending=new Promise(r=>{resolve=r;}),routes=new Map();
 const app={get:(name,...handlers)=>routes.set(name,handlers),post(){}};
 const requireStaff=(_q,r,next)=>authorized?next():r.status(401).json({error:'STAFF_LOGIN_REQUIRED'});
 mountRoadRouteRoutes({app,requireStaff,jsonBody(){},service:{readiness:()=>pending}});
 const res={statusCode:200,payload:null,set(){return this;},status(value){this.statusCode=value;return this;},json(value){this.payload=value;return this;}};
 const handlers=routes.get('/api/map-phase2b/private/road-route/config');
 const run=handlers[0]({},res,()=>handlers[1]({},res));
 return {res,run,release:()=>resolve({enabled:true,approvedRemaining:2}),logout:()=>{authorized=false;}};
}
test('road configuration remains available to a valid authenticated request',async()=>{
 const h=setup();h.release();await h.run;assert.equal(h.res.statusCode,200);assert.equal(h.res.payload.data.approvedRemaining,2);
});
test('logout while asynchronous road readiness is pending denies the final protected response',async()=>{
 const h=setup();h.logout();h.release();await h.run;assert.equal(h.res.statusCode,401);assert.equal(h.res.payload.error,'STAFF_LOGIN_REQUIRED');assert.equal(h.res.payload.data,undefined);
});
