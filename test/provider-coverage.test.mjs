import assert from 'node:assert/strict';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import {gridDisk,latLngToCell} from 'h3-js';
import XLSX from 'xlsx';
import {mountShadowCoverage} from '../src/shadowCoverage/routes.js';
import {PROVIDERS,providerCellsInBox,providerCoverageView,providerDigest,sameApprovedProviderLocation,sealProviderCoverage} from '../src/shadowCoverage/providerCoverage.js';
import {createProviderCoverageReader,importProviderCoverageApi,importProviderCoverageFile} from '../src/shadowCoverage/providerInput.js';

const date='2026-11-11';
const ids=gridDisk(latLngToCell(37.1,127.1,8),1);
const cell=(h3Cell,available)=>({h3Cell,scope:'H3_CELL',status:available?'AVAILABLE_CONFIRMED':'UNAVAILABLE_CONFIRMED'});
const make=(provider,records,kind='SYNTHETIC')=>sealProviderCoverage({provider,kind,records,source:'isolated fixture',asOf:date});

test('synthetic comparison covers each requested pattern and keeps an absent source outside the three-way decision',()=>{
  const patterns=[[1,1,1],[1,0,0],[0,1,0],[0,0,1],[1,1,0],[0,0,0]];
  const inputs=Object.fromEntries(PROVIDERS.map((provider,index)=>[provider,{dataset:make(provider,
    patterns.map((pattern,i)=>cell(ids[i],pattern[index])))}]));
  const result=providerCoverageView({inputs,cells:ids.slice(0,6),at:date,kind:'SYNTHETIC'});
  assert.deepEqual(result.cells.map(c=>c.overlap.status),
    ['ALL_AVAILABLE','ONE_AVAILABLE','ONE_AVAILABLE','ONE_AVAILABLE','TWO_AVAILABLE','ALL_UNAVAILABLE']);
  assert.deepEqual(result.cells.map(c=>c.overlap.available),patterns.map(pattern=>PROVIDERS.filter((_,i)=>pattern[i])));
  assert.equal(result.kind,'SYNTHETIC');
  const missing=providerCoverageView({inputs:{FRESHON:inputs.FRESHON,CJ:inputs.CJ},cells:[ids[0]],at:date,kind:'SYNTHETIC'});
  assert.equal(missing.providers.NAVER_SHOPPING.connection,'NOT_CONNECTED');
  assert.deepEqual(missing.cells[0].overlap,{status:'NOT_COMPARABLE',available:['FRESHON','CJ'],unavailable:[],unknown:['NAVER_SHOPPING']});
  const operating=providerCoverageView({inputs,cells:[ids[0]],at:date});
  assert.deepEqual(operating.cells[0].overlap.available,[]);
});

test('provider viewport includes external-only approved cells and excludes point and synthetic data',()=>{
  const inputs={CJ:{dataset:make('CJ',[cell(ids[0],true),{lat:37.1,lng:127.1,status:'AVAILABLE_CONFIRMED'}],'APPROVED')},
    NAVER_SHOPPING:{dataset:make('NAVER_SHOPPING',[cell(ids[1],true)])}};
  assert.deepEqual(providerCellsInBox(inputs,[126,36,128,38],date),{ids:[ids[0]],truncated:false});
  assert.deepEqual(providerCellsInBox(inputs,[128,36,130,38],date),{ids:[],truncated:false});
});

test('approved location binds by address or PNU while provider customer codes remain independent',()=>{
  const pnu='4111100000100000001', alternate='4111100000100000002';
  const [first,sameCode,second,otherPnu,sameAddress]=[
    make('FRESHON',[{customerCode:'0001',address:'격리시 예시로 1',pnu,matchApproved:true}]).records[0],
    make('CJ',[{customerCode:'0001',address:'격리시 예시로 2',matchApproved:true}]).records[0],
    make('CJ',[{customerCode:'0002',pnu,matchApproved:true}]).records[0],
    make('CJ',[{customerCode:'0003',pnu:alternate,address:'격리시 예시로 1',matchApproved:true}]).records[0],
    make('NAVER_SHOPPING',[{customerCode:'0004',address:'격리시  예시로 1',matchApproved:true}]).records[0]
  ];
  assert.equal(sameApprovedProviderLocation(first,sameCode),false);
  assert.equal(sameApprovedProviderLocation(first,second),true);
  assert.equal(sameApprovedProviderLocation(first,otherPnu),false);
  assert.equal(sameApprovedProviderLocation(first,sameAddress),true);
  assert.notEqual(first.provider,second.provider);
  assert.throws(()=>make('CJ',[{customerCode:'1',internalCustomerCode:'I1',pnu}]),/CUSTOMER_LINK_INVALID/);
});

