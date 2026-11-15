"""Compile display-only postal tiles, preserving every polygon and vertex."""

import argparse
import gzip
import hashlib
import json
import re
import struct
from pathlib import Path

from pyproj import Transformer


def sha(data):
    return hashlib.sha256(data).hexdigest()


def varint(out, value):
    while value >= 128:
        out.append((value & 127) | 128)
        value >>= 7
    out.append(value)


def projected_tile(raw, zone_count, project):
    words = memoryview(raw).cast('i')
    if raw[:4] != b'PCG1' or words[1] != zone_count:
        raise ValueError('POSTAL_OVERVIEW_SOURCE_TILE')
    packed = bytearray(b'PCO1')
    varint(packed, zone_count)
    cursor, vertices = 2, 0
    for _ in range(zone_count):
        zone, rings = words[cursor:cursor + 2]
        cursor += 6
        if not (1000 <= zone <= 99999 and 1 <= rings <= 800):
            raise ValueError('POSTAL_OVERVIEW_SOURCE_RING')
        varint(packed, zone)
        varint(packed, rings)
        for _ in range(rings):
            points = words[cursor]
            cursor += 1
            if points < 3 or cursor + points * 2 > len(words):
                raise ValueError('POSTAL_OVERVIEW_SOURCE_VERTICES')
            coordinates = words[cursor:cursor + points * 2]
            cursor += len(coordinates)
            xs, ys = project([value / 1e6 for value in coordinates[::2]],
                             [value / 1e6 for value in coordinates[1::2]])
            varint(packed, points)
            previous_x = previous_y = 0
            for x, y in zip(xs, ys):
                x, y = round(x * 2.5), round(y * 2.5)
                if abs(x) > 2_000_000 or abs(y) > 2_000_000:
                    raise ValueError('POSTAL_OVERVIEW_PROJECTION')
                for delta in (x - previous_x, y - previous_y):
                    varint(packed, delta * 2 if delta >= 0 else -delta * 2 - 1)
                previous_x, previous_y = x, y
            vertices += points
    if cursor != len(words):
        raise ValueError('POSTAL_OVERVIEW_SOURCE_LENGTH')
    return packed, vertices


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('geometry', type=Path)
    parser.add_argument('boundary_sha256')
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    if struct.pack('=i', 1) != b'\x01\x00\x00\x00':
        raise ValueError('POSTAL_OVERVIEW_BYTE_ORDER')
    official = (args.geometry / 'manifest.json').read_bytes()
    source = json.loads(official)
    if sha(official) != args.boundary_sha256 or source.get('schema') != 'opsmap-postal-geometry-v1':
        raise ValueError('POSTAL_OVERVIEW_BOUNDARY_HASH')
    project = Transformer.from_crs(4326, 5181, always_xy=True).transform
    args.output.mkdir()
    tiles, count, vertices = [], 0, 0
    for tile in source['tiers']['national']:
        name = tile['id']
        if re.fullmatch(r'national-\d+-\d+-\d+', name) is None or tile['rawBytes'] > 1024 * 1024:
            raise ValueError('POSTAL_OVERVIEW_SOURCE_TILE')
        compressed = (args.geometry / (name + '.gz')).read_bytes()
        if len(compressed) != tile['bytes'] or sha(compressed) != tile['sha256']:
            raise ValueError('POSTAL_OVERVIEW_SOURCE_HASH')
        raw = gzip.decompress(compressed)
        if len(raw) != tile['rawBytes']:
            raise ValueError('POSTAL_OVERVIEW_SOURCE_LENGTH')
        packed, size = projected_tile(raw, tile['count'], project)
        encoded = gzip.compress(packed, compresslevel=6, mtime=0)
        overview_name = name.replace('national-', 'overview-', 1)
        (args.output / (overview_name + '.gz')).write_bytes(encoded)
        tiles.append({'id': overview_name, 'count': tile['count'], 'vertices': size,
                      'bytes': len(encoded), 'rawBytes': len(packed), 'sha256': sha(encoded)})
        count += tile['count']
        vertices += size
    if count != source['count']:
        raise ValueError('POSTAL_OVERVIEW_SOURCE_COUNT')
    proof = {'schema': 'opsmap-postal-overview-v1', 'boundary': args.boundary_sha256,
             'projection': 'EPSG:5181*2.5', 'count': count, 'vertices': vertices, 'tiles': tiles}
    index = json.dumps(proof, separators=(',', ':')).encode('utf-8')
    (args.output / 'overview-index.json').write_bytes(index)
    print(json.dumps({'indexSha256': sha(index), 'sourceBoundarySha256': args.boundary_sha256,
                      'areas': count, 'vertices': vertices, 'files': len(tiles),
                      'gzipBytes': sum(tile['bytes'] for tile in tiles),
                      'rawBytes': sum(tile['rawBytes'] for tile in tiles)}, indent=2))


if __name__ == '__main__':
    main()
