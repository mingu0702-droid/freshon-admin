import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {chromium} from 'playwright';
import {fileURLToPath} from 'node:url';
import {createOperationalPhotoExtension} from '../src/opsmapOperationalPhotos.js';

test('synthetic Edge: date selection, lazy thumbnails, enlargement/reuse and logout at PC/mobile sizes',async()=>{
  const app=express(),record={customerCode:'S990001',date:'2026-11-04',deliveryId:'990001'};
  let mediaReads=0,staff=true,contractFailure=false;
  const expiry=Date.now()+600000;
  app.get('/api/map-phase2b/auth/session',(_q,r)=>r.json({authenticated:staff,expiresAt:expiry,idleExpiresAt:expiry}));
  const extension=createOperationalPhotoExtension({enabled:true,hasMemorySession:()=>true,
    listDeliveryMetadata:async q=>q.date===record.date?[record]:[],
    rawRequest:async path=>path.endsWith('/status-record')?Response.json({data:[{id:'1990001',...(contractFailure?{}:{taskAttachments:[
      {typeText:'냉장고 문은 잘 닫았나요?',images:Array.from({length:4},(_,i)=>({url:'https://static.chabyulhwa.com/fridge-'+i+'.png'}))},
      {typeText:'매장 출입문은 잘 잠궜나요?',images:Array.from({length:4},(_,i)=>({url:'https://static.chabyulhwa.com/door-'+i+'.png'}))}
    ]})}]}):Response.json({data:{id:record.deliveryId,customer:{erpCode:record.customerCode},carrier:{enteringDatedAt:record.date}}}),imageFetch:async()=>{mediaReads++;return new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5N0AAAAASUVORK5CYII=','base64'),{headers:{'content-type':'image/png'}});}});
  extension.mount({app,requireStaff:(_q,r,n)=>{if(!staff)return r.status(401).json({error:'STAFF_LOGIN_REQUIRED'});r.locals.staffSession={key:'synthetic-staff',expiresAt:expiry,idleExpiresAt:expiry};return n();},isSessionCurrent:()=>staff,previewEnabled:()=>true});
  app.use(express.static(fileURLToPath(new URL('../public/opsmap',import.meta.url))));
  app.get('/',(_q,r)=>r.type('html').send('<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/opsmap-delivery-photos.css"><div id="photos" style="max-width:360px"></div><script src="/opsmap-delivery-photos.js"></script>'));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    for(const width of [1920,1366,768,390]){
      staff=true;const before=mediaReads;
      const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'}),page=await context.newPage();
      try{
        await page.goto('http://127.0.0.1:'+server.address().port+'/');assert.equal(mediaReads,before);
        await page.evaluate(async record=>{window.photoController=MapDeliveryPhotos.createController({host:document.querySelector('#photos')});await photoController.open(record);},record);
        assert.equal(await page.locator('.deliveryPhotoThumb img').count(),6);assert.equal(mediaReads-before,6);
        await page.locator('.deliveryPhotoThumb').first().click();
        await page.locator('.deliveryPhotoStage img').waitFor();
        assert(await page.locator('.deliveryPhotoStage img').evaluate(img=>img.complete&&img.naturalWidth>0));assert.equal(mediaReads-before,6);
        await page.getByRole('button',{name:'확대 사진 닫기'}).click();assert(await page.locator('.deliveryPhotoViewer').isHidden());
        await page.getByRole('button',{name:'사진 더 보기'}).click();
        await page.waitForFunction(()=>document.querySelectorAll('.deliveryPhotoThumb img').length===8);assert.equal(mediaReads-before,8);
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        await page.getByLabel('납품 사진 조회 배송일').fill('2026-11-03');await page.getByRole('button',{name:'배송일 조회'}).click();
        await page.waitForFunction(()=>document.querySelector('#photos').dataset.state==='empty');
        await page.getByLabel('납품 사진 조회 배송일').fill(record.date);await page.getByRole('button',{name:'배송일 조회'}).click();
        await page.waitForFunction(()=>document.querySelectorAll('.deliveryPhotoThumb img').length===6);
        contractFailure=true;
        await page.getByRole('button',{name:'배송일 조회'}).click();
        await page.waitForFunction(()=>document.querySelector('#photos').dataset.failureCode==='PHOTO_ATTACHMENTS_INVALID');
        assert(await page.getByLabel('납품 사진 조회 배송일').isVisible());
        await page.getByLabel('납품 사진 조회 배송일').fill('2026-11-03');await page.getByRole('button',{name:'배송일 조회'}).click();
        await page.waitForFunction(()=>document.querySelector('#photos').dataset.state==='empty');
        contractFailure=false;
        await page.getByLabel('납품 사진 조회 배송일').fill(record.date);await page.getByRole('button',{name:'배송일 조회'}).click();
        await page.waitForFunction(()=>document.querySelectorAll('.deliveryPhotoThumb img').length===6);
        staff=false;await page.evaluate(()=>photoController.expire());assert.equal(await page.locator('.deliveryPhotoThumb img').count(),0);
        assert(await page.locator('.deliveryPhotoViewer').isHidden());
      }finally{await context.close();}
    }
  }finally{await browser.close();await new Promise(r=>server.close(r));}
});