test('point, postal, incomplete history and conflicting records do not assert whole-cell service',()=>{
  const id=ids[0], lat=37.1,lng=127.1;
  const point={customerCode:'001',lat,lng,status:'AVAILABLE_CONFIRMED'};
  const cj=make('CJ',[point,{postalCode:'00001',status:'UNAVAILABLE_CONFIRMED'}],'APPROVED');
  const naver=make('NAVER_SHOPPING',[cell(id,true),cell(id,false)],'APPROVED');
  const history={generation:'a'.repeat(64),start:'2026-08-14',end:date,missingDates:['2026-11-09'],unverifiedDates:[],
    byCell:new Map([[id,{status:'UNVERIFIED',candidate:true,observedVisits:0}]])};
  const result=providerCoverageView({inputs:{CJ:{dataset:cj},NAVER_SHOPPING:{dataset:naver}},freshon:history,cells:[id],at:date});
  assert.equal(result.cells[0].providers.FRESHON.status,'UNVERIFIED');
  assert.equal(result.cells[0].providers.CJ.status,'UNVERIFIED');
  assert.equal(result.cells[0].providers.CJ.pointCounts.available,1);
  assert.equal(result.cells[0].providers.NAVER_SHOPPING.status,'UNVERIFIED');
  assert.equal(result.cells[0].overlap.status,'NOT_COMPARABLE');
  const expired=make('CJ',[{...cell(id,false),validFrom:'2026-10-01',validTo:'2026-11-10'}],'APPROVED');
  assert.equal(providerCoverageView({inputs:{CJ:{dataset:expired}},cells:[id],at:date}).cells[0].providers.CJ.status,'UNVERIFIED');
});

test('bounded CSV and Excel imports retain text codes and require the approved bytes',async()=>{
  const csv=Buffer.from('customerCode,postalCode,weekdays,status\n0001,00001,"1,3",UNVERIFIED');
  const metadata={provider:'CJ',asOf:date,source:'isolated file fixture',kind:'SYNTHETIC'};
  const imported=await importProviderCoverageFile(csv,{...metadata,format:'csv',expectedSha256:providerDigest(csv)});
  assert.deepEqual([imported.records[0].customerCode,imported.records[0].postalCode,imported.records[0].weekdays],['0001','00001',[1,3]]);
  await assert.rejects(importProviderCoverageFile(csv,{...metadata,format:'csv',expectedSha256:'a'.repeat(64)}),/NOT_APPROVED/);
  const book=XLSX.utils.book_new();
  const sheet=XLSX.utils.aoa_to_sheet([['customerCode','address','validFrom','validTo','status'],
    ['0002','격리시 예시로 1',new Date('2026-11-11T00:00:00Z'),'2026-12-01','AVAILABLE_CONFIRMED']],{cellDates:true});
  XLSX.utils.book_append_sheet(book,sheet,'Coverage');
  const xlsx=XLSX.write(book,{type:'buffer',bookType:'xlsx'});
  const excel=await importProviderCoverageFile(xlsx,{...metadata,format:'xlsx',sheetName:'Coverage',expectedSha256:providerDigest(xlsx)});
  assert.deepEqual([excel.records[0].customerCode,excel.records[0].validFrom,excel.records[0].validTo],['0002',date,'2026-12-01']);
  const invalid=Buffer.from('customerCode,customerCode,unapprovedField\n0001,0002,fixture');
  await assert.rejects(importProviderCoverageFile(invalid,{...metadata,format:'csv',expectedSha256:providerDigest(invalid)}),/INPUT_COLUMNS/);
  sheet.B2.f='1+1';
  const formula=XLSX.write(book,{type:'buffer',bookType:'xlsx'});
  await assert.rejects(importProviderCoverageFile(formula,{...metadata,format:'xlsx',expectedSha256:providerDigest(formula)}),/INPUT_SHEET/);
});

