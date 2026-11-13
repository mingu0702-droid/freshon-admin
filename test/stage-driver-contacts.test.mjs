import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import test from 'node:test';
import express from 'express';
import {createStageDriverContacts} from '../src/stageDriverContacts.js';
import {createStageDatedDeliveryReader} from '../src/stageDatedDelivery.js';
import {deliveryTaskId} from '../src/datedDeliveryContract.js';
import {STAGE_ORIGIN, STAGE_SERVICE} from '../src/stageScope.js';

const now = () => Date.parse('2026-11-14T03:00:00Z');
const current = '2026-11-14';
const past = '2026-11-11';
const {privateKey} = generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},
  publicKeyEncoding:{type:'spki',format:'pem'}});
const config = {
  RENDER_EXTERNAL_URL:STAGE_ORIGIN, RENDER_SERVICE_ID:STAGE_SERVICE,
  OPSMAP_DRIVER_CONTACT_ENABLED:'1', OPSMAP_STAGE_DRIVER_CONTACT_APPROVED:'1',
  OPSMAP_STAGE_DRIVER_SHEET_ID:'fixture_sheet_identifier', OPSMAP_STAGE_DRIVER_SHEET_GID:'7', OPSMAP_STAGE_DRIVER_SHEET_CENTER:'osan',
  OPSMAP_STAGE_DRIVER_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64:Buffer.from(JSON.stringify({type:'service_account',
    client_email:'fixture@synthetic-stage.iam.gserviceaccount.com',private_key:privateKey})).toString('base64')
};
const vehicleByCode = {'S101':'101','S122':'122','S202':'202','S203':'203','S999':'101'};
const baseReader = async codes => ({ok:true,data:codes.map(customerCode=>({customerCode,baseVehicle:vehicleByCode[customerCode],
  baseVehicleState:'VERIFIED_MASTER',baseVehicleGroup:customerCode==='S999'?'yeongnam':'osan',
  baseVehicleSource:'FIXED_DISPATCH_PRIMARY',baseVehicleVersion:'f'.repeat(64),baseVehicleCheckedAt:current,baseVehicleStale:false}))});
const contactQuery = (code, vehicle, extra = {}) => new URLSearchParams({customerCode:code,vehicle,date:current,context:'BASE',...extra});
const access = {headers:{'x-fixture-employee':'1'}};
const phone = '010-0000-0000';
const syntheticValues = [
  ['호차','기사명','연락처','적용일'],
  ['101','테스트기사하나',phone,'2026-11-01'],
  ['122','테스트기사둘','','2026-11-01']
];

async function useHttp(t, options, dependencies) {
  const reader = createStageDriverContacts({now,...options});
  const app=express();
  reader.mount({app,requireStaff(req,res,next) {
    if (req.headers['x-fixture-employee'] !== '1') return res.status(401).json({error:'STAFF_LOGIN_REQUIRED'});
    next();
  }},dependencies);
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const origin='http://127.0.0.1:'+server.address().port;
  return {reader,origin,read:(query,employee=access)=>fetch(origin+'/api/map-phase2b/private/driver-contact?'+query,employee)};
}

function googleSource(requests, values = syntheticValues) {
  return (input, options) => {
    const url = new URL(input);
    requests.push([url.host,url.pathname]);
    assert.equal(options.redirect,'error');
    assert.equal(options.cache,'no-store');
    assert(options.signal instanceof AbortSignal);
    if (url.host === 'oauth2.googleapis.com') {
      assert.equal(options.method,'POST');
      const claim=JSON.parse(Buffer.from(options.body.get('assertion').split('.')[1],'base64url'));
      assert.equal(claim.scope,'https://www.googleapis.com/auth/spreadsheets.readonly');
      return Response.json({access_token:'fixture-access'});
    }
    assert.equal(url.host,'sheets.googleapis.com');
    assert.equal(options.headers.Authorization,'Bearer fixture-access');
    if (url.searchParams.has('fields')) {
      return Response.json({sheets:[{properties:{sheetId:8,title:'Not approved'}},{properties:{sheetId:7,title:"Driver's contacts"}}]});
    }
    assert.match(decodeURIComponent(url.pathname), /\/values\/'Driver''s contacts'!A1:S1001$/);
    return Response.json({values});
  };
}

