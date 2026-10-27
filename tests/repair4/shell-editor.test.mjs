import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const shell = fs.readFileSync(new URL('../../public/map-approved-shell-candidate.js', import.meta.url), 'utf8');
const editorStart = shell.indexOf("  const planner=document.createElement('details');");
const editorEnd = shell.indexOf("  const stores=$('#periodStoreListSection');", editorStart);
assert.ok(editorStart >= 0 && editorEnd > editorStart, 'Live shell editor found');

function fixture() {
  const elements = new Map();
  const events = [];
  const calls = { changed: 0, cleared: 0, queried: 0, replaced: [] };
  const rows = ['A', 'B', 'C', 'D', ...Array.from({length: 32}, (_, i) => `W${i}`)].map((code, i) => ({customerCode: code, customerName: `매장 ${code}`, address: `주소 ${code}`, lat: i < 2 ? 37.5 : 37.5 + i / 1000, lng: 127, coordinateStatus: 'VERIFIED'}));
  class Element {
    constructor(tag = 'div') { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.value = ''; this.hidden = false; this.disabled = false; }
    set id(value) { this._id = value; elements.set('#' + value, this); }
    get id() { return this._id; }
    set innerHTML(value) {
      this._html = value;
      for (const match of value.matchAll(/<([a-z]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
        const el = new Element(match[1]); el.id = match[3];
        for (const attr of match[2].matchAll(/([\w-]+)="([^"]*)"/g)) el.setAttribute(attr[1], attr[2]);
        this.children.push(el);
      }
    }
    get innerHTML() { return this._html || ''; }
    setAttribute(name, value) { this.attributes[name] = value; if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    after() {}
    focus() { document.activeElement = this; }
    click() { return this.onclick?.({target: this}); }
  }
  const document = { createElement: tag => new Element(tag), querySelector: selector => elements.get(selector), activeElement: null };
  const $ = selector => elements.get(selector);
  const resolve = value => rows.filter(row => [row.customerCode, row.customerName, row.address].includes(String(value || '').trim()));
  const bridge = { lookupStore: resolve, navigationChanged() { calls.changed++; }, clearManual() { calls.cleared++; }, replaceManualStops(points) { calls.replaced.push(points); }, async queryManualRoute() { calls.queried++; } };
  const window = { MapNavigation: {resolve}, dispatchEvent(event) { events.push(event.type); } };
  const context = vm.createContext({ document, window, bridge, $, filters: new Element('section'), CustomEvent: class { constructor(type) { this.type = type; } } });
  vm.runInContext(shell.slice(editorStart, editorEnd), context, {filename: 'live-shell-editor.js'});
  const values = () => Array.from(window.MapNavigationEditor.values());
  return { $, editor: window.MapNavigationEditor, values, events, calls, document, rows };
}

test('selecting destination first preserves the empty origin', () => {
  const f = fixture(); f.editor.setPoint('destination', 'B');
  assert.deepEqual(f.values(), ['', 'B']);
  f.editor.setPoint('origin', 'A'); assert.deepEqual(f.values(), ['A', 'B']);
  assert.equal(f.events.length, 2);
  f.editor.setPoint('destination', 'B'); assert.equal(f.events.length, 2, 'same role reassignment is a no-op');
});

test('adding a waypoint focuses its own role and fills that empty slot', () => {
  const f = fixture(); f.editor.setPoint('origin', 'A'); f.editor.setPoint('destination', 'D');
  f.$('#addWaypoint').click();
  assert.equal(f.document.activeElement.id, 'plannerWaypoint0');
  assert.equal(f.$('#plannerWaypoint0').dataset.navRole, 'waypoint');
  assert.equal(f.$('#plannerWaypoint0').dataset.navIndex, '0');
  f.editor.setPoint('waypoint', 'B');
  assert.deepEqual(f.values(), ['A', 'B', 'D']);
  f.editor.setPoint('waypoint', 'C');
  assert.deepEqual(f.values(), ['A', 'B', 'C', 'D']);
});

test('editing one waypoint never moves or clears another role', () => {
  const f = fixture(); f.editor.setPoint('origin', 'A'); f.editor.setPoint('destination', 'D'); f.editor.setPoint('waypoint', 'B');
  f.editor.setPoint('waypoint', 'C', 0);
  assert.deepEqual(f.values(), ['A', 'C', 'D']);
  const before = f.values();
  assert.throws(() => f.editor.setPoint('waypoint', 'D'), /이미 경로/);
  assert.deepEqual(f.values(), before);
  f.$('#plannerWaypoint0').value = '매장 B'; f.$('#plannerWaypoint0').oninput({});
  assert.deepEqual(f.values(), ['A', '매장 B', 'D']);
});

test('different stores at one coordinate and return-to-origin trips are retained', () => {
  const f = fixture(); f.editor.setPoint('origin', 'A'); f.editor.setPoint('waypoint', 'B'); f.editor.setPoint('destination', 'A');
  assert.deepEqual(f.values(), ['A', 'B', 'A']);
  assert.equal(f.rows[0].lat, f.rows[1].lat);
});

test('reverse, remove and clear preserve explicit role slots and emit once per edit', () => {
  const f = fixture(); f.editor.setPoint('origin', 'A'); f.editor.setPoint('waypoint', 'B'); f.editor.setPoint('waypoint', 'C'); f.editor.setPoint('destination', 'D');
  const before = f.events.length; f.editor.reverse();
  assert.deepEqual(f.values(), ['D', 'C', 'B', 'A']); assert.equal(f.events.length, before + 1);
  f.editor.removePoint('waypoint', 0); assert.deepEqual(f.values(), ['D', 'B', 'A']);
  f.editor.removePoint('origin'); assert.deepEqual(f.values(), ['', 'B', 'A']);
  const beforeClear = f.events.length; f.editor.clear();
  assert.deepEqual(f.values(), ['', '']); assert.equal(f.calls.cleared, 1); assert.equal(f.events.length, beforeClear + 1);
});

test('incomplete or ambiguous route fields do not query the road service', async () => {
  const f = fixture(); f.editor.setPoint('destination', 'D'); await f.$('#planRoute').click();
  assert.equal(f.calls.queried, 0); assert.match(f.$('#plannerStatus').textContent, /출발지/);
  f.editor.setPoint('origin', 'A'); f.$('#addWaypoint').click(); await f.$('#planRoute').click();
  assert.equal(f.calls.queried, 0); assert.match(f.$('#plannerStatus').textContent, /경유지 1/);
  f.editor.setPoint('waypoint', 'B'); await f.$('#planRoute').click();
  assert.equal(f.calls.queried, 1); assert.deepEqual(Array.from(f.calls.replaced[0], row => row.customerCode), ['A', 'B', 'D']);
});

test('invalid roles, indexes and waypoint overflow leave the draft unchanged', () => {
  const f = fixture();
  assert.throws(() => f.editor.setPoint('other', 'A'));
  assert.throws(() => f.editor.setPoint('waypoint', 'A', 0));
  assert.throws(() => f.editor.removePoint('waypoint', 0));
  for (let i = 0; i < 30; i++) f.editor.setPoint('waypoint', `W${i}`);
  const before = f.values(); assert.throws(() => f.editor.setPoint('waypoint', 'W30'), /최대 30/); assert.deepEqual(f.values(), before);
});

const centerStart = shell.indexOf('  function sourceCenterLabel(row){');
const centerEnd = shell.indexOf('  function sourceCard(', centerStart);
const centerContext = vm.createContext({});
vm.runInContext(shell.slice(centerStart, centerEnd) + '\nthis.centerLabel = sourceCenterLabel; this.vehicleLabel = sourceVehicleLabel;', centerContext);
test('center labels retain previously verified assignment without inferring from address', () => {
  const base = {baseVehicleState:'VERIFIED_MASTER', baseVehicleSource:'FIXED_DISPATCH_PRIMARY', baseVehicleVersion:'a'.repeat(64), baseVehicleGroup:'osan', baseVehicleCheckedAt:'2026-09-24'};
  assert.equal(centerContext.centerLabel({...base, baseVehicleStale:false}), '오산');
  assert.equal(centerContext.centerLabel({...base, baseVehicleStale:true}), '오산 · 9/24 기준');
  assert.equal(centerContext.centerLabel({address:'오산시 가상로 1'}), '');
  assert.equal(centerContext.centerLabel({centerName:'영남센터', address:'오산시 가상로 1'}), '영남');
  assert.equal(centerContext.centerLabel({baseVehicleGroup:'osan'}), '');
});

test('empty vehicle labels distinguish unknown or failed reads from verified unassignment', () => {
  for (const state of [undefined, 'UNKNOWN', 'FETCH_FAILED', 'ERROR']) {
    assert.equal(centerContext.vehicleLabel({baseVehicleState:state}, false, ''), '호차 확인 필요');
  }
  assert.equal(centerContext.vehicleLabel({baseVehicleState:'UNASSIGNED'}, false, ''), '호차 미지정');
  assert.equal(centerContext.vehicleLabel({baseVehicleState:'NOT_IN_MASTER'}, false, ''), '기준표 미등록');
  assert.equal(centerContext.vehicleLabel({baseVehicleState:'CONFLICT'}, false, ''), '기준호차 충돌');
  assert.equal(centerContext.vehicleLabel({baseVehicleState:'VERIFIED_MASTER',baseVehicleStale:true}, false, '101'), '101호차 · 이전 확인값');
  assert.equal(centerContext.vehicleLabel({baseVehicleState:'UNASSIGNED',baseVehicleStale:true}, true, ''), '호차 확인 필요', 'dated route does not inherit a base-assignment assertion');
  assert.equal(centerContext.vehicleLabel({baseVehicleStale:true}, true, '102'), '102호차');
});

test('store cards place the customer code first and repaint when only assignment state changes', () => {
  class CardElement {
    constructor() { this.children=[]; this.dataset={}; this.style={setProperty(){}}; this.classList={add(){}}; this.textContent=''; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children=children; }
    setAttribute() {}
  }
  const context=vm.createContext({document:{createElement:()=>new CardElement()},Phase2bUi:{vehicleColor:()=> '#357'}});
  const end=shell.indexOf('  let visibleStoreLimit=', centerStart);
  vm.runInContext(shell.slice(centerStart,end)+'\nthis.paint = sourceCard;',context);
  const button=new CardElement();
  const row={customerCode:'S1001',customerName:'확인 매장',baseVehicle:'',baseVehicleState:'UNKNOWN',address:'확인로 1'};
  context.paint(button,row,false);
  const firstText=button.children[1];
  assert.equal(firstText.children[0].className,'storeCode');
  assert.equal(firstText.children[0].textContent,'S1001');
  assert.equal(firstText.children[1].textContent,'확인 매장');
  assert.equal(firstText.children[2].children[0].textContent,'호차 확인 필요');
  context.paint(button,{...row,baseVehicleState:'UNASSIGNED'},false);
  assert.notEqual(button.children[1],firstText,'state-only update must not retain the old badge');
  assert.equal(button.children[1].children[2].children[0].textContent,'호차 미지정');
});


test('visit-list replacement is atomic and keeps all roles and round-trip endpoints', () => {
  const f = fixture(); f.editor.setPoint('origin', 'A'); f.editor.setPoint('destination', 'D');
  const before=f.values(); const events=f.events.length;
  assert.throws(() => f.editor.replacePoints(['A','UNKNOWN','D']));
  assert.deepEqual(f.values(),before); assert.equal(f.events.length,events);
  assert.throws(() => f.editor.replacePoints(['A','B','B','D'])); assert.deepEqual(f.values(),before);
  f.editor.replacePoints(['A','B','C','A']);
  assert.deepEqual(f.values(),['A','B','C','A']); assert.equal(f.events.length,events+1);
  const long=['A',...Array.from({length:30},(_,i)=>`W${i}`),'D'];
  f.editor.replacePoints(long); assert.deepEqual(f.values(),long);
  assert.throws(() => f.editor.replacePoints(['A',...Array.from({length:31},(_,i)=>`W${i}`),'D'])); assert.deepEqual(f.values(),long);
});


test('temporary address point IDs stay internal while the input displays the place name', () => {
  const f=fixture();f.rows.push({customerCode:'POINT_1',customerName:'선택한 합성 주소',address:'가상로 123',lat:37.4,lng:127.1});
  f.editor.setPoint('origin','POINT_1');f.editor.setPoint('destination','D');
  assert.equal(f.$('#plannerStart').value,'선택한 합성 주소');assert.deepEqual(f.values(),['POINT_1','D']);
  f.editor.reverse();assert.equal(f.$('#plannerEnd').value,'선택한 합성 주소');assert.deepEqual(f.values(),['D','POINT_1']);
  f.$('#plannerEnd').value='새 주소';f.$('#plannerEnd').oninput();assert.deepEqual(f.values(),['D','새 주소']);
  f.editor.clear();assert.equal(f.$('#plannerEnd').dataset.pointCode,undefined);
});
