import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from 'playwright';
const script=await fs.readFile(new URL('../public/opsmap/map-data-sync.js',import.meta.url),'utf8');
test('local browser status UI retains usable data when a source/local model is unknown',async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  for(const width of [1366,390]){
   const page=await browser.newPage({viewport:{width,height:844}});
   await page.setContent('<div id="mapDateBar"></div><div id="leftPanel"><div class="head"></div><div id="existingRows">기존 매장 목록</div></div>');
   await page.evaluate(()=>{
    window.MapStaffEntry={session:()=>({authenticated:true})};
    window.fetch=async url=>({ok:true,json:async()=>String(url).includes('data-status')?{data:{partial:true,customer:{freshon:'2026-11-02',delivery:null},published:{endDate:null},live:null,automation:{configured:null,status:'UNKNOWN'},customerDetails:null,job:null}}:{latestDate:'2026-11-02',stale:true,selectedDateCheckpoint:{date:'2026-11-02',sourceVisitCount:1620,selectedDateStorageVerified:true}}});
   });
   await page.addScriptTag({content:script});
   await page.locator('#mapDataHealth summary').click();
   await page.locator('#mapDataHealth [role="status"]').filter({hasText:'당일 저장 확인'}).waitFor();
   const text=await page.locator('#mapDataHealth [role="status"]').innerText();
   assert.match(text,/일부 상태 미확인/);assert.match(text,/자동 최신화 상태 미확인/);
   assert.doesNotMatch(text,/자동 최신화 미설정|최신화 상태 확인 실패/);
   assert.equal(await page.locator('#existingRows').innerText(),'기존 매장 목록');
   for(const button of await page.locator('#mapDataHealth > button').all())assert.equal(await button.isDisabled(),true);
   await page.evaluate(()=>window.dispatchEvent(new Event('map-staff-signed-out')));
   assert.equal(await page.locator('#mapDataHealth [role="status"]').innerText(),'직원 로그인 필요');
   await page.close();
  }
 }finally{await browser.close();}
});
