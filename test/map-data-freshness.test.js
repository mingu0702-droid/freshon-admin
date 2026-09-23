import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {mountMapDataFreshness} from '../src/mapDataFreshness.js';
import '../public/map-period-ui.js';

test('coverage requires matching live generation and generation-bound evidence',async()=>{
 let generation=7;
 const api=mountMapDataFreshness(express(),{callHub:async()=>({data:{coverage:{generation:7,proof:'GENERATION_SHARD_HASH_AND_COLLECTION_LOG_MATCH',history:['2026-09-21'],period:[]}}}),requireView:(_q,_r,n)=>n(),previewEnabled:()=>true,modelStatus:()=>({generation})});
 assert.equal(api.coverage('2026-09-21','2026-09-21','history').coverageComplete,false);
 await api.readStatus();
 assert.equal(api.coverage('2026-09-21','2026-09-21','history').coverageComplete,true);
 assert.deepEqual(api.coverage('2026-09-20','2026-09-21','history').unconfirmedDates,['2026-09-20']);
 assert.equal(api.coverage('2026-09-21','2026-09-21','period').coverageComplete,false);
 generation=8;assert.equal(api.coverage('2026-09-21','2026-09-21','history').coverageComplete,false);
});
test('base vehicle separates current basedNo from selected driver/actual charter relation',()=>{
 const rows=[{customerCode:'S11111',baseVehicle:'101',history:[{vehicle:'용10',driverKey:'driver-a',deliveryDate:'2026-09-21'}]},{customerCode:'S22222',baseVehicle:'102',history:[{vehicle:'용10',driverKey:'driver-a',deliveryDate:'2026-09-21'}]}];
 const a=MapPeriodUi.select(rows,['101'],'',{vehicleBasis:'base'});assert.equal(a.length,1);assert.equal(a[0].vehicle,'101');assert.equal(a[0].actualVehicle,'용10');
 const driver=MapPeriodUi.select(rows,[],'driver-a',{vehicleBasis:'actual'});assert.equal(driver.length,2);assert.equal(driver[0].vehicle,'용10');
 assert.equal(MapPeriodUi.select([{...rows[0],baseVehicle:''}],['용10'],'',{vehicleBasis:'base'}).length,0);
 assert.equal(MapPeriodUi.select([{...rows[0],baseVehicle:''}],[],'',{vehicleBasis:'base'})[0].vehicle,'');
});

test('current master projection is single-flight, cached and allowlisted; no stored delivery fallback',async t=>{
 const app=express();let reads=0,resolve;
 mountMapDataFreshness(app,{callHub:()=>{throw Error('No Delivery fallback');},readBaseVehicleMaster:()=>{reads++;return new Promise(r=>resolve=r);},requireView:(_q,_r,n)=>n(),previewEnabled:()=>true,modelStatus:()=>({})});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());
 const url='http://127.0.0.1:'+server.address().port+'/api/map-phase2b/preview/base-vehicles';
 assert.equal((await fetch(url)).status,202);assert.equal((await fetch(url)).status,202);assert.equal(reads,1);
 resolve({data:[{customerCode:'S99731',baseVehicle:'221',baseVehicleState:'VERIFIED_MASTER',baseVehicleGroup:'osan',password:'SYNTHETIC'}]});await new Promise(r=>setImmediate(r));
 const r=await fetch(url),p=await r.json();assert.equal(r.status,200);assert.equal(p.data[0].baseVehicle,'221');assert.equal(p.data[0].baseVehicleGroup,'osan');assert.equal(p.meta.basis,'FIXED_DISPATCH_PRIMARY');assert.equal(JSON.stringify(p).includes('SYNTHETIC'),false);assert.equal(reads,1);
});
test('freshness requests are read-only; admin POST requires header, same origin, fixed target',async t=>{
 const calls=[],app=express(),origin='https://freshon-admin-1.onrender.com';
 mountMapDataFreshness(app,{callHub:async(a,p)=>{calls.push({a,p});return {data:a==='mapModelStatus'?{customer:{freshon:'2026-09-21',delivery:'2026-09-21'},published:{generation:5,endDate:'2026-09-19'},token:'SYNTHETIC'}:{phase:'BUILD',generation:6}};},
  requireView:(_q,_r,n)=>n(),previewEnabled:()=>true,modelStatus:()=>({ready:true,generation:5}),env:{RENDER_EXTERNAL_URL:origin},adminGuard:(q,r,n)=>q.get('x-admin-token')==='synthetic-admin'?n():r.sendStatus(401)});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());const url='http://127.0.0.1:'+server.address().port;
 const status=await(await fetch(url+'/api/map-phase2b/preview/data-status')).json();assert.equal(status.data.automatic,'NOT_CONFIGURED');assert(!JSON.stringify(status).includes('SYNTHETIC'));assert.deepEqual(calls,[{a:'mapModelStatus',p:{}}]);
 const post=(headers={},body='{}',query='')=>fetch(url+'/api/map-phase2b/admin/model-sync'+query,{method:'POST',headers:{'content-type':'application/json',Origin:origin,...headers},body});
 assert.equal((await post()).status,401);assert.equal((await post({Cookie:'staff-session'})).status,401);
 assert.equal((await post({'x-admin-token':'synthetic-admin',Origin:'https://evil.test'})).status,403);
 assert.equal((await post({'x-admin-token':'synthetic-admin'},'{}','?token=synthetic-admin')).status,401);
 assert.equal((await post({'x-admin-token':'synthetic-admin'},'{"target":"stage"}')).status,400);
 assert.equal(calls.length,1);const result=await post({'x-admin-token':'synthetic-admin'});assert.equal(result.status,202);assert.equal((await result.json()).data.phase,'BUILD');assert.deepEqual(calls.at(-1),{a:'mapModelIncrementalRequest',p:{target:'production'}});
});
