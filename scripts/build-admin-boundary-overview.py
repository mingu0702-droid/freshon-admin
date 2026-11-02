"""Build display-only LOD from already verified full boundaries; point joins always use the full source."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
from pyproj import Transformer
from shapely import transform
from shapely.geometry import shape, mapping, MultiPolygon


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def parts(geometry):
    return [geometry] if geometry.geom_type == 'Polygon' else list(geometry.geoms)


def counts(geometry):
    polygons = parts(geometry)
    return len(polygons), [len(p.interiors) for p in polygons]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-dir', required=True)
    parser.add_argument('--output-dir', required=True)
    args = parser.parse_args()
    source, out = Path(args.source_dir), Path(args.output_dir)
    source_bytes = (source / 'manifest.json').read_bytes()
    source_hash = sha(source_bytes)
    if source_hash != '36e2325be7867461450314b0f3071e11f3e67dce556879b5d5846fa7649a6e2a':
        raise ValueError('FULL_SOURCE_MANIFEST_CHANGED')
    manifest = json.loads(source_bytes)
    out.mkdir(parents=True, exist_ok=True)
    to_metric = Transformer.from_crs(4326, 5179, always_xy=True)
    to_wgs = Transformer.from_crs(5179, 4326, always_xy=True)
    metadata = {**manifest['metadata'], 'geometryRole': 'DISPLAY_ONLY', 'displayDetail': 'overview',
                'sourceManifestSha256': source_hash,
                'displayTransform': 'EPSG:4326 to EPSG:5179; GEOS simplify 75m preserve_topology=True; EPSG:4326; original polygons restored if simplification introduces triangles or invalid topology'}
    output_shards, entries = [], []
    entries_by_code = {e['code']: e for e in manifest['entries']}
    vertex_count = polygon_count = hole_count = triangle_fallbacks = feature_fallbacks = 0
    for proof in manifest['shards']:
        raw_source = (source / proof['file']).read_bytes()
        if sha(raw_source) != proof['sha256']:
            raise ValueError('FULL_SOURCE_SHARD_CHANGED')
        data = json.loads(gzip.decompress(raw_source))
        features = []
        for feature in data['features']:
            native = transform(shape(feature['geometry']), to_metric.transform, interleaved=False)
            simple = native.simplify(75, preserve_topology=True)
            if simple.geom_type != native.geom_type or counts(simple) != counts(native):
                raise ValueError('OVERVIEW_RING_TOPOLOGY_CHANGED')
            preserved = []
            for original, reduced in zip(parts(native), parts(simple)):
                old_rings, new_rings = [original.exterior, *original.interiors], [reduced.exterior, *reduced.interiors]
                if any(len(new.coords) < 5 <= len(old.coords) for old, new in zip(old_rings, new_rings)):
                    preserved.append(original)
                    triangle_fallbacks += 1
                else:
                    preserved.append(reduced)
            simple = preserved[0] if native.geom_type == 'Polygon' else MultiPolygon(preserved)
            if native.is_valid and not simple.is_valid:
                simple = native
                feature_fallbacks += 1
            geometry = transform(simple, to_wgs.transform, interleaved=False)
            if geometry.geom_type != native.geom_type or counts(geometry) != counts(native):
                raise ValueError('OVERVIEW_RING_TOPOLOGY_CHANGED')
            for polygon in parts(geometry):
                polygon_count += 1
                hole_count += len(polygon.interiors)
                for ring in [polygon.exterior, *polygon.interiors]:
                    if not ring.is_closed:
                        raise ValueError('OVERVIEW_RING_OPEN')
                    vertex_count += len(ring.coords)
            displayed = {**feature, 'geometry': mapping(geometry)}
            features.append(displayed)
            entries.append({**entries_by_code[feature['properties']['adm_cd']], 'jsonBytes': len(encode(displayed))})
        raw = encode({'type': 'FeatureCollection', 'metadata': {**metadata, 'coverage': 'REGIONAL'}, 'features': features})
        compressed = gzip.compress(raw, compresslevel=9, mtime=0)
        (out / proof['file']).write_bytes(compressed)
        output_shards.append({'file': proof['file'], 'sha256': sha(compressed), 'featureCount': len(features),
                              'jsonBytes': len(raw), 'gzipBytes': len(compressed)})
    verification = {'featureCount': len(entries), 'polygonCount': polygon_count, 'holeCount': hole_count,
                    'vertexCount': vertex_count, 'allFeaturePolygonAndHoleCountsPreserved': True,
                    'noIntroducedTriangleRings': True, 'triangleFallbackPolygons': triangle_fallbacks,
                    'validityFallbackFeatures': feature_fallbacks}
    result = {'schema': 'SGIS_ADMIN_RENDER_SHARDS_V1', 'metadata': metadata, 'sourceManifestSha256': source_hash,
              'toleranceMeters': 75, 'featureCount': len(entries), 'verification': verification,
              'shards': output_shards, 'entries': entries}
    raw = encode(result)
    (out / 'manifest.json').write_bytes(raw)
    print(json.dumps({'manifestSha256': sha(raw), 'gzipBytes': sum(s['gzipBytes'] for s in output_shards),
                      'jsonBytes': sum(s['jsonBytes'] for s in output_shards), 'verification': verification}))


if __name__ == '__main__':
    main()
