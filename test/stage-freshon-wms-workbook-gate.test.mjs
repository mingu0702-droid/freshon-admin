import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import XLSX from 'xlsx';
import {STAGE_ORIGIN,STAGE_SERVICE} from '../src/stageScope.js';
import {readStageFreshonWmsWorkbookEvidence,verifyStageFreshonWmsDispatchWorkbook,
  publishStageFreshonWmsDispatchWorkbook} from '../src/stageFreshonWmsWorkbookGate.js';

const date='2026-11-24', observedAt='2026-11-23T14:08:19.582Z';
const env={RENDER_SERVICE_ID:STAGE_SERVICE,RENDER_EXTERNAL_URL:STAGE_ORIGIN,
  OPSMAP_STAGE_WMS_DISPATCH_EXPORT_APPROVED:'1',OPSMAP_STAGE_WMS_DISPATCH_EXPORT_ARCHIVE_REF:'a'.repeat(40),
  OPSMAP_STAGE_WMS_FRESHON_VALIDATION_APPROVED:'1'};
const line=(confirmCarSeq,carSeq,estCd,maechul)=>({stockDate:'20261124',confirmCarSeq,carSeq,estCd,maechul,
  baesongCnt:1,totalCnt:3,isSum:false,logCd:'011'});
const subtotal=(maechul,baesongCnt)=>({stockDate:'',confirmCarSeq:'',estCd:'',maechul,baesongCnt,totalCnt:0,isSum:false});
const fixture=()=>({data:[line('101','105','S1','1,200.00'),line('101','106','S1',-300),subtotal(900,2),line('','102','S2',-15),subtotal(-15,1)]});
function workbook(base='106') {
  const rows=[
    ['입고요청일','확정호차','고객','매출금액','배송건수','고객주소','고객명','기준호차'],
    ['20261124','101','S1',1200,1,'경기도 오산시 합성로 10','합성 매장','105'],
    ['20261124','101','S1',-300,1,'경기도 오산시 합성로 10','합성 매장',base],
    ['','소계','',900,2],
    ['20261124','','S2',-15,1,'경기도 오산시 합성로 11','합성 매장2','102'],
    ['','','',-15,1],
    ['합계','','',885,3],
  ];
  const x=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(x,XLSX.utils.aoa_to_sheet(rows),'Dispatch');
  return XLSX.write(x,{type:'buffer',bookType:'xlsx'});
}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=(payload=fixture(),scope=env)=>readStageFreshonWmsWorkbookEvidence({date,env:scope,readJson:async()=>payload});
const code=name=>({code:'WMS_EXPORT_FRESHON_'+name});

test('a Stage-only call is scoped once to the observed, counted Osan day; proof keeps details private',async()=>{
  let called=0;
  const transport=async(url,options)=>{
    called++;
    assert.equal(url,'https://mis.freshon.co.kr/bo/wm/dispatch/baecha_list');
    assert.equal(options.method,'POST');
    assert.equal(options.redirect,'error');
    const p=new URLSearchParams(options.body);
    assert.equal(p.get('page'),'0');assert.equal(p.get('size'),'3000');
    assert.equal(p.get('isCount'),'true');assert.equal(p.get('excelFileNm'),'baecha_list');
    assert.equal(p.get('calStartDate'),date);assert.equal(p.get('calEndDate'),date);
    assert.equal(p.get('logCd'),'011');assert.equal(p.get('baecha'),'2');assert.equal(p.get('shipGbn'),'1');
    return fixture();
  };
  for(const unavailable of [{...env,RENDER_SERVICE_ID:'other'},{...env,OPSMAP_STAGE_WMS_FRESHON_VALIDATION_APPROVED:'0'}]){
    await assert.rejects(readStageFreshonWmsWorkbookEvidence({date,env:unavailable,readJson:transport}),code('SCOPE'));
  }
  assert.equal(called,0);
  const evidence=await readStageFreshonWmsWorkbookEvidence({date,env,readJson:transport});
  assert.equal(called,1);
  assert.deepEqual(evidence,{source:'FRESHON_BAECHA_JSON',date,warehouse:'011',detailRows:3,routes:2,total:885,deliveryCount:3});
  const bytes=workbook(),sha256=hash(bytes);
  const proof=verifyStageFreshonWmsDispatchWorkbook({evidence,bytes,date,observedAt,sha256,env});
  assert.equal(proof.state,'VERIFIED_SOURCE_WORKBOOK');
  assert.equal(proof.total,885);
  assert.throws(()=>verifyStageFreshonWmsDispatchWorkbook({evidence:{...evidence},bytes,date,observedAt,sha256,env}),code('WORKBOOK_SCOPE'));
});

test('cross-day, partial page, wrong subtotal, duplicate and non-integer records fail closed',async()=>{
  const variants=[
    [p=>p.data[0].stockDate='2026-11-25','SUBTOTAL'],
    [p=>p.data[0].logCd='012','ROW'],
    [p=>p.data[0].maechul='1,200.01','INTEGER'],
    [p=>p.data[0].maechul='9007199254740993','INTEGER'],
    [p=>p.data[2].maechul=901,'SUBTOTAL'],
    [p=>p.data[2].baesongCnt=1,'SUBTOTAL'],
    [p=>p.data[0].isSum=true,'ROW'],
    [p=>p.data.splice(1,0,{...p.data[0]}),'DETAIL'],
    [p=>p.data[0].totalCnt=4,'DETAIL'],
  ];
  for(const [mutate,reason] of variants){const p=fixture();mutate(p);await assert.rejects(read(p),code(reason));}
  const counted=fixture();counted.data.splice(3);
  await assert.rejects(read(counted),code('COUNT'));
  await assert.rejects(read({data:Array.from({length:3000},()=>fixture().data[0])}),code('PAGE'));
});

test('same headline totals with a different base vehicle cannot publish; workbook and old hash are bound',async()=>{
  const evidence=await read(), changed=workbook('107');
  let outbound=0;
  const fetchImpl=()=>{outbound++;throw Error('unexpected archive request')};
  await assert.rejects(publishStageFreshonWmsDispatchWorkbook({evidence,bytes:changed,date,observedAt,
    sha256:hash(changed),replaceSha256:'9'.repeat(64),env,fetchImpl}),code('WORKBOOK_MISMATCH'));
  const bytes=workbook();
  await assert.rejects(publishStageFreshonWmsDispatchWorkbook({evidence,bytes,date,observedAt,
    sha256:hash(bytes),replaceSha256:'bad-sha',env,fetchImpl}),{code:'WMS_EXPORT_RELEASE_BASE_INVALID'});
  await assert.rejects(publishStageFreshonWmsDispatchWorkbook({evidence,date,observedAt,
    sha256:hash(bytes),env,fetchImpl}),code('WORKBOOK_SCOPE'));
  assert.equal(outbound,0);
});
