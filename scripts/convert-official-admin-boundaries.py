"""Subset official SGIS SHP by private verified points; output contains geometry only.
Requires pyshp, pyproj and shapely. Never simplify, round, repair, or dissolve rings.
"""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import zipfile
import shapefile
from pyproj import CRS, Transformer
from shapely.geometry import Point, shape, mapping
from shapely.ops import transform

parser = argparse.ArgumentParser()
parser.add_argument('--zip', required=True)
parser.add_argument('--points', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
private = json.loads(Path(args.points).read_text(encoding='utf-8-sig'))
points = [p for group in private['groups'].values() for p in group]
points = [(float(p['lng']), float(p['lat'])) for p in points
          if 124 <= float(p['lng']) <= 132 and 33 <= float(p['lat']) <= 39.5]
if not points:
    raise ValueError('VERIFIED_POINTS_REQUIRED')
archive = Path(args.zip).read_bytes()
z = zipfile.ZipFile(io.BytesIO(archive))
stem = next(n[:-4] for n in z.namelist() if n.endswith('bnd_dong_00_2025_2Q.shp'))
blobs = {ext: z.read(stem + '.' + ext) for ext in ['shp', 'dbf', 'prj']}
crs = CRS.from_wkt(blobs['prj'].decode('utf-8'))
if crs.to_epsg() != 5179:
    raise ValueError('SGIS_SOURCE_CRS_CHANGED')
to_source = Transformer.from_crs('EPSG:4326', crs, always_xy=True)
to_wgs84 = Transformer.from_crs(crs, 'EPSG:4326', always_xy=True)
source_points = [Point(*to_source.transform(*p)) for p in points]
reader = shapefile.Reader(shp=io.BytesIO(blobs['shp']), dbf=io.BytesIO(blobs['dbf']), encoding='utf-8')
features = []
for sr in reader.iterShapeRecords():
    b = sr.shape.bbox
    nearby = [p for p in source_points if b[0] <= p.x <= b[2] and b[1] <= p.y <= b[3]]
    if not nearby:
        continue
    native = shape(sr.shape.__geo_interface__)
    if not any(native.covers(p) for p in nearby):
        continue
    record = sr.record.as_dict()
    if record['BASE_DATE'] != '20250630' or len(record['ADM_CD']) != 8:
        raise ValueError('SGIS_SOURCE_DATE_OR_CODE_CHANGED')
    geometry = transform(to_wgs84.transform, native)
    if geometry.geom_type not in ['Polygon', 'MultiPolygon']:
        raise ValueError('SGIS_SOURCE_GEOMETRY_INVALID')
    # No customer identifiers, coordinates, assignments, or selected vehicle list.
    features.append({'type': 'Feature', 'properties': {
        'adm_cd': record['ADM_CD'], 'adm_nm': record['ADM_NM'], 'base_date': '2025-06-30'
    }, 'geometry': mapping(geometry)})
metadata = {
    'sourceUrl': 'https://www.data.go.kr/data/15129688/fileData.do',
    'provider': '국가데이터처 통계지리정보서비스(SGIS)',
    'boundaryType': 'ADMINISTRATIVE_EMD', 'codeSystem': 'SGIS_ADM_8',
    'baseDate': '2025-06-30', 'crs': 'EPSG:4326', 'sourceCrs': 'EPSG:5179',
    'license': 'PUBLIC_DATA_UNRESTRICTED',
    'licenseUrl': 'https://www.data.go.kr/ugs/selectPortalPolicyView.do',
    'coverage': 'SUBSET', 'partialCoverage': True,
    'sourceproof': {'archiveSha256': hashlib.sha256(archive).hexdigest(),
                    'shpSha256': hashlib.sha256(blobs['shp']).hexdigest(),
                    'dbfSha256': hashlib.sha256(blobs['dbf']).hexdigest(),
                    'prjSha256': hashlib.sha256(blobs['prj']).hexdigest(),
                    'catalogModifiedDate': '2026-07-23',
                    'geometryBaseDateEvidence': 'DBF.BASE_DATE=20250630; bundled official db_schema identifies administrative EMD June 2025',
                    'crsEvidence': 'official PRJ resolves EPSG:5179',
                    'licenseEvidence': 'official catalog: free, unrestricted use'},
    'transform': 'pyproj always_xy EPSG:5179 to EPSG:4326; no simplification, rounding, clipping, repair or dissolve'
}
payload = {'type': 'FeatureCollection', 'metadata': metadata, 'features': features}
raw = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
compressed = gzip.compress(raw, compresslevel=9, mtime=0)
out = Path(args.output)
out.parent.mkdir(parents=True, exist_ok=True)
out.write_bytes(compressed if out.suffix == '.gz' else raw)
proof = {
    'metadata': metadata, 'sourceArchiveSha256': hashlib.sha256(archive).hexdigest(),
    'sourceFiles': [{'name': Path(stem + '.' + ext).name, 'sha256': hashlib.sha256(b).hexdigest()} for ext, b in blobs.items()],
    'featureCount': len(features), 'jsonBytes': len(raw), 'gzipBytes': len(compressed),
    'sha256': hashlib.sha256(out.read_bytes()).hexdigest(),
    'verification': 'BASE_DATE=20250630; ADM_CD width=8; PRJ EPSG=5179; original Polygon/MultiPolygon rings retained; data.go.kr needCaptcha=false anonymous download'
}
out.with_name(out.name + '.sourceproof.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({k: proof[k] for k in ['featureCount', 'jsonBytes', 'gzipBytes', 'sha256']}))
