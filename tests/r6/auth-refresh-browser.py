"""Browser contract test; synthetic session response, no credentials or network."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import os

root=Path(__file__).resolve().parents[2]
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=os.environ['OPSMAP_TEST_CHROMIUM'],headless=True)
    page=browser.new_page()
    page.set_content('<html data-reference-data-optional="true"><body><header id="approvedSiteHeader"></header></body></html>')
    page.evaluate("""() => {
      window.loginPosts=0;window.mapReads=0;
      window.fetch=async (url,options={})=>{
        if(url.endsWith('/auth/login')){loginPosts++;throw Error('UNEXPECTED_LOGIN');}
        if(url.endsWith('/auth/session'))return new Response(JSON.stringify({authenticated:true,expiresAt:Date.now()+3600000,idleExpiresAt:Date.now()+1800000}),{headers:{'content-type':'application/json'}});
        mapReads++;await new Promise(resolve=>{(window.pendingReads ||= []).push(resolve);});
        return new Response('unavailable',{status:503});
      };
    }""")
    page.add_script_tag(content=(root/'public/map-staff-entry.js').read_text(encoding='utf8'))
    page.wait_for_function('window.mapReads===2')
    assert page.locator('input[name=password]').is_hidden()
    assert page.locator('input[name=username]').is_hidden()
    assert '직원 인증이 확인됐습니다' in page.locator('#mapStaffEntry').inner_text()
    assert page.evaluate('loginPosts')==0
    page.evaluate('pendingReads.forEach(fn=>fn())')
    page.wait_for_function('document.body.dataset.mapStaffState==="authenticated"')
    assert page.locator('#mapStaffEntry').is_hidden()
    assert page.evaluate('loginPosts')==0
    print('PASS: existing session bootstrap hides credential form and performs no login POST')
    browser.close()
