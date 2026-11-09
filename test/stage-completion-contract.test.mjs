import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {createOfficialAddressReview,officialAddressKey} from '../src/opsmapOfficialAddressLookup.js';
import {createKakaoCoordinateConnection} from '../src/opsmap-abc/kakaoCoordinateConnection.js';
import {privateReaderEndpoint} from '../src/opsmap-abc/privateReaderEndpoint.js';
import {createStageGenerationRestore} from '../src/stageGenerationRestore.js';
import {STAGE_ORIGIN,STAGE_SERVICE} from '../src/stageAbValidation.js';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const scope={RENDER_SERVICE_ID:STAGE_SERVICE,RENDER_EXTERNAL_URL:STAGE_ORIGIN};

test('exact road and parcel aliases present seven independent options with no default coordinate',async()=>{
  const road='경기도 오산시 새주소로 10', lot='경기도 오산시 오산동 10';
  const row={road,lot,kind:'CHOOSE',points:Array.from({length:7},(_,i)=>[37.1+i/1000,127.1])};
  const manual={road:'경기도 오산시 새주소로 20',lot:'경기도 오산시 오산동 20',kind:'MANUAL',points:[]};
  const bytes=Buffer.from(JSON.stringify({schema:'opsmap-official-address-review-v1',
    rows:[...([road,lot].map(query=>({...row,key:sha(officialAddressKey(query))}))),{...manual,key:sha(officialAddressKey(manual.road))}]}));
  const index=createOfficialAddressReview(bytes,{sha256:sha(bytes)});
  let outbound=0;
  const service=createKakaoCoordinateConnection({env:{OPSMAP_STAGE_VERIFY_ONLY:'1'},independentAddressLookup:()=>index,
    fetchImpl:async()=>{outbound++;throw Error('FORBIDDEN');}});
  for(const query of ['경기 오산시 새주소로 10 (상세)',lot]){
    const result=await service.lookup(query,{mode:'official'});
    assert.equal(result.data.resolution.kind,'CHOOSE');
    assert.equal(result.data.documents.length,7);
    assert.equal(result.data.coordinatePersistence,false);
  }
  const unavailable=await service.lookup(manual.road,{mode:'official'});
  assert.equal(unavailable.data.resolution.kind,'MANUAL');
  assert.equal(unavailable.data.documents.length,0);
  await assert.rejects(service.lookup(lot,{mode:'address'}),/GEOCODING_DISABLED/);
  assert.equal(outbound,0);
});

test('only approved Stage dated requests may use their separate Google reader',()=>{
  const exec=value=>'https://script.google.com/macros/s/'+value.repeat(24)+'/exec';
  const options={...scope,HUB_API_URL:exec('A'),HUB_API_SECRET:'a'.repeat(32),OPSMAP_STAGE_DATED_READER_APPROVED:'1',
    OPSMAP_STAGE_DATED_READER_URL:exec('B'),OPSMAP_STAGE_DATED_READER_SECRET:'b'.repeat(32)};
  assert.equal(privateReaderEndpoint('datedAssignments',options).url,exec('B'));
  assert.equal(privateReaderEndpoint('routePlan',options).url,exec('A'));
  assert.equal(privateReaderEndpoint('datedAssignments',{...options,RENDER_SERVICE_ID:'production'}).url,exec('A'));
  assert.throws(()=>privateReaderEndpoint('datedAssignments',{...options,OPSMAP_STAGE_DATED_READER_SECRET:options.HUB_API_SECRET}),
    /PRIVATE_READER_CONFIGURATION_INVALID/);
  assert.throws(()=>privateReaderEndpoint('datedAssignments',{...options,OPSMAP_STAGE_DATED_READER_URL:'https://example.invalid'}),
    /PRIVATE_READER_CONFIGURATION_INVALID/);
});

test('durable Stage follower merges reads and reports the last verified copy after invalid data',async()=>{
  let clock=0, opens=0, installs=0, version=1, bad=false;
  const openFile=async()=>{
    opens++;
    return {async stat(){return {mode:0o100600,dev:1,ino:1,size:1,mtimeMs:version,ctimeMs:version,isFile:()=>true};},
      async read(data){data[0]=version;return {bytesRead:1};},async close(){}};
  };
  const validation={async activate(bytes,opts){assert.equal(opts.durableRead,true);if(bad)throw Error('UNVERIFIED');assert.equal(bytes[0],1);installs++;}};
  const env={...scope,OPSMAP_STAGE_APPROVED_GENERATION_FILE:'1'};
  const run=createStageGenerationRestore({env,validation,openFile,now:()=>clock});
  const [a,b]=await Promise.all([run.refresh(),run.refresh()]);
  assert.equal(a.state,'VERIFIED');
  assert.deepEqual(a,b);
  assert.equal(opens,1);
  assert.equal(installs,1);
  clock=60_001;version++;bad=true;
  assert.equal((await run.refresh()).state,'LAST_VERIFIED_RETAINED');
  assert.equal(run.status().lastVerifiedAt,a.lastVerifiedAt);
  await run.refresh();
  assert.equal(opens,2);
  assert.equal((await createStageGenerationRestore({env:{...env,RENDER_SERVICE_ID:'production'},validation,openFile}).refresh()).state,'NOT_CONFIGURED');
  assert.equal(opens,2);
});
