// Loopback-only synthetic UI harness. No live credentials, collector, or files written.
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMapStaffAuth, createStaffPasswordHash } from '../src/mapStaffAuth.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public');
const app=express(),date='2026-08-28';
const rows=Array.from({length:27},(_,i)=>({customerCode:'S'+(900000+i),customerName:'합성 테스트 매장 '+(i+1),address:'합성 테스트 주소 '+(i+1),vehicle:'101',
 lat:37.15+(i%5)*.004,lng:127.04+Math.floor(i/5)*.004,deliveryDate:date,lastDeliveryDate:date,
 history:[{deliveryDate:'2026-08-11',vehicle:'101',driverKey:'TEST_DRIVER_A',driverName:'합성기사 A',driverIdentity:'NAME_CONTACT',kind:'ASSIGNED'},
 {deliveryDate:date,vehicle:i===0?'202':'101',driverKey:'TEST_DRIVER_A',driverName:'합성기사 A',driverIdentity:'NAME_CONTACT',kind:'ASSIGNED'}]}));
const snapshot={ok:true,data:rows,meta:{latestDate:date,startDate:'2026-06-30',stale:false,complete:true}};
const password='SYNTHETIC-browser-only-credential';
const auth=createMapStaffAuth({env:{MAP_STAFF_ID:'fixture',MAP_STAFF_PASSWORD_HASH:await createStaffPasswordHash(password),MAP_STAFF_SESSION_SECRET:'s'.repeat(43),RENDER_EXTERNAL_URL:'https://fixture.invalid'}});
app.use('/api/map-phase2b/auth',(req,_res,next)=>{if(req.get('origin')==='http://localhost:8787') req.headers.origin='https://fixture.invalid';next();},auth.router);
app.get('/api/map-phase2b/private/customer-detail',auth.requireStaff,(_req,res)=>res.json({ok:true,data:{memoState:'REGISTERED',accessInfo:'합성 후문',password:'SYNTHETIC_ONLY',specialRemark:'합성 냉장 안내'}}));
app.get('/api/map-phase2b/private/driver-history',auth.requireStaff,(_req,res)=>res.json({ok:true,data:[{deliveryDate:date,vehicle:'101',driverName:'합성기사 A',driverPhone:'SYNTHETIC_CONTACT',kind:'ASSIGNED'}]}));
app.get('/api/map-phase2b/preview/snapshot',(_req,res)=>res.json(snapshot));
app.get('/api/map-phase2b/preview/period',(req,res)=>res.json({...snapshot,meta:{complete:true,phase:'DONE',count:54,startDate:req.query.startDate,endDate:req.query.endDate,missingCoordinate:0}}));
app.get('/api/map-phase2b/preview/detail',(req,res)=>{const r=rows.find(x=>x.customerCode===req.query.customerCode);res.json({ok:true,data:r?Object.fromEntries(['customerCode','customerName','address','vehicle','status'].map(k=>[k,r[k]||null])):null});});
app.get('/api/map-phase2b/preview/search',(_req,res)=>res.json({ok:true,data:rows}));
app.get('/api/map-phase2b/preview/assignments',(req,res)=>res.json({ok:true,data:rows.map(row=>({...row,deliveryDate:req.query.date})),meta:{complete:true,date:req.query.date}}));
app.get('/api/map-phase2b/preview/route-plan',(req,res)=>res.json({ok:true,data:{date:req.query.date,vehicle:'101',totalStops:27,completedStops:10,remainingStops:17,stops:rows.map((r,i)=>({...r,order:i+1,status:i<10?'COMPLETED':'PENDING',actualCompletedAt:i<10?'2026-08-11T00:30:00Z':null}))}}));
app.get('/api/map-phase2b/preview/status',(_q,res)=>res.json({snapshot:{latest:date,targetLatest:date,stale:false}}));
app.get('/vehicle-data.js',(_req,res)=>res.type('js').send('window.VEHICLE_AREA_DATA='+JSON.stringify({vehicles:[{vehicle:'101',group:'osan',customers:[]},{vehicle:'202',group:'osan',customers:[]}]})));
app.get('/admin-features.js',(_req,res)=>res.type('js').send('window.ADMIN_FEATURES=[];'));
app.get('/__fixture/kakao.js',(_req,res)=>res.type('js').send(`
class LatLng {constructor(lat,lng){this.lat=lat;this.lng=lng}getLat(){return this.lat}getLng(){return this.lng}}
class Bounds {constructor(){this.rows=[]}extend(p){this.rows.push(p)}getSouthWest(){return new LatLng(33,124)}getNorthEast(){return new LatLng(39,132)}}
class MapView{constructor(el,o){this.el=el;this.center=o.center;this.level=o.level;this.handlers={};el.style.background='#e9eef1'}getLevel(){return this.level}setLevel(v){this.level=v}getCenter(){return this.center}setCenter(v){this.center=v}panTo(v){this.center=v}relayout(){}getBounds(){return new Bounds}setBounds(){}getProjection(){return{containerPointFromCoords:p=>({x:250+(p.lng-127.04)*3000,y:220+(p.lat-37.15)*3000})}}}
class Overlay{constructor(o){this.o=o;this.el=o.content}setMap(m){if(!this.el)return;if(!m){this.el.remove();return}this.el.style.position='absolute';this.el.style.left=(200+(this.o.position.lng-127.04)*3000)+'px';this.el.style.top=(130+(this.o.position.lat-37.15)*3000)+'px';m.el.append(this.el)}}
class Shape{setMap(){}}
window.kakao={maps:{load:fn=>fn(),Map:MapView,LatLng,LatLngBounds:Bounds,CustomOverlay:Overlay,Polygon:Shape,Polyline:Shape,event:{addListener:(m,n,fn)=>{m.handlers[n]=fn}},services:{Status:{OK:'OK'},Geocoder:class{addressSearch(q,cb){cb([{y:'37.15',x:'127.04',address_name:q,road_address:{address_name:q}}],'OK')}},Places:class{}}}};
`));
app.get('/map-phase2b-preview.html',async(_req,res)=>{
 let html=await fs.readFile(path.join(root,'map-phase2b-preview.html'),'utf8');
 html=html.replace(/https:\/\/dapi\.kakao\.com[^"]+/,'/__fixture/kakao.js').replace(/<script src="https:\/\/cdn\.jsdelivr[^<]+<\/script>/,'');
 res.type('html').send(html);
});
app.use(express.static(root));
app.listen(8787,'127.0.0.1',()=>console.log('SYNTHETIC_REVIEW_READY localhost:8787'));
