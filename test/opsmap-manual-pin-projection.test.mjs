import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../public/opsmap/manual-map-pins.mjs', import.meta.url), 'utf8')
  .replace(/^import[^\n]+\n/, '');
const code = 'S990001';
const oldHash = 'a'.repeat(64);
const newHash = 'b'.repeat(64);

function element() {
  const children = new Map();
  return {
    append() {}, prepend() {}, after() {}, before() {}, setAttribute() {}, replaceChildren() {},
    querySelector(key) {
      if (!children.has(key)) children.set(key, element());
      return children.get(key);
    }
  };
}

async function fixture(data) {
  const body = element();
  const window = {MapUiLocalBridge:{stores:()=>[], refreshManualCoordinates(){}}, addEventListener(){}};
  runInNewContext(source, {
    window,
    document:{createElement:element, querySelector:() => body, body},
    addressRegion:() => '', dispatchCenter:() => '', manualPinTargetCodes:() => [],
    fetch:async () => ({ok:true, json:async () => ({ok:true, data})})
  });
  await window.MapManualPins.refresh();
  return window.MapManualPins;
}

const fixedPoint = originalAddressHash => ({
  customerCode:code, originalAddressHash, lat:37.51, lng:127.01,
  coordinateSource:'OFFICIAL_ADDRESS_DATA', coordinateStatus:'CONFIRMED'
});
const manualPoint = {
  customerCode:code, originalAddressHash:oldHash, currentAddressHash:oldHash,
  resolutionStatus:'MANUAL_CONFIRMED', latitude:37.49, longitude:127.02
};

test('a stale manual projection cannot replace the verified coordinate of a moved store', async () => {
  const pins = await fixture([manualPoint]);
  const verifiedNew = pins.apply(fixedPoint(newHash));
  assert.equal(verifiedNew.lat, 37.51);
  assert.equal(verifiedNew.coordinateSource, 'OFFICIAL_ADDRESS_DATA');
  const verifiedOld = pins.apply(fixedPoint(oldHash));
  assert.equal(verifiedOld.lat, manualPoint.latitude);
  const mismatched = pins.apply({...fixedPoint(oldHash), currentAddressHash:newHash});
  assert.equal(mismatched.lat, null);
  assert.equal(mismatched.resolutionStatus, 'ADDRESS_CHANGED_REVIEW_REQUIRED');
});

test('a manual address conflict only holds positions without verified evidence for the new address', async () => {
  const pins = await fixture([{...manualPoint, currentAddressHash:newHash, latitude:null, longitude:null,
    resolutionStatus:'ADDRESS_CHANGED_REVIEW_REQUIRED'}]);
  const verifiedNew = pins.apply(fixedPoint(newHash));
  assert.equal(verifiedNew.lat, 37.51);
  assert.equal(verifiedNew.coordinateSource, 'OFFICIAL_ADDRESS_DATA');
  const verifiedOld = pins.apply(fixedPoint(oldHash));
  assert.equal(verifiedOld.lat, null);
  assert.equal(verifiedOld.coordinateStatus, 'CONFLICT');
  const staleManualBase = pins.apply({...fixedPoint(newHash), coordinateSource:'MANUAL_PIN'});
  assert.equal(staleManualBase.lat, null);
});
