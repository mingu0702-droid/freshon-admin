import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const context=vm.createContext({AbortController,setTimeout,clearTimeout});vm.runInContext(fs.readFileSync(new URL('../public/opsmap/map-address-locations.js',import.meta.url),'utf8'),context);
const make=(extra={})=>{let calls=0;const api=context.MapAddressLocations.create({queryFor:a=>a?.replace(/\([^)]*\)/g,'').trim(),lookup:async()=>{calls++;return{lat:37.5,lng:127};},spacingMs:0,...extra});return{api,calls:()=>calls};};
const row=(code='S990001')=>({customerCode:code,address:'합성시 합성로 10',lat:null,lng:null});
test('verified GPS and manual points never call Kakao or change fields',async()=>{const f=make();for(const source of ['RAW_GPS','MANUAL_PIN','HISTORICAL_GPS_SAME_BUILDING']){const a={...row(),lat:37.4,lng:127.1,coordinateSource:source},before=JSON.stringify(a);await f.api.ensure(a);assert.equal(JSON.stringify(a),before);}assert.equal(f.calls(),0);});
test('two shop-in-shop codes share one request but retain their separate identities',async()=>{const f=make(),a=row(),b=row('S990002');await Promise.all([f.api.ensure(a),f.api.ensure(b)]);assert.equal(f.calls(),1);assert.equal(a.customerCode,'S990001');assert.equal(b.customerCode,'S990002');assert.equal(a.coordinateSource,'KAKAO_ADDRESS_LIVE');assert.equal(b.lat,a.lat);assert.equal(f.api.summary().located,2);});
test('current Customer address is read without adding addresses to the source row',async()=>{let reads=0;const f=make({readAddress:async r=>{reads++;return{customerCode:r.customerCode,address:'합성시 합성로 10'};}}),a={...row(),address:'',raw:{originalAddressHash:'old'}};await f.api.ensure(a);assert.equal(a.address,'');assert.equal(a.lat,37.5);await f.api.ensure(a);assert.equal(reads,1);assert.equal(f.calls(),1);});
test('concurrent views of the same unlocated customer share one private address read and lookup',async()=>{
 let release,reads=0;
 const gate=new Promise(resolve=>release=resolve),f=make({addressReadDate:()=> '2026-11-07',readAddress:async(r,_signal,date)=>{
  reads++;
  assert.equal(date,'2026-11-07');
  await gate;
  return {customerCode:r.customerCode,address:'합성시 합성로 10'};
 }});
 const first={...row(),address:''},second={...first};
 const together=Promise.all([f.api.ensure(first),f.api.ensure(second)]);
 await Promise.resolve();
 assert.equal(reads,1);
 release();
 await together;
 assert.equal(first.lat,37.5);
 assert.equal(second.lat,37.5);
 await f.api.ensure(first);
 assert.equal(reads,1);
 assert.equal(f.calls(),1);
});
test('an in-flight address read is separate for a changed delivery date',async()=>{
 let date='2026-11-06',release;
 const dates=[],lookups=[],gate=new Promise(resolve=>release=resolve);
 const f=make({addressReadDate:()=>date,readAddress:async(r,_signal,readDate)=>{
  dates.push(readDate);
  if(readDate==='2026-11-06')await gate;
  return {customerCode:r.customerCode,address:`합성시 합성로 ${readDate.endsWith('07')?20:10}`};
 },lookup:async address=>{lookups.push(address);return {lat:37.5,lng:127};}});
 const unlocated={...row(),address:''},old=f.api.ensure(unlocated);
 await Promise.resolve();
 date='2026-11-07';
 await f.api.ensure(unlocated);
 release();
 await old;
 assert.deepEqual(dates,['2026-11-06','2026-11-07']);
 assert.deepEqual(lookups,['합성시 합성로 20']);
 assert.equal(unlocated.lat,37.5);
});
test('logout discards a queued private address read before it starts',async()=>{
 let reads=0;
 const f=make({readAddress:async()=>{reads++;}}),unlocated={...row(),address:''};
 const pending=f.api.ensure(unlocated);
 f.api.clear();
 await pending;
 assert.equal(reads,0);
 assert.equal(unlocated.lat,null);
});
test('address/hash changes invalidate old screen coordinates and read the new current address',async()=>{let reads=0;const f=make({readAddress:async r=>({customerCode:r.customerCode,address:'합성시 변경로 '+(++reads)})}),a={...row(),address:'',raw:{originalAddressHash:'old'}};await f.api.ensure(a);a.raw={originalAddressHash:'new'};f.api.apply(a);assert.equal(a.lat,null);await f.api.ensure(a);assert.equal(reads,2);assert.equal(f.calls(),2);});
test('explicit basic address change cannot reuse a point from another building',async()=>{const f=make(),a=row();await f.api.ensure(a);a.address='합성시 다른로 99';f.api.apply(a);assert.equal(a.lat,null);await f.api.ensure(a);assert.equal(f.calls(),2);});
test('verified Customer conflict forces a fresh current address instead of the old point',async()=>{const f=make({readAddress:async r=>({customerCode:r.customerCode,address:'합성시 변경로 99'})}),a=row();await f.api.ensure(a);a.addressChanged=true;a.lat=null;a.lng=null;a.coordinateStatus='CONFLICT';f.api.apply(a);assert.equal(a.lat,null);await f.api.ensure(a);assert.equal(a.lat,37.5);assert.equal(f.calls(),2);});
test('multiple/invalid results stay unresolved and are not retried on every idle',async()=>{for(const point of [{candidates:[{}]},{lat:0,lng:0},null]){let calls=0;const f=make({lookup:async()=>{calls++;return point;}}),a=row();await f.api.ensure(a);await f.api.ensure(a);assert.equal(a.lat,null);assert.equal(calls,1);assert.equal(f.api.summary().review,1);}});
test('transient error allows bounded later retry without losing established points',async()=>{let clock=0,calls=0;const f=make({now:()=>clock,lookup:async()=>{if(++calls===1)throw Object.assign(Error(),{code:'KAKAO_TIMEOUT'});return{lat:37.5,lng:127};}}),a=row();await f.api.ensure(a);await f.api.ensure(a);assert.equal(calls,1);clock=60001;await f.api.ensure(a);assert.equal(a.lat,37.5);assert.equal(calls,2);});
test('signout purges page memory and ignores an old in-flight response',async()=>{let release;const gate=new Promise(r=>release=r),f=make({lookup:async()=>{await gate;return{lat:37.5,lng:127};}}),a=row(),task=f.api.ensure(a);await Promise.resolve();f.api.clear();release();await task;assert.equal(a.lat,null);assert.equal(f.api.summary().located,0);});
test('projection never mutates the raw snapshot or serializes provider data through status',async()=>{const raw={...row()},a={...raw,raw},f=make();await f.api.ensure(a);assert.equal(raw.lat,null);assert(!JSON.stringify(f.api.summary()).includes('37.5'));assert.equal(f.api.summary().retention,'PAGE_MEMORY_ONLY');});
test('a later source generation retries newly registered Customer rows without requerying confirmed addresses',async()=>{let clock=0,ready=false,reads=0;const f=make({now:()=>clock,readAddress:async r=>{reads++;if(!ready)throw Object.assign(Error(),{status:404});return{customerCode:r.customerCode,address:'합성시 새주소로 10'};}}),a={...row(),address:''};f.api.onSourceSync('v1');await f.api.ensure(a);assert.equal(f.api.summary().review,1);clock=300001;ready=true;f.api.onSourceSync('v2');await f.api.ensure(a);assert.equal(a.coordinateSource,'KAKAO_ADDRESS_LIVE');f.api.onSourceSync('v3');await f.api.ensure(a);assert.equal(f.calls(),1);assert.equal(reads,2);});
test('fresh selected private detail invalidates a hashless old live address without changing raw data',async()=>{const f=make(),a=row(),raw=JSON.stringify(a);await f.api.ensure(a);f.api.acceptAddress(a,{customerCode:a.customerCode,address:'합성시 변경로 99',sourceBasis:'CURRENT_CUSTOMER_LOOKUP',locationState:'SOURCE_ROW'});assert.equal(a.lat,null);assert.equal(a.address,JSON.parse(raw).address);await f.api.ensure(a);assert.equal(f.calls(),2);assert.equal(a.coordinateSource,'KAKAO_ADDRESS_LIVE');});
test('dated fallback requires its exact last-observed date and cannot replace an established GPS or manual pin',async()=>{const f=make(),source={customerCode:'S990001',address:'합성시 다른로 99',sourceBasis:'DATED_DELIVERY_LOOKUP',currentMasterState:'NOT_FOUND',detailDate:'2026-11-04',locationState:'SOURCE_ROW'};for(const coordinateSource of ['RAW_GPS','MANUAL_PIN']){const a={...row(),lat:37.4,lng:127.1,coordinateSource,lastDeliveryDate:'2026-11-04'},before=JSON.stringify(a);f.api.acceptAddress(a,source);assert.equal(JSON.stringify(a),before);}const a={...row(),lastDeliveryDate:'2026-11-03'};await f.api.ensure(a);f.api.acceptAddress(a,source);assert.equal(a.coordinateSource,'KAKAO_ADDRESS_LIVE');assert.equal(f.calls(),1);});
test('a canonical synced delivery date rechecks a hashless address without reusing an earlier building',async()=>{let reads=0;const f=make({readAddress:async r=>({customerCode:r.customerCode,address:++reads===1?'합성시 첫로 10':'합성시 변경로 99'})}),a={...row(),address:'',lastDeliveryDate:'2026-11-03'};f.api.onSourceSync('v1',[a]);await f.api.ensure(a);a.lastDeliveryDate='2026-11-04';f.api.onSourceSync('v2',[a]);f.api.apply(a);assert.equal(a.lat,null);await f.api.ensure(a);assert.equal(reads,2);assert.equal(f.calls(),2);});
test('filtered copies with older dates cannot invalidate the canonical customer address',async()=>{const f=make({readAddress:async r=>({customerCode:r.customerCode,address:'합성시 합성로 10'})}),a={...row(),address:'',lastDeliveryDate:'2026-11-04'};await f.api.ensure(a);const filtered={...a,lastDeliveryDate:'2026-11-03'};f.api.apply(filtered);assert.equal(filtered.coordinateSource,'KAKAO_ADDRESS_LIVE');assert.equal(f.api.summary().located,1);assert.equal(f.calls(),1);});
test('local daily limit defers a customer until KST midnight without rerendering unchanged pins',async()=>{
 const midnight=Date.parse('2026-11-06T15:00:00Z');let clock=midnight-1,calls=0,renders=0;
 const {api}=make({now:()=>clock,onChange:()=>renders++,lookup:async()=>{
  if(++calls===1)throw Object.assign(Error(),{code:'GEOCODE_DAILY_LIMIT'});
  return {lat:37.5,lng:127};
 }}),store=row();
 await api.ensure(store);assert.equal(api.status(store).state,'DEFERRED');assert.equal(api.status(store).retryAt,midnight);
 await api.ensure(store);assert.equal(calls,1);assert.equal(renders,0);
 clock=midnight;assert.equal(api.canSchedule(store),true);
 await api.ensure(store);assert.equal(api.status(store).state,'LOCATED');assert.equal(calls,2);assert.equal(renders,1);
});
test('a mismatched GPS is hidden before lookup and retains its source evidence',async()=>{
 const current='a'.repeat(64),old='b'.repeat(64),a={...row(),lat:37.55,lng:126.94,coordinateSource:'RAW_GPS',addressHash:current,currentAddressHash:current,customerRegistryAddressHash:current,currentMasterStatus:'FOUND',raw:{originalAddressHash:old}};
 const {api,calls}=make();
 assert.equal(api.status(a).state,'WAITING');
 api.apply(a);
 assert.equal(a.lat,null);assert.equal(a.lng,null);assert.equal(a.coordinateStatus,'CONFLICT');
 assert.equal(a.coordinateEvidence.lat,37.55);assert.equal(a.raw.originalAddressHash,old);
 await api.ensure(a);
 assert.equal(a.coordinateSource,'KAKAO_ADDRESS_LIVE');
 assert.equal(api.status(a).state,'LOCATED');
 assert.equal(calls(),1);
});
test('an address-bound manual overlay supersedes the older GPS address hash',async()=>{
 const current='a'.repeat(64),a={...row(),lat:37.5,lng:127,coordinateSource:'MANUAL_PIN',resolutionStatus:'MANUAL_CONFIRMED',currentAddressHash:current,manualPinAddressHash:current,raw:{originalAddressHash:'b'.repeat(64)}};
 const {api,calls}=make();await api.ensure(a);
 assert.equal(api.status(a).state,'ESTABLISHED');assert.equal(a.lat,37.5);assert.equal(calls(),0);
});