test('Stage requires separate approval and credentials and does not reach a source when blocked', async t => {
  let reads = 0;
  const baseEnv={...config,OPSMAP_STAGE_DRIVER_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64:undefined,
    GOOGLE_SERVICE_ACCOUNT_JSON_BASE64:config.OPSMAP_STAGE_DRIVER_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64};
  for (const [env,code] of [[baseEnv,'DRIVER_CREDENTIALS_MISSING'],
    [{...config,OPSMAP_STAGE_DRIVER_CONTACT_APPROVED:'0'},'DRIVER_CONTACT_DISABLED'],
    [{...config,RENDER_SERVICE_ID:'fixture-other-service'},'DRIVER_CONTACT_DISABLED']]) {
    const endpoint=await useHttp(t,{env,fetchImpl:()=>{reads++;}}, {readBaseVehicles:baseReader});
    assert.equal(endpoint.reader.configured,false);
    const anon = await endpoint.read(contactQuery('S101','101'),{});
    assert.equal(anon.status,401);
    const response=await endpoint.read(contactQuery('S101','101'));
    assert.equal(response.status,503);
    assert.equal((await response.json()).error,code);
  }
  assert.equal(reads,0);
});

test('current Stage contacts prove the customer and center, merge reads, and distinguish absent contact fields', async t => {
  const requests = [];
  const endpoint=await useHttp(t,{env:config,fetchImpl:googleSource(requests)},{readBaseVehicles:baseReader});
  assert.equal(endpoint.reader.configured,true);
  const wrongCenter=await endpoint.read(contactQuery('S999','101'));
  assert.equal(wrongCenter.status,503);
  assert.equal((await wrongCenter.json()).error,'DRIVER_CENTER_SOURCE_UNVERIFIED');
  const wrongVehicle=await endpoint.read(contactQuery('S101','202'));
  assert.equal(wrongVehicle.status,409);
  assert.equal(requests.length,0);
  const results=await Promise.all(['101','122','202'].map(async vehicle=>{
    const response=await endpoint.read(contactQuery('S'+vehicle,vehicle));
    assert.equal(response.status,200);
    assert.equal(response.headers.get('cache-control'),'private, no-store');
    return response.json();
  }));
  assert.deepEqual(results.map(result=>result.meta.state),['REGISTERED','PHONE_UNREGISTERED','UNREGISTERED']);
  assert.deepEqual(results.map(result=>!!result.data.phone),[true,false,false]);
  const list = await fetch(endpoint.origin+'/api/vehicle-driver-master?date='+current+'&center=osan',access);
  assert.equal(list.status,200);
  assert.deepEqual((await list.json()).vehicles.map(row=>[row.vehicle,Object.hasOwn(row,'phone')]),[['101',false],['122',false]]);
  assert.equal(requests.length,3);
});

test('a verified vehicle registration fills only a matching contact and flags disagreement', async t => {
  const seen=[];
  const endpoint=await useHttp(t,{env:config,fetchImpl:googleSource([])},{readBaseVehicles:baseReader,
    async readVerifiedVehicleRegistration(identity) {
      seen.push(identity);
      const {vehicle}=identity;
      return {...identity,verified:vehicle!=='203',source:'FRESHON_VEHICLE_REGISTRATION',
        driverName:vehicle==='101'?'다른 합성 기사':vehicle==='122'?'테스트기사둘':'등록 합성 기사',phone};
    }});
  const conflict=await endpoint.read(contactQuery('S101','101'));
  assert.equal(conflict.status,409);
  assert.deepEqual(await conflict.json(),{ok:false,error:'DRIVER_SOURCE_CONFLICT'});
  for(const vehicle of ['122','202']){
    const response=await endpoint.read(contactQuery('S'+vehicle,vehicle));
    const result=await response.json();
    assert.equal(response.status,200);
    assert.equal(result.data.phone,phone);
    assert.equal(result.meta.source,'FRESHON_VEHICLE_REGISTRATION');
  }
  const unverified=await endpoint.read(contactQuery('S203','203'));
  assert.equal((await unverified.json()).meta.state,'UNREGISTERED');
  assert.deepEqual(seen.map(v=>v.vehicle),['101','122','202','203']);
  assert(seen.every(v=>v.center==='osan'&&v.date===current));
});

