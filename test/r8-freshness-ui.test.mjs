import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from 'playwright';

const script = await fs.readFile(new URL('../public/opsmap/map-data-sync.js', import.meta.url), 'utf8');

test('the staff header keeps the last applied date through delayed or failed reads and forgets it on logout', async () => {
  const browser = await chromium.launch({channel:'msedge', headless:true});
  try {
    for (const width of [1366, 390]) {
      const page = await browser.newPage({viewport:{width,height:844}});
      await page.setContent('<div id="mapDateBar"></div><div id="existingRows">기존 매장 목록</div>');
      await page.evaluate(() => {
        window.fetchCount = 0;
        window.fetch = async () => { window.fetchCount++; throw Error('HUB_UNAVAILABLE'); };
      });
      await page.addScriptTag({content:script});
      await page.evaluate(() => {
        const header = document.createElement('header');
        header.id = 'approvedSiteHeader';
        document.body.prepend(header);
      });
      const status = page.locator('#approvedSiteHeader #mapFreshnessStatus');
      await status.waitFor();
      assert.equal(await status.innerText(), '매장정보 확인 중');
      await page.evaluate(() => MapDataSync.applied('2026-11-07'));
      assert.equal(await status.innerText(), '매장정보 2026.11.07까지 반영 · 새 정보 확인 중');
      await page.evaluate(() => MapDataSync.setChecking(false));
      assert.equal(await status.innerText(), '매장정보 2026.11.07까지 반영');
      assert.equal(await page.locator('#existingRows').innerText(), '기존 매장 목록');
      assert.equal(await page.locator('#mapDataHealth, #mapDataSync').count(), 0);
      assert.equal(await page.evaluate(() => window.fetchCount), 0);
      await page.evaluate(() => MapDataSync.applied('2026-11-15'));
      assert.equal(await status.innerText(), '매장정보 2026.11.15까지 반영');
      await page.evaluate(() => window.dispatchEvent(new Event('map-staff-signed-out')));
      assert.equal(await status.innerText(), '매장정보 확인 중');
      await page.close();
    }
  } finally {
    await browser.close();
  }
});
