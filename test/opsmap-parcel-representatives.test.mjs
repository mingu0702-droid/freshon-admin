import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {completeFixedCoordinatesFromCatalog} from '../src/fixedCoordinateCompletion.js';
import {openPublicAddressCatalog} from '../src/opsmapPublicAddressCatalog.js';
import {coordinateAddressHash} from '../src/opsmap-abc/opsmapAutoCoordinates.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const python = process.platform === 'win32' ? 'python' : 'python3';
const fixture = String.raw`
from pathlib import Path
import json, sys, zipfile
import shapefile
from pyproj import CRS, Transformer
from shapely.geometry import Polygon
root = Path(sys.argv[1])
def postal(road, number, building, lot):
    fields = [''] * 26
    for i, value in {1:'경기도',3:'오산시',8:road,10:'0',11:number,12:'0',13:building,
                     16:'4136010100',17:'가동',20:'0',21:lot,23:'2'}.items():
        fields[i] = value
    return '|'.join(fields)
header = [''] * 26
for i, value in {1:'시도',3:'시군구',5:'읍면',8:'도로명',13:'건물관리번호',16:'법정동코드',
                 20:'산여부',21:'지번본번',23:'지번부번'}.items():
    header[i] = value
buildings = ['1'*24+str(i) for i in range(1,7)]
with zipfile.ZipFile(root/'postal.zip','w') as z:
    z.writestr('region.txt','\n'.join(['|'.join(header), postal('하늘로','25',buildings[0],'100'),
        postal('하늘로','25',buildings[1],'100'), postal('하늘로','50',buildings[2],'120'),
        postal('하늘로','50',buildings[3],'121'),postal('하늘로','75',buildings[4],'130'),
        postal('하늘로','75',buildings[5],'131')])+'\n')
with zipfile.ZipFile(root/'business.zip','w') as z:
    z.writestr('region.csv','건물관리번호,도로명주소,지번주소,위도,경도,건물명\n'+
        buildings[0]+',경기도 오산시 하늘로 25,경기도 오산시 가동 100-2,37.16,127.06,상가\n'+
        buildings[2]+',경기도 오산시 하늘로 50,경기도 오산시 가동 120-2,37.16,127.06,서관\n')
(root/'elevator.csv').write_text('건물명,건물주소,경도,위도\n', encoding='utf8')
with zipfile.ZipFile(root/'legal.zip','w') as z:
    z.writestr('legal.txt','법정동코드\t법정동명\t폐지여부\n4136010100\t경기도 오산시 가동\t존재\n'+
      '2826012200\t인천광역시 서구 청라동\t폐지\n2827511100\t인천광역시 서해구 청라동\t존재\n')
(root/'changes.json').write_text(json.dumps({'schema':'opsmap-official-legal-code-changes-v1','noticeSha256':'a'*64,
    'changes':[{'oldCode':'2826012200','newCode':'2827511100','effectiveDate':'2026-07-01'}]}))
(root/'sites.json').write_text(json.dumps({'schema':'opsmap-reviewed-campus-geometry-v1','datasetSha256':'b'*64,
    'date':'2026-09-30','sites':[{'address':'경기도 오산시 하늘로 75','identifier':'OSM:way:901',
    'parcelIds':['4136010100101300002','4136010100101310002'],'officialReference':'https://example.test/campus',
    'geometry':{'type':'Polygon','coordinates':[[[127.05,37.15],[127.07,37.15],[127.07,37.17],
        [127.05,37.17],[127.05,37.15]]]}}]}),encoding='utf8')
transform = Transformer.from_crs(4326,5186,always_xy=True)
x,y = transform.transform(127.06,37.16)
outer = [(x+dx,y+dy) for dx,dy in [(0,0),(0,100),(10,100),(10,10),(100,10),(100,0),(0,0)]]
polygon = Polygon(outer)
assert not polygon.contains(polygon.centroid)
with shapefile.Writer(str(root/'parcels'),shapeType=shapefile.POLYGON) as shp:
    shp.field('PNU','C',19)
    shp.poly([outer]); shp.record('4136010100201230004')
    shp.poly([[(a-200,b-200) for a,b in outer]]); shp.record('2826012200100080137')
(root/'parcels.prj').write_text(CRS.from_epsg(5186).to_wkt(),encoding='utf8')
interior = polygon.representative_point()
lng,lat = Transformer.from_crs(5186,4326,always_xy=True).transform(interior.x,interior.y)
(root/'point.json').write_text(json.dumps([lat,lng]))
`;