test('the dated reader opens one exact, observed task and rejects mismatches before releasing contacts', async t => {
  const task = {id:32,enteringDatedAt:past,customer:{erpCode:'S101'},carrier:{fixedNo:'101'},status:'COMPLETED',logisticsCenterId:1};
  let detail = {...task,driverName:'테스트현장기사',driverPhone:phone};
  let detailsRead = 0;
  const google = [];
  const read = createStageDatedDeliveryReader({now,env:{...config,OPSMAP_STAGE_DELIVERY_DATED_ENABLED:'1',
    OPSMAP_STAGE_DELIVERY_DATED_COOKIE:'synthetic=stage-only'}, fetchImpl(input,options) {
    const url = new URL(input);
    assert.equal(url.hostname,'delivery-bali.chabyulhwa.com');
    assert.equal(options.method,'GET');
    if (url.pathname === '/api/bali/task') return Response.json({content:[task],totalElements:1,totalPages:1});
    assert.equal(url.pathname,'/api/bali/task/32');
    detailsRead++;
    return Response.json({data:detail});
  }});
  const endpoint = await useHttp(t,{env:config,fetchImpl:googleSource(google)},{readBaseVehicles:baseReader,
    readDatedAssignment:read.readDriverAssignment});
  const extra = {date:past,context:'DATE_ROUTE',center:'osan',deliveryId:deliveryTaskId(task.id)};
  const noVerifiedRoster = await endpoint.read(contactQuery('S101','101',extra));
  assert.equal(noVerifiedRoster.status,503);
  assert.equal(detailsRead,0);
  const roster=await read.readContract(past,'osan');
  assert.equal(roster.rows[0].deliveryId,extra.deliveryId);
  const wrong = await endpoint.read(contactQuery('S122','101',extra));
  assert.equal(wrong.status,409);
  assert.equal(detailsRead,0);
  const exact = await endpoint.read(contactQuery('S101','101',extra));
  assert.equal(exact.status,200);
  const body=await exact.json();
  assert.equal(body.meta.deliveryId,extra.deliveryId);
  assert.equal(body.meta.phoneBasis,'DATED_ASSIGNMENT');
  assert.equal(body.data.driverName,detail.driverName);
  assert.equal(body.data.phone,phone);
  assert.equal(detailsRead,1);
  assert(!JSON.stringify(await read.readContract(past,'osan')).includes(phone));
  detail={...detail,driver:{name:'테스트다른기사'}};
  const conflicting=await endpoint.read(contactQuery('S101','101',extra));
  assert.equal(conflicting.status,409);
  assert.equal((await conflicting.json()).error,'DRIVER_ASSIGNMENT_CONFLICT');
  detail={...task};
  const unknown=await endpoint.read(contactQuery('S101','101',extra));
  assert.equal(unknown.status,200);
  assert.deepEqual((await unknown.json()).data,{driverName:null,phone:null});
  assert.equal(google.length,0);
});

test('a failed sheet request never becomes an empty result or reveals upstream text', async t => {
  const requests = [];
  const fetchGoogle=googleSource(requests);
  const endpoint=await useHttp(t,{env:config,fetchImpl:(url,options)=>new URL(url).pathname.includes('/values/')
    ? new Response('synthetic sensitive upstream body',{status:403}) : fetchGoogle(url,options)},{readBaseVehicles:baseReader});
  for (let attempt=0;attempt<2;attempt++) {
    const response=await endpoint.read(contactQuery('S101','101'));
    assert.equal(response.status,503);
    assert.deepEqual(await response.json(),{ok:false,error:'DRIVER_SHEET_VALUES_HTTP_403'});
  }
  assert.equal(requests.length,2);
});
