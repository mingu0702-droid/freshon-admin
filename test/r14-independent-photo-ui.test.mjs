// SYNTHETIC component fixture, isolated headless Edge. No existing browser/session.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
const root=resolve(process.env.R14_QA_TARGET_ROOT||fileURLToPath(new URL('..',import.meta.url)));
const require=createRequire(pathToFileURL(resolve(root,'package.json')));
const {chromium}=require('playwright'),express=require('express');
test('SYNTHETIC Edge component: photo failure separation, identity race and escaping at 4 widths',async()=>{
  const out=process.env.R14_QA_OUTPUT_DIR||join(tmpdir(),'opsmap-r14-independent-synthetic');await mkdir(out,{recursive:true});
  const app=express();app.use('/assets',express.static(resolve(root,'public/opsmap')));
  app.get('/',(_q,r)=>r.type('html').send('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/opsmap-delivery-photos.css"><main style="width:min(360px,100%);box-sizing:border-box"><section class="deliveryPhotos" id="photos"></section></main><script src="/assets/opsmap-delivery-photos.js"></script>'));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const browser=await chromium.launch({channel:'msedge',headless:true});const checks=[];
  try{for(const width of [1920,1366,768,390]){
    const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});const page=await context.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
    try{
      await page.goto('http://127.0.0.1:'+server.address().port+'/');
      await page.evaluate(()=>{
        window.qa={mode:'empty',calls:[],delayedResolve:null};
        const row=(customerCode,date,detail)=>({customerCode,date,deliveryId:'990091',status:detail?'EMPTY':'UNVERIFIED',photos:[],notes:detail?'SYNTHETIC '+customerCode+' <img src=x onerror="window.qa.xss=true">':''});
        const fetcher=async(path)=>{
          const url=new URL(path,location.href);qa.calls.push(url.pathname+url.search);
          if(url.pathname.endsWith('/auth/session'))return Response.json({authenticated:true,expiresAt:Date.now()+60000,idleExpiresAt:Date.now()+60000});
          if(qa.mode==='delayed'&&url.searchParams.get('customerCode')==='S990091')return new Promise(resolve=>{qa.delayedResolve=()=>resolve(Response.json({ok:true,data:{customerCode:'S990091',deliveries:[row('S990091','2026-11-04',false)]}}));});
          if(qa.mode==='error')return Response.json({ok:false,error:{code:qa.code}},{status:qa.http});
          const customerCode=url.searchParams.get('customerCode'),date=url.searchParams.get('date');
          return Response.json({ok:true,data:{customerCode,deliveries:qa.mode==='empty'?[]:[row(customerCode,date,url.searchParams.has('deliveryId'))]}});
        };
        window.photoController=MapDeliveryPhotos.createController({host:document.querySelector('#photos'),fetcher});
      });
      for(const [http,code,state] of [[403,'PHOTO_FORBIDDEN','forbidden'],[404,'PHOTO_NOT_FOUND','unverified'],[503,'SOURCE_UNAVAILABLE','unverified'],[504,'PHOTO_TIMEOUT','error'],[502,'UPSTREAM_AUTH_REQUIRED','upstream-auth-required']]){
        await page.evaluate(async({http,code})=>{Object.assign(qa,{mode:'error',http,code});await photoController.open({customerCode:'S990091',date:'2026-11-04'});},{http,code});
        assert.equal(await page.locator('#photos').getAttribute('data-state'),state);assert(!await page.locator('#photos').innerText().then(t=>t.includes('사진 없음')));
      }
      await page.evaluate(async()=>{qa.mode='empty';await photoController.open({customerCode:'S990091',date:'2026-11-04'});});
      assert.equal(await page.locator('#photos').getAttribute('data-state'),'empty');assert.equal(await page.getByLabel('납품 사진 조회 배송일').inputValue(),'2026-11-04');
      await page.evaluate(async()=>{
        qa.mode='delayed';qa.oldOpen=photoController.open({customerCode:'S990091',date:'2026-11-04'});
      });
      await page.waitForFunction(()=>typeof qa.delayedResolve==='function');
      await page.evaluate(async()=>{qa.mode='record';await photoController.open({customerCode:'S990092',date:'2026-11-04'});qa.delayedResolve();await qa.oldOpen;});
      const text=await page.locator('#photos').innerText();assert(text.includes('S990092'));assert(!text.includes('S990091'));assert(text.includes('<img src=x onerror='));assert.equal(await page.locator('#photos img').count(),0);assert.equal(await page.evaluate(()=>qa.xss),undefined);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      assert.equal(await page.evaluate(()=>Array.from(document.querySelectorAll('#photos button,#photos input,#photos select')).every(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;})),true);
      assert.deepEqual(errors,[]);await page.screenshot({path:join(out,'synthetic-photo-component-'+width+'.png'),fullPage:true});
      checks.push({width,scope:'SYNTHETIC_COMPONENT_ONLY',failuresDistinct:5,latestCustomerPreserved:true,xssEscaped:true,horizontalOverflow:false,pageErrors:0});
    }finally{await context.close();}
  }}finally{await browser.close();await new Promise(r=>server.close(r));}
  await writeFile(join(out,'results.safe.json'),JSON.stringify({scope:'SYNTHETIC_COMPONENT_ONLY',actualSourceApiCalls:0,actualProductionBrowser:false,checks},null,2));
  console.log('SYNTHETIC component evidence: '+out);
});
