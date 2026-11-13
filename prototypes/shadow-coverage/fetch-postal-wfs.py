"""Download only the public national basic-zone layer from Seoul's WFS."""

import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen
from zipfile import ZipFile


ENDPOINT = 'https://energyinfo.seoul.go.kr/gis/wfs'
LAYER = 'magok:tl_kodis_bas'
FIELDS = 'bas_id,bas_mgt_sn,sig_cd,ctp_kor_nm,sig_kor_nm,opert_de,mvmn_de,ntfc_de'


def get_feature(**parameters):
    query = dict(service='WFS', version='2.0.0', request='GetFeature', typeNames=LAYER, **parameters)
    return urlopen(ENDPOINT + '?' + urlencode(query), timeout=90)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path, help='New source-data directory outside the repository')
    args = parser.parse_args()
    args.output.mkdir(parents=True)
    with get_feature(outputFormat='application/json', propertyName=FIELDS) as response:
        raw = response.read(32 * 1024 * 1024 + 1)
    if len(raw) > 32 * 1024 * 1024:
        raise ValueError('Public boundary attributes exceed the size limit')
    document = json.loads(raw)
    expected_count = document['numberMatched']
    rows = [feature['properties'] for feature in document['features']]
    counts = Counter(row['sig_cd'][:2] for row in rows)
    if (len(rows) != expected_count or len(counts) != 17 or
            len({row['bas_id'] for row in rows}) != expected_count or
            len({row['bas_mgt_sn'] for row in rows}) != expected_count):
        raise ValueError('Incomplete or conflicting nationwide boundary attributes')
    attribute_path = args.output / 'wfs-attributes.json'
    attribute_path.write_bytes(raw)
    regions = []
    for code, expected_regions in sorted(counts.items()):
        archive = args.output / f'{code}.zip'
        archive_hash = hashlib.sha256()
        count = 0
        with get_feature(outputFormat='SHAPE-ZIP', propertyName='bas_id,the_geom', CQL_FILTER=f"sig_cd LIKE '{code}%'") as response:
            if response.headers.get_content_type() != 'application/zip':
                raise ValueError(f'Unexpected official response for {code}')
            with archive.open('xb') as output:
                for chunk in iter(lambda: response.read(64 * 1024), b''):
                    count += len(chunk)
                    if count > 64 * 1024 * 1024:
                        raise ValueError(f'Official ZIP size limit exceeded for {code}')
                    archive_hash.update(chunk)
                    output.write(chunk)
        with ZipFile(archive) as ZIP:
            with ZIP.open('tl_kodis_bas.shx') as shx:
                index_bytes = ZIP.getinfo(shx.name).file_size
            if index_bytes != 100 + expected_regions * 8:
                raise ValueError(f'Incomplete official geometry response for {code}')
        regions.append({'code': code, 'count': expected_regions, 'sha256': archive_hash.hexdigest(), 'bytes': count})
        print(f'Downloaded {code}: {expected_regions} official geometries, {count} bytes', flush=True)
    last_change = max(row[field][:8] for row in rows for field in ('opert_de', 'mvmn_de', 'ntfc_de') if row[field])
    manifest = {
        'source': ENDPOINT,
        'layer': LAYER,
        'crs': 'EPSG:5179',
        'retrievedAt': document['timeStamp'],
        'publicationVintage': None,
        'latestSourceChange': f'{last_change[:4]}-{last_change[4:6]}-{last_change[6:8]}',
        'total': expected_count,
        'attributesSha256': hashlib.sha256(raw).hexdigest(),
        'regions': regions,
    }
    (args.output / 'wfs-source.json').write_text(json.dumps(manifest, ensure_ascii=False) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
