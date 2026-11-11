import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import '../public/opsmap/map-period-ui.js';
import '../public/opsmap/phase2b-ui-helpers.js';
import '../public/opsmap/manual-waypoints.js';
import '../public/opsmap/new-area-requests.js';

// Independent synthetic runtime boundary checks: no app server, remote requests or writes.
const source = fs.readFileSync(new URL('../public/opsmap/map-phase2b-runtime.js', import.meta.url), 'utf8');
const exposure = `
  window.qa = {
    judgeNewAreaPoint, newAreaEvidence,
    setup(saved, rows) {
      state.rangeStart = '2026-09-01'; state.rangeEnd = '2026-11-02'; dateReady = true;
      periodMeta = {startDate:state.rangeStart,endDate:state.rangeEnd,complete:true,coverageComplete:true,missingCoordinate:0};
      latestSnapshotRows = saved; periodRows = rows;
      coordinateByCode.clear(); baseVehicles.clear();
      for (const row of saved) coordinateByCode.set(row.customerCode, row);
      for (const row of rows) baseVehicles.set(row.customerCode, {baseVehicle:'101'});
    }
  };
})();`;
function fixture() {
  const node = () => ({value:'',innerHTML:'',textContent:'',classList:{add(){},remove(){}},setAttribute(){},removeAttribute(){}});
  const window = {addEventListener(){},VEHICLE_AREA_DATA:{vehicles:[]},ManualWaypoints:globalThis.ManualWaypoints,KAKAO_MAP_CONFIG:{allowExternalAddressLookup:false}};
  const ctx = vm.createContext({window,document:{querySelector:node,querySelectorAll:()=>[],addEventListener(){},body:node()},MapPeriodUi:globalThis.MapPeriodUi,Phase2bUi:globalThis.Phase2bUi,NewAreaRequests:globalThis.NewAreaRequests,Map,Set,URL,URLSearchParams,AbortController,Date,Intl,Number,performance,setTimeout,clearTimeout,innerWidth:1440});
  vm.runInContext(source.slice(0,source.indexOf('\n  initVehicles();')) + exposure, ctx);
  return window.qa;
}
const saved = {customerCode:'S990001',customerName:'SYNTHETIC_ONLY',address:'경기도 화성시 합성로 1',lat:37.2,lng:127,lastDeliveryDate:'2026-11-02'};
const missing = {customerCode:saved.customerCode,address:saved.address,lastDeliveryDate:saved.lastDeliveryDate};
const point = {lat:37.201,lng:127};

test('independent QA: the fixed registry requires a validated coordinate pair and ignores period rows', () => {
  const f = fixture();
  for (const coordinateStatus of ['CONFLICT','UNVERIFIED','MISSING']) {
    f.setup([{...saved,coordinateStatus}],[missing]);
    assert.equal(f.newAreaEvidence().locationRows.length,0,coordinateStatus + ' snapshot must not become evidence');
    assert.equal(f.judgeNewAreaPoint({address:saved.address},point).decision,'검토');
  }
  f.setup([{...saved,resolutionStatus:'ADDRESS_CHANGED_REVIEW_REQUIRED'}],[missing]);
  assert.equal(f.newAreaEvidence().locationRows.length,0,'address-review snapshot must not become evidence');
  for (const row of [{...missing,lat:37.201},{...missing,lng:127},{...missing,lat:null,lng:null}]) {
    f.setup([saved],[row]);
    assert.equal(f.newAreaEvidence().locationRows.length,1,'partial period pair cannot invalidate the registry');
    assert.equal(f.judgeNewAreaPoint({address:saved.address},point).decision,'O');
  }
  f.setup([saved],[{...missing,address:'경기도 화성시 다른합성로 2'}]);
  assert.equal(f.newAreaEvidence().locationRows[0].address,saved.address,'period address cannot replace the registry address');
  f.setup([], [saved]);
  assert.equal(f.newAreaEvidence().locationRows.length,0,'period coordinate alone cannot create a registered store');
});

test('independent QA: the fixed 500 m limit applies without a complete delivery period', () => {
  const f = fixture(); f.setup([saved],[saved]);
  const far = f.judgeNewAreaPoint({address:'경상북도 안동시 합성로 1'},{lat:36.56,lng:128.73});
  assert.equal(far.decision,'X');
  assert.equal(far.reason,'배송동선 맞지않음');
  assert.match(far.evidence,/반올림 전 직선거리 500m 초과/);
  f.setup([saved],[]);
  const withoutPeriod = f.judgeNewAreaPoint({address:'경상북도 안동시 합성로 1'},{lat:36.56,lng:128.73});
  assert.equal(withoutPeriod.decision,far.decision);
  assert.equal(withoutPeriod.reason,far.reason);
  const exception = f.judgeNewAreaPoint({address:'제주특별자치도 합성로 1'},{lat:33.4,lng:126.5});
  assert.equal(exception.decision,'X','explicit legacy exclusion remains a separate policy');
});
