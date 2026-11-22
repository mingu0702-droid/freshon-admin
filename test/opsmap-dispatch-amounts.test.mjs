import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import test from 'node:test';
import {createOpsmapDispatchAmountsReader} from '../src/opsmapDispatchAmounts.js';
import {STAGE_ORIGIN, STAGE_SERVICE} from '../src/stageScope.js';

const {privateKey} = generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},
  publicKeyEncoding:{type:'spki',format:'pem'}});
const now = () => Date.parse('2026-11-22T15:25:00Z');
const date = '2026-11-23';
const noAmounts = date => ({date,observedAt:null,state:'UNAVAILABLE',vehicles:[]});
const fixtureEnv = {
  RENDER_EXTERNAL_URL:STAGE_ORIGIN, RENDER_SERVICE_ID:STAGE_SERVICE,
  OPSMAP_STAGE_WMS_AMOUNTS_APPROVED:'1',OPSMAP_STAGE_WMS_AMOUNTS_SHEET_ID:'fixture_workbook_0001',
  OPSMAP_STAGE_DRIVER_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64:Buffer.from(JSON.stringify({type:'service_account',
    client_email:'test@test.iam.gserviceaccount.com',private_key:privateKey})).toString('base64')
};

function amountSheet() {
  const values = Array.from({length:17},()=>[]);
  values[0]=['11월 23일(월) WMS 매출 현황 · 이전 결과'];
  values[1]=['조회 배송일 2026-11-23 · 완료'];
  values[2]=['센터','최종 매출','성공 시각','조회 상태'];
  values[3]=['오산',1700,46348.70883523148,'조회 성공'];
  values[13]=['WMS 원본 호차','매출 금액','경유지수','센터'];
  values[14]=['101',1500,5,'오산'];
  values[15]=['미배정',200,1,'오산'];
  values[16]=['101',9000,8,'영남'];
  return values;
}

function fixture(values, env=fixtureEnv) {
  const calls=[];
  const read=createOpsmapDispatchAmountsReader({env,now,async fetchImpl(url,options){
    const parsed=new URL(url);
    calls.push([parsed.host,options.method??'GET']);
    assert.equal(options.redirect,'error');
    if (parsed.host==='oauth2.googleapis.com') {
      assert.equal(parsed.pathname,'/token');
      const [,data]=options.body.get('assertion').split('.');
      const claims=JSON.parse(Buffer.from(data,'base64url'));
      assert.equal(claims.scope,'https://www.googleapis.com/auth/spreadsheets.readonly');
      return Response.json({access_token:'fixture_token'});
    }
    assert.equal(parsed.host,'sheets.googleapis.com');
    assert.equal(decodeURIComponent(parsed.pathname),"/v4/spreadsheets/fixture_workbook_0001/values/'금액정보'!A6:D1000");
    assert.equal(parsed.searchParams.get('valueRenderOption'),'UNFORMATTED_VALUE');
    assert.equal(options.headers.Authorization,'Bearer fixture_token');
    return Response.json({values});
  }});
  return {read,calls};
}

test('only the selected successful Osan date returns allowlisted cache amounts and the recorded KST observation',async()=>{
  const {read,calls}=fixture(amountSheet());
  const [selected,other]=await Promise.all([read(date),read('2026-11-24')]);
  assert.deepEqual(other,noAmounts('2026-11-24'));
  assert.deepEqual(selected,{date,observedAt:'2026-11-22T08:00:43.364Z',state:'VERIFIED',vehicles:[
    {vehicle:'101',amount:1500,routeCode:null,detailState:'UNAVAILABLE'},
    {vehicle:'미배정',amount:200,routeCode:null,detailState:'UNAVAILABLE'}]});
  assert.deepEqual(calls,[['oauth2.googleapis.com','POST'],['sheets.googleapis.com','GET']]);
});

test('partial, duplicate, failed and future-observed rows never enter the employee amount view',async()=>{
  for (const damage of [
    values=>values.pop() && values.pop(),
    values=>values[15][0]='0101',
    values=>values[3][3]='실패',
    values=>values[3][2]+=1,
    values=>values[1][0]='조회 배송일 2026-11-23 · 진행 중',
    values=>values[14][1]='1,500원'
  ]) {
    const values=amountSheet();
    damage(values);
    assert.deepEqual(await fixture(values).read(date),noAmounts(date));
  }
});

test('missing Stage scope and invalid dates make no outbound requests',async()=>{
  for (const env of [{...fixtureEnv,RENDER_SERVICE_ID:'different'}, {...fixtureEnv,OPSMAP_STAGE_WMS_AMOUNTS_APPROVED:''}]) {
    const {read,calls}=fixture(amountSheet(),env);
    assert.deepEqual(await read(date),noAmounts(date));
    assert.deepEqual(calls,[]);
  }
  const {read,calls}=fixture(amountSheet());
  assert.deepEqual(await read('2026-11-99'),noAmounts('2026-11-99'));
  assert.deepEqual(calls,[]);
});

// Existing editable document IDs are passed by a local audit and kept out of Git.
const editableWorkbookIds = process.env.OPSMAP_TEST_EDITABLE_WORKBOOK_IDS?.split(',');
test('known publicly editable workbooks never trigger OAuth or a sheet read',{
  skip:!editableWorkbookIds
},async()=>{
  assert.equal(editableWorkbookIds.length,2);
  for (const id of editableWorkbookIds) {
    const {read,calls}=fixture(amountSheet(),{...fixtureEnv,OPSMAP_STAGE_WMS_AMOUNTS_SHEET_ID:id});
    assert.deepEqual(await read(date),noAmounts(date));
    assert.deepEqual(calls,[]);
  }
});
