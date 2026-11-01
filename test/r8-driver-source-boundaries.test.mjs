import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';

// Extract actual server functions without starting collectors, HTTP listeners or source requests.
const localServer = fileURLToPath(new URL('../src/server.js', import.meta.url));
const serverFile = process.env.OPSMAP_DRIVER_SERVER_SOURCE || localServer;
const source = fs.readFileSync(serverFile, 'utf8');
function extract(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `Missing server function ${name}`);
  const rest = source.slice(start), end = /\r?\n}\r?\n/.exec(rest);
  assert.ok(end, `Missing function end ${name}`);
  return rest.slice(0, end.index + end[0].length);
}
const functions = ['base64Url', 'parseGoogleServiceAccount', 'getGoogleAccessToken', 'getGoogleSheetTab', 'readRowsFromGoogleSheet'].map(extract).join('\n');
const marker = 'SYNTHETIC_RESPONSE_MUST_NOT_ESCAPE';
const account = Buffer.from(JSON.stringify({client_email:'reader@example.invalid',private_key:'synthetic-signing-placeholder'})).toString('base64');
const goodMetadata = {sheets:[{properties:{title:'Synthetic Contacts',sheetId:7}}]};
const jsonResponse = (status, body) => ({ok:status >= 200 && status < 300,status,json:async()=>body});
function harness(responses, overrides={}) {
  const requests = [], timeoutLimits = [];
  const config = {googleServiceAccountJsonBase64:account,googleSheetId:'',...overrides};
  const context = vm.createContext({config,Buffer,URLSearchParams,Date,
    AbortSignal:{timeout:ms=>{timeoutLimits.push(ms);return AbortSignal.timeout(ms);}},
    crypto:{createSign:()=>({update:()=>({sign:()=> 'synthetic-signature'})})},
    parseDriverSheetValues:()=>({columns:[],rows:[],meta:{activeBlocks:4,excludedTerminationSection:true}}),
    normalizeCell:value=>String(value ?? ''),
    fetch:async(url,options)=>{
      requests.push({url,options});
      assert.ok(responses.length, 'Unexpected extra source request');
      const response=responses.shift();
      if(response instanceof Error)throw response;
      return response;
    }});
  vm.runInContext(`let googleDriverMemoryCache=null; ${functions}; globalThis.read=readRowsFromGoogleSheet;`,context);
  return {requests,timeoutLimits,read:()=>context.read({spreadsheetId:'synthetic-driver-sheet',sheetGid:7,cacheKey:'driver'})};
}
const token = () => jsonResponse(200,{access_token:'synthetic-access-token'});
const metadata = () => jsonResponse(200,goodMetadata);

test('driver source works with credential and driver sheet only; readonly OAuth, bounded signals and active range',async()=>{
  const h=harness([token(),metadata(),jsonResponse(200,{values:[]})]);
  const result=await h.read();
  assert.equal(result.sheetName,'Synthetic Contacts');
  assert.equal(h.requests.length,3);
  const assertion=h.requests[0].options.body.get('assertion');
  const claim=JSON.parse(Buffer.from(assertion.split('.')[1],'base64url'));
  assert.equal(claim.scope,'https://www.googleapis.com/auth/spreadsheets.readonly');
  assert.ok(h.requests.every(request=>request.options.signal instanceof AbortSignal));
  assert.deepEqual(h.timeoutLimits,[15000,15000,15000]);
  assert.match(decodeURIComponent(h.requests[2].url),/Synthetic Contacts!A1:S1001/);
});

