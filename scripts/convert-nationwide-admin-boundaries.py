"""Validate the official 2025-06-30 SHP and write lossless county shards, never a browser bundle."""
import argparse
import gzip
import hashlib
import io
import json
import struct
import zipfile
from collections import defaultdict
from pathlib import Path
import shapefile
from pyproj import CRS, Transformer
from shapely.geometry import shape, mapping
from shapely.ops import transform


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--zip', required=True)
    parser.add_argument('--output-dir', required=True)
    args = parser.parse_args()
    archive = Path(args.zip).read_bytes()
    z = zipfile.ZipFile(io.BytesIO(archive))
    stems = [n[:-4] for n in z.namelist() if n.endswith('bnd_dong_00_2025_2Q.shp')]
    if len(stems) != 1:
        raise ValueError('SGIS_SOURCE_SHP_REQUIRED')
    stem = stems[0]
    blobs = {ext: z.read(stem + '.' + ext) for ext in ['shp', 'shx', 'dbf', 'prj', 'cpg']}
    crs = CRS.from_wkt(blobs['prj'].decode('utf-8'))
    if crs.to_epsg() != 5179 or blobs['cpg'].decode().strip().upper() != 'UTF-8':
        raise ValueError('SGIS_SOURCE_CRS_OR_ENCODING_CHANGED')
    # Verify SHX offsets against the actual SHP records as well as DBF row count.
    if len(blobs['shx']) < 100 or (len(blobs['shx']) - 100) % 8:
        raise ValueError('SGIS_SOURCE_SHX_INVALID')
    offsets = [struct.unpack('>II', blobs['shx'][i:i + 8]) for i in range(100, len(blobs['shx']), 8)]
    if (not offsets or offsets[0][0] != 50
            or any(struct.unpack('>I', blobs[ext][24:28])[0] * 2 != len(blobs[ext]) for ext in ['shp', 'shx'])
            or any(offsets[i - 1][0] + offsets[i - 1][1] + 4 != offset for i, (offset, _) in enumerate(offsets) if i)
            or (offsets[-1][0] + offsets[-1][1] + 4) * 2 != len(blobs['shp'])):
        raise ValueError('SGIS_SOURCE_SHP_LENGTH_INVALID')
    if any(struct.unpack('>II', blobs['shp'][offset * 2:offset * 2 + 8]) != (i + 1, size)
           or (offset + size) * 2 + 8 > len(blobs['shp']) for i, (offset, size) in enumerate(offsets)):
        raise ValueError('SGIS_SOURCE_SHX_OFFSET_INVALID')
    reader = shapefile.Reader(shp=io.BytesIO(blobs['shp']), shx=io.BytesIO(blobs['shx']),
                              dbf=io.BytesIO(blobs['dbf']), encoding='utf-8')
    if reader.shapeType != shapefile.POLYGON or len(reader) != len(offsets):
        raise ValueError('SGIS_SOURCE_RECORD_COUNT_INVALID')
    convert = Transformer.from_crs(crs, 'EPSG:4326', always_xy=True)
    metadata = {
        'sourceUrl': 'https://www.data.go.kr/data/15129688/fileData.do',
        'provider': '국가데이터처 통계지리정보서비스(SGIS)',
        'boundaryType': 'ADMINISTRATIVE_EMD', 'codeSystem': 'SGIS_ADM_8',
        'baseDate': '2025-06-30', 'crs': 'EPSG:4326', 'sourceCrs': 'EPSG:5179',
        'license': 'PUBLIC_DATA_UNRESTRICTED',
        'licenseUrl': 'https://www.data.go.kr/ugs/selectPortalPolicyView.do',
        'coverage': 'NATIONWIDE', 'partialCoverage': False,
        'sourceproof': {'archiveSha256': digest(archive), 'catalogModifiedDate': '2026-07-23',
                        'licenseEvidence': 'Official catalog JSON-LD: isAccessibleForFree=true; license=이용허락범위 제한 없음; spatialCoverage=대한민국 전체(전국)',
                        'geometryBaseDateEvidence': 'All DBF.BASE_DATE=20250630',
                        'crsEvidence': 'official PRJ resolves EPSG:5179'},
        'transform': 'pyproj always_xy EPSG:5179 to EPSG:4326; no simplification, rounding, clipping, repair or dissolve'
    }
    grouped = defaultdict(list)
    entries = []
    codes = set()
    polygons = rings = vertices = holes = 0
    for sr in reader.iterShapeRecords():
        record = sr.record.as_dict()
        code = record['ADM_CD']
        if record['BASE_DATE'] != '20250630' or not code.isdigit() or len(code) != 8 or code in codes:
            raise ValueError('SGIS_SOURCE_DATE_OR_CODE_CHANGED')
        codes.add(code)
        native = shape(sr.shape.__geo_interface__)
        geometry = transform(convert.transform, native)
        if geometry.geom_type not in ('Polygon', 'MultiPolygon') or geometry.is_empty:
            raise ValueError('SGIS_SOURCE_GEOMETRY_INVALID')
        parts = [geometry] if geometry.geom_type == 'Polygon' else list(geometry.geoms)
        native_parts = [native] if native.geom_type == 'Polygon' else list(native.geoms)
        if [len(p.interiors) for p in parts] != [len(p.interiors) for p in native_parts]:
            raise ValueError('SGIS_SOURCE_RING_CHANGED')
        for part in parts:
            polygons += 1
            holes += len(part.interiors)
            for ring in [part.exterior, *part.interiors]:
                rings += 1
                vertices += len(ring.coords)
                if not ring.is_closed:
                    raise ValueError('SGIS_SOURCE_RING_OPEN')
        bbox = list(geometry.bounds)
        if bbox[0] < 124 or bbox[1] < 33 or bbox[2] > 132 or bbox[3] > 39.5:
            raise ValueError('SGIS_SOURCE_OUTSIDE_KOREA')
        shard = code[:5] + '.geojson.gz'
        feature = {'type': 'Feature', 'properties': {'adm_cd': code, 'adm_nm': record['ADM_NM'],
                                                    'base_date': '2025-06-30'}, 'geometry': mapping(geometry)}
        entries.append({'code': code, 'bbox': bbox, 'shard': shard, 'jsonBytes': len(encode(feature))})
        grouped[shard].append(feature)
    if len(codes) != len(reader):
        raise ValueError('SGIS_SOURCE_INCOMPLETE')
    out = Path(args.output_dir)
    out.mkdir(parents=True, exist_ok=True)
    shards = []
    entry_by_code = {e['code']: e for e in entries}
    for county, features in sorted(grouped.items()):
        batches, batch, batch_bytes = [], [], 0
        for feature in features:
            size = entry_by_code[feature['properties']['adm_cd']]['jsonBytes']
            if batch and batch_bytes + size > 4 * 1024 * 1024:
                batches.append(batch)
                batch, batch_bytes = [], 0
            batch.append(feature)
            batch_bytes += size
        batches.append(batch)
        for index, batch in enumerate(batches):
            name = county if len(batches) == 1 else county[:5] + f'-{index:02d}.geojson.gz'
            for feature in batch:
                entry_by_code[feature['properties']['adm_cd']]['shard'] = name
            raw = encode({'type': 'FeatureCollection', 'metadata': {**metadata, 'coverage': 'REGIONAL'}, 'features': batch})
            compressed = gzip.compress(raw, compresslevel=9, mtime=0)
            (out / name).write_bytes(compressed)
            shards.append({'file': name, 'sha256': digest(compressed), 'featureCount': len(batch),
                           'jsonBytes': len(raw), 'gzipBytes': len(compressed)})
    manifest = {'schema': 'SGIS_ADMIN_SHARDS_V1', 'metadata': metadata, 'featureCount': len(codes),
                'sourceFiles': [{'name': Path(stem + '.' + ext).name, 'bytes': len(b), 'sha256': digest(b)}
                                for ext, b in blobs.items()],
                'verification': {'dbfRecords': len(reader), 'shxRecords': len(offsets), 'shpRecords': len(codes),
                                 'polygonCount': polygons, 'ringCount': rings, 'holeCount': holes, 'vertexCount': vertices,
                                 'allSourceRecordsConverted': True, 'originalRingTopologyRetained': True},
                'shards': shards, 'entries': entries}
    (out / 'manifest.json').write_bytes(encode(manifest))
    print(json.dumps({'featureCount': len(codes), 'shardCount': len(shards), 'gzipBytes': sum(s['gzipBytes'] for s in shards),
                      'verification': manifest['verification'], 'manifestSha256': digest(encode(manifest))}))


if __name__ == '__main__':
    main()