test('conflicting customer effective periods are rejected while other provider generations remain independent',()=>{
  const row={customerCode:'001',pnu:'4111100000100000001',matchApproved:true,status:'AVAILABLE_CONFIRMED',validFrom:'2026-11-01',validTo:'2026-11-20'};
  const changed={...row,pnu:'4111100000100000002',validFrom:'2026-11-20',validTo:'2026-11-25'};
  const prior=make('CJ',[row]);
  assert.throws(()=>make('CJ',[row,changed]),/CUSTOMER_PERIOD_CONFLICT/);
  const good=make('CJ',[row,{...changed,validFrom:'2026-11-21'}]);
  assert.notEqual(prior.generation,good.generation);
  assert.equal(prior.records[0].pnu,row.pnu);
  assert.notEqual(prior.generation,make('NAVER_SHOPPING',[row]).generation);
});

test('approved API reads the pinned JSON endpoint without a redirect and rejects changed bytes',async()=>{
  const raw=JSON.stringify({provider:'CJ',asOf:date,records:[cell(ids[0],true)]});
  const options={provider:'CJ',asOf:date,source:'isolated API fixture',kind:'APPROVED',approvedUrl:'https://provider.invalid/export',
    expectedSha256:providerDigest(raw),async fetchImpl(url,request){
      assert.equal(url.href,'https://provider.invalid/export');
      assert.equal(request.method,'GET');
      assert.equal(request.redirect,'error');
      return new Response(raw,{headers:{'Content-Type':'application/json'}});
    }};
  const imported=await importProviderCoverageApi(options);
  assert.equal(imported.records[0].h3Cell,ids[0]);
  await assert.rejects(importProviderCoverageApi({...options,expectedSha256:'a'.repeat(64)}),/NOT_APPROVED/);
});

test('private reader rejects a pinned synthetic dataset and provider API keeps Freshon history available',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'provider-coverage-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const bytes=Buffer.from(JSON.stringify(make('CJ',[cell(ids[0],true)])));
  await fs.writeFile(path.join(root,'CJ.json'),bytes);
  const read=createProviderCoverageReader({directory:root,appRoot:process.cwd(),expected:{CJ:providerDigest(bytes)}});
  assert.equal((await read()).CJ.state,'UNVERIFIED');
  assert.equal((await read()).NAVER_SHOPPING.state,'NOT_CONNECTED');
  const accepted=Buffer.from(JSON.stringify(make('CJ',[cell(ids[0],true)],'APPROVED')));
  await fs.writeFile(path.join(root,'CJ.json'),accepted);
  const pinned=createProviderCoverageReader({directory:root,appRoot:process.cwd(),expected:{CJ:providerDigest(accepted)}});
  assert.equal((await pinned()).CJ.dataset.records[0].status,'AVAILABLE_CONFIRMED');
  const app=express();
  const id=ids[0], digest='b'.repeat(64);
  let freshonUnavailable=false;
  let useApprovedFixture=false;
  mountShadowCoverage({app,requireStaff(req,res,next){return req.get('x-staff-fixture')==='1'?next():res.sendStatus(401);},
    readProviderCoverage:()=>useApprovedFixture?pinned():{},
    store:{async readPeriod(){
      if(freshonUnavailable)throw Error('COVERAGE_DATA_UNAVAILABLE');
      return {index:{kind:'OBSERVED',sha256:digest},window:{start:'2026-08-14',end:date}};
    },
      viewFor(){return {evidence:{missingDates:['2026-11-10'],unverifiedDates:[]},
        groups:new Map([[id,{visits:0,status:'CANDIDATE'}]])};}}});
  const server=app.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const url='http://127.0.0.1:'+server.address().port+'/api/map-phase2b/private/shadow-coverage/provider-overlap?cells='+id;
  assert.equal((await fetch(url)).status,401);
  const response=await fetch(url,{headers:{'x-staff-fixture':'1'}});
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  const {data}=await response.json();
  assert.equal(data.providers.FRESHON.generation,digest);
  assert.equal(data.providers.CJ.connection,'NOT_CONNECTED');
  assert.equal(data.providers.NAVER_SHOPPING.connection,'NOT_CONNECTED');
  assert.equal(data.cells[0].providers.FRESHON.history.candidate,true);
  assert.equal(data.cells[0].providers.FRESHON.status,'UNVERIFIED');
  freshonUnavailable=true;
  useApprovedFixture=true;
  const independent=await fetch(url+'&at='+date,{headers:{'x-staff-fixture':'1'}});
  assert.equal(independent.status,200);
  const result=(await independent.json()).data;
  assert.equal(result.providers.FRESHON.connection,'UNVERIFIED');
  assert.equal(result.cells[0].providers.CJ.status,'AVAILABLE_CONFIRMED');
  assert.equal(result.cells[0].overlap.status,'NOT_COMPARABLE');
});