test('OAuth 401 remains a safe numeric code through the real private route',async()=>{
  const h=harness([jsonResponse(401,{error_description:marker})]);
  const {mountPrivateDriverContact}=await import(pathToFileURL(path.join(path.dirname(serverFile),'privateDriverContact.js')).href);
  let handler;
  mountPrivateDriverContact({app:{get:(_url,_auth,last)=>{handler=last;}},requireStaff:(_req,_res,next)=>next(),
    readAssignment:async()=>({vehicle:'101'}),readDriverMaster:()=>h.read()});
  let status=200,payload;
  const res={set(){return this;},status(value){status=value;return this;},json(value){payload=value;return this;}};
  await handler({query:{customerCode:'S900000001',vehicle:'101',date:'2026-11-02',context:'BASE'}},res);
  assert.equal(status,503);
  assert.equal(payload.error,'DRIVER_TOKEN_HTTP_401');
  assert.ok(!JSON.stringify(payload).includes(marker));
  assert.equal(h.requests.length,1);
});

test('values 403 preserves status without reading or exposing response body',async()=>{
  let bodyRead=false;
  const h=harness([token(),metadata(),{ok:false,status:403,json:async()=>{bodyRead=true;return {error:{message:marker}};}}]);
  await assert.rejects(h.read(),error=>error.code==='DRIVER_SHEET_VALUES_HTTP_403' && error.message==='DRIVER_SHEET_VALUES_HTTP_403');
  assert.equal(bodyRead,false);
  assert.equal(h.requests.length,3);
});

test('metadata 403 stops before source values and preserves numeric code',async()=>{
  const h=harness([token(),jsonResponse(403,{error:{message:marker}})]);
  await assert.rejects(h.read(),error=>error.code==='DRIVER_SHEET_METADATA_HTTP_403' && !error.message.includes(marker));
  assert.equal(h.requests.length,2);
});

test('invalid values JSON is a distinct safe failure',async()=>{
  const h=harness([token(),metadata(),{ok:true,status:200,json:async()=>{throw Error(marker);}}]);
  await assert.rejects(h.read(),error=>error.code==='DRIVER_SHEET_JSON_INVALID' && !error.message.includes(marker));
});

test('missing requested driver tab cannot silently substitute another tab',async()=>{
  const h=harness([token(),jsonResponse(200,{sheets:[{properties:{title:'Other synthetic tab',sheetId:8}}]})]);
  await assert.rejects(h.read(),error=>error.code==='DRIVER_SHEET_TAB_NOT_FOUND');
  assert.equal(h.requests.length,2);
});

test('missing credential blocks before any external request',async()=>{
  const h=harness([],{googleServiceAccountJsonBase64:''});
  await assert.rejects(h.read(),error=>error.code==='DRIVER_CREDENTIALS_MISSING');
  assert.equal(h.requests.length,0);
});

test('real generic driver route returns safe 503 and remains alive for health and repeated reads',async()=>{
  const express=createRequire(serverFile)('express');
  const app=express();
  const start=source.indexOf('app.get("/api/vehicle-driver-master",');
  assert.ok(start>=0,'Missing existing generic driver route');
  const end=source.indexOf('\n});',start);
  assert.ok(end>=start,'Missing route terminator');
  vm.runInNewContext(source.slice(start,end+'\n});'.length),{
    app,requireView:(_req,_res,next)=>next(),
    readDriverMasterFromGoogleSheet:async()=>{throw Object.assign(Error(marker),{code:'DRIVER_CREDENTIALS_MISSING'});}
  });
  app.get('/health',(_req,res)=>res.json({ok:true}));
  const server=await new Promise(resolve=>{const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));});
  const origin=`http://127.0.0.1:${server.address().port}`;
  try {
    for(let attempt=0;attempt<2;attempt++){
      const response=await fetch(`${origin}/api/vehicle-driver-master?date=2026-11-02`);
      assert.equal(response.status,503);
      assert.equal(response.headers.get('cache-control'),'private, no-store');
      const body=await response.text();
      assert.deepEqual(JSON.parse(body),{ok:false,error:'DRIVER_CREDENTIALS_MISSING'});
      assert.ok(!body.includes(marker));
      const health=await fetch(`${origin}/health`);
      assert.equal(health.status,200);
      assert.deepEqual(await health.json(),{ok:true});
    }
  } finally {server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
