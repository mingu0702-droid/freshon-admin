// Local-only synthetic UI fixture. Never imports server.js or starts recovery.
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public');
const app=express();
const rows=Array.from({length:240},(_,i)=>({customerCode:i?'S'+(91000+i):'S99731',customerName:'합성검수 '+i,
  address:['경기도 수원시 테스트로 1','부산광역시 테스트로 1','광주광역시 테스트로 1'][i%3],lat:[37.28,35.17,35.15][i%3]+i*.00001,lng:[127.01,129.07,126.85][i%3]+i*.00001,
  relations:[{deliveryDate:'2026-09-19',vehicle:i%3===0?'838':String(501+i%2),driverKey:'TEST'+i%3,driverName:'합성기사',count:1}]}));
const model={ready:true,generation:1789933588775,startDate:'2026-06-22',endDate:'2026-09-19',periodLatest:'2026-09-19'};
app.get('/api/map-phase2b/preview/period-status',(_q,r)=>r.json(model));
app.get('/api/map-phase2b/preview/period',(q,r)=>r.json({data:rows,meta:{complete:true,startDate:q.query.startDate,endDate:q.query.endDate,coverageComplete:false,periodLatest:'2026-09-19',missingCoordinate:0}}));
app.get('/api/map-phase2b/preview/base-vehicles',(_q,r)=>r.json({data:rows.map((x,i)=>({customerCode:x.customerCode,baseVehicle:['221','501','502'][i%3],baseVehicleState:'VERIFIED_MASTER'}))}));
app.get('/api/map-phase2b/preview/snapshot',(_q,r)=>r.json({data:rows,meta:{latestDate:'2026-09-19'}}));
app.get('/api/map-phase2b/preview/status',(_q,r)=>r.json({snapshot:{phase:'DONE',latest:'2026-09-19',stale:false}}));
app.get('/api/map-phase2b/preview/data-status',(_q,r)=>r.json({data:{customer:{freshon:'2026-09-21',delivery:'2026-09-21'},published:{endDate:'2026-09-19'},live:model,automatic:'NOT_CONFIGURED'}}));
app.get('/api/map-phase2b/auth/session',(_q,r)=>r.json({authenticated:true,expiresAt:Date.now()+3600000,idleExpiresAt:Date.now()+3600000}));
app.get('/api/map-phase2b/private/driver-history',(_q,r)=>r.json({data:[{deliveryDate:'2026-09-19',vehicle:'838',driverName:'합성기사'}],meta:{complete:true,coverageComplete:false}}));
app.get('/api/map-phase2b/private/customer-detail',(_q,r)=>r.json({data:{accessInfo:'합성 검수 항목',memoState:'UNREGISTERED'}}));
app.get('/vehicle-data.js',(_q,r)=>r.type('js').send('window.VEHICLE_AREA_DATA='+JSON.stringify({vehicles:[{vehicle:'221',group:'osan'},{vehicle:'501',group:'yeongnam'},{vehicle:'502',group:'honam'}]})+';'));
app.get('/admin-features.js',(_q,r)=>r.type('js').send('window.ADMIN_FEATURES=[];'));
app.get('/api/*',(_q,r)=>r.status(404).json({error:'SYNTHETIC_ENDPOINT_NOT_IMPLEMENTED'}));
app.get(['/', '/daily-routes.html'],(_q,r)=>r.sendFile(path.join(root,'map-phase2b-preview.html')));
app.get('/:name',async(q,r)=>{
  if(!/^(map-(period|period-ui|staff|data-sync|phase2b-runtime)|phase2b-(ui-helpers|operations-ui|review-final))\.(js|css)$/.test(q.params.name))return r.sendStatus(404);
  r.type(path.extname(q.params.name)).send(await fs.readFile(path.join(root,q.params.name),'utf8'));
});
app.listen(4184,'127.0.0.1',()=>console.log('Synthetic UI fixture: http://127.0.0.1:4184'));
