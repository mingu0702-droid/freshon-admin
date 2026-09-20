import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { mountMapMainPage } from '../src/mapMainPage.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
async function server(t, enabled = true) {
  const app = express();
  mountMapMainPage(app, { publicDir, enabled: () => enabled });
  app.use(express.static(publicDir));
  const listener = app.listen(0, '127.0.0.1');
  await new Promise(resolve => listener.once('listening', resolve));
  t.after(() => new Promise(resolve => { listener.close(resolve); listener.closeAllConnections(); }));
  return 'http://127.0.0.1:' + listener.address().port;
}
for (const route of ['/', '/index.html', '/daily-routes.html']) {
  test('main entry shares the verified UI: ' + route, async t => {
    const base = await server(t), response = await fetch(base + route);
    assert.equal(response.status, 200);
    assert.equal(response.url, base + route);
    assert.equal(await response.text(), await fs.readFile(path.join(publicDir, 'map-phase2b-preview.html'), 'utf8'));
  });
}
test('legacy WMS remains reachable without redirecting to the new map', async t => {
  const base = await server(t), response = await fetch(base + '/daily-routes.html?tab=wms');
  assert.equal(digest(Buffer.from(await response.arrayBuffer())), digest(await fs.readFile(path.join(publicDir, 'daily-routes.html'))));
});
test('disabled feature preserves the previous entry document', async t => {
  const base = await server(t, false), response = await fetch(base + '/');
  assert.equal(await response.text(), await fs.readFile(path.join(publicDir, 'index.html'), 'utf8'));
});
test('main HTML keeps one copy of each existing shared UI bundle', async () => {
  const html = await fs.readFile(path.join(publicDir, 'map-phase2b-preview.html'), 'utf8');
  for (const asset of ['map-staff.js', 'map-period-ui.js', 'map-phase2b-runtime.js', 'map-period.css']) {
    assert.equal(html.split('"' + asset + '"').length - 1, 1);
  }
  for (const id of ['modePeriod', 'modeDaily', 'rangeStart', 'rangeEnd', 'query', 'legacyVehicleState', 'periodDriver', 'mobileWorkspace']) {
    assert.ok(html.includes('id="' + id + '"'), id);
  }
});