function run(args) {
  const result = spawnSync(python,['-X','utf8','-B',...args],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
}

test('representative resolution preserves exact parcels, shared customer coordinates and address history', async t => {
  const dependencies = spawnSync(python,['-c','import shapefile, pyproj, shapely']);
  if (dependencies.status !== 0) return t.skip('Offline geometry build dependencies are unavailable');
  const root = await fs.mkdtemp(path.join(tmpdir(),'opsmap-parcel-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const file = name => path.join(root,name);
  run(['-c',fixture,root]);
  const helper = 'scripts/opsmap-public-address-catalog.py';
  const base = file('base.sqlite'), parcel = file('parcel.sqlite');
  run([helper,'build',base,'--postal',file('postal.zip'),'--business',file('business.zip'),'--elevator',file('elevator.csv'),
    '--business-date','2026-09-30','--elevator-date','2025-12-12']);
  run([helper,'build-parcel',parcel,'--postal',file('postal.zip'),'--postal-observed-on','2026-11-10',
    '--legal-dongs',file('legal.zip'),'--code-changes',file('changes.json'),'--parcel-shape',file('parcels.shp')+'=2026-06-30',
    '--site-index',file('sites.json')]);
  const catalog = await openPublicAddressCatalog({file:base,sha256:sha(await fs.readFile(base)),
    parcelIndex:{file:parcel,sha256:sha(await fs.readFile(parcel))}});

  const row = (code,address) => ({code,address,registered:true});
  const shared = '경기 오산시 하늘로25';
  const parcelOnly = '경기도 오산시 가동 산123-4';
  const oldAddress = '인천시 서구 청라동8-137';
  const stores = [
    row('S901',shared),row('S902',shared),row('S903',parcelOnly),row('S904',oldAddress),
    row('S905','경기 오산시 하늘로 50 (서관)'),row('S906','인천광역시 서해구 청라동 산8-137'),
    row('S907','인천광역시 서해구 청라동 8'),row('S908',shared),row('S909','경기도 오산시 하늘로 75')
  ];
  const body = {schema:'opsmap-fixed-store-coordinates-v1',revision:0,records:{}};
  const empty = {...body,sha256:sha(JSON.stringify(body))};
  const now = () => Date.parse('2026-11-11T00:00:00Z');
  const manualRows = [{customerCode:'S908',originalAddressHash:coordinateAddressHash(shared),
    resolutionStatus:'MANUAL_CONFIRMED',latitude:37.175,longitude:127.06}];
  const options = {stores,ledger:empty,now,manualRows};
  await assert.rejects(completeFixedCoordinatesFromCatalog(options,{async resolveMany() {
    throw Error('PUBLIC_ADDRESS_CATALOG_READ');
  }}),/PUBLIC_ADDRESS_CATALOG_READ/);
  assert.deepEqual(empty.records,{});
  const first = await completeFixedCoordinatesFromCatalog(options,catalog);
  const point = code => first.ledger.records[code].at(-1).point;
  assert.equal(first.summary.added,5);
  assert.deepEqual([point('S901').lat,point('S901').lng],[point('S902').lat,point('S902').lng]);
  assert.equal(point('S901').representative.identifier,'PNU:4136010100101000002');
  assert.equal(point('S903').coordinateSource,'PARCEL_REPRESENTATIVE');
  assert.deepEqual([point('S903').lat,point('S903').lng],JSON.parse(await fs.readFile(file('point.json'),'utf8')));
  assert.equal(point('S904').representative.identifier,'PNU:2827511100100080137');
  assert.equal(point('S904').representative.sourceParcel,'2826012200100080137');
  assert.equal(point('S904').representative.normalizedAddress,'인천광역시 서해구 청라동 8-137');
  assert.equal(first.stores.find(s=>s.code==='S904').address,oldAddress);
  const status = code => first.decisions.find(s=>s.customerCode===code).status;
  assert.equal(status('S905'),'MULTIPLE_PARCELS');
  assert.equal(status('S906'),'PARCEL_GEOMETRY_UNAVAILABLE');
  assert.equal(status('S907'),'PARCEL_GEOMETRY_UNAVAILABLE');
  assert.equal(status('S908'),'PRESERVED_MANUAL');
  assert.equal(first.stores.find(s=>s.code==='S908').lat,37.175);
  assert.equal(point('S909').coordinateSource,'CAMPUS_REPRESENTATIVE');
  assert.equal(point('S909').representative.parcelIds.length,2);

  const duplicate = await completeFixedCoordinatesFromCatalog({...options,ledger:first.ledger},catalog);
  assert.equal(duplicate.ledger.sha256,first.ledger.sha256);
  const moved = await completeFixedCoordinatesFromCatalog({...options,ledger:first.ledger,
    stores:stores.map(s=>s.code==='S901'?{...s,address:parcelOnly}:s)},catalog);
  assert.equal(moved.summary.rebound,1);
  assert.deepEqual(moved.ledger.records.S901[0],first.ledger.records.S901[0]);
  assert.equal(moved.ledger.records.S901[1].point.representative.kind,'PARCEL');
});
