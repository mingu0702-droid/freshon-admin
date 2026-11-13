"""Build the isolated postal prototype's index from official TL_KODIS_BAS ZIPs."""

import argparse
import hashlib
import json
import math
import re
import shutil
from pathlib import Path, PurePosixPath
from tempfile import TemporaryDirectory
from zipfile import ZipFile

import shapefile
from pyproj import CRS, Transformer
from shapely import make_valid, transform
from shapely.geometry import shape
from shapely.ops import unary_union


SHAPE_NAME = re.compile(r'(?:.*_)?TL_KODIS_BAS(?:_[0-9]{2})?\.(shp|shx|dbf|prj|cpg|cst)', re.I)
SOURCE_CRS = CRS.from_epsg(5179)
TO_WGS84 = Transformer.from_crs(SOURCE_CRS, 4326, always_xy=True)
ORIGINS = ('VWORLD_30054', 'MOIS_15050416', 'SEOUL_WFS')


def compact(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':'))


def sha256_file(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def unpack(archive_path, directory, is_wfs):
    with ZipFile(archive_path) as archive:
        parts = {}
        stems = set()
        for member in archive.infolist():
            path = PurePosixPath(member.filename)
            match = SHAPE_NAME.fullmatch(path.name)
            if not match:
                continue
            suffix = match.group(1).lower()
            if suffix in parts or member.file_size > 512 * 1024 * 1024:
                raise ValueError('Expected one official regional TL_KODIS_BAS layer per ZIP')
            stems.add(str(path.with_suffix('')).lower())
            parts[suffix] = member
        if len(stems) != 1 or not {'shp', 'shx', 'dbf'}.issubset(parts):
            raise ValueError('TL_KODIS_BAS requires matching SHP, SHX and DBF files')
        for suffix, member in parts.items():
            # Use fixed output names so archive member paths cannot escape temporary data.
            with archive.open(member) as source, (directory / f'layer.{suffix}').open('wb') as output:
                shutil.copyfileobj(source, output, length=64 * 1024)
    if 'prj' in parts:
        crs = CRS.from_wkt((directory / 'layer.prj').read_text(encoding='utf-8-sig'))
        # GeoServer's EPSG:5179 WKT explicitly carries an identity TOWGS84
        # datum transform, which PROJ represents as a BoundCRS.
        projected = crs.source_crs if crs.is_bound else crs
        authority = projected.to_json_dict().get('id')
        if not projected.equals(SOURCE_CRS, ignore_axis_order=True) and authority != {'authority': 'EPSG', 'code': 5179}:
            raise ValueError('Expected the documented EPSG:5179 source projection')
        transform_to_source = Transformer.from_crs(crs, SOURCE_CRS, always_xy=True)
        anchors = ((700_000, 1_400_000), (1_000_000, 2_000_000), (1_400_000, 2_100_000))
        for x, y in anchors:
            east, north = transform_to_source.transform(x, y)
            if not all(math.isfinite(value) for value in (east, north)) or abs(x - east) > 0.01 or abs(y - north) > 0.01:
                raise ValueError('Boundary projection datum does not match EPSG:5179')
        if is_wfs and [axis.direction for axis in projected.axis_info] != ['north', 'east']:
            raise ValueError('Official Seoul WFS projection axes changed')
    elif is_wfs:
        raise ValueError('Projection description is missing from official Seoul WFS archive')
    codepage = next((suffix for suffix in ('cpg', 'cst') if suffix in parts), None)
    if codepage:
        cpg = (directory / f'layer.{codepage}').read_text(encoding='utf-8-sig').strip().lower()
        if cpg in ('utf-8', 'utf8', '65001'):
            return 'utf-8'
        if cpg == 'iso-8859-1':
            return 'iso-8859-1'
        if cpg not in ('', 'cp949', '949', 'euc-kr', 'ks_c_5601-1987'):
            raise ValueError('Unexpected DBF encoding in TL_KODIS_BAS')
    return 'cp949'


def zones(archive_path, attributes):
    # Only one official regional source is extracted/loaded at a time.
    with TemporaryDirectory(prefix='opsmap-postal-source-') as temp:
        directory = Path(temp)
        encoding = unpack(archive_path, directory, attributes is not None)
        geometry_by_id = {}
        with shapefile.Reader(str(directory / 'layer.shp'), encoding=encoding) as reader:
            fields = {field[0].upper() for field in reader.fields}
            if 'BAS_ID' not in fields:
                raise ValueError('Native TL_KODIS_BAS BAS_ID field is missing')
            field_names = [field for field in ('BAS_ID', 'CTP_KOR_NM', 'SIG_KOR_NM') if field in fields]
            field_names = [field[0] for field in reader.fields if field[0].upper() in field_names]
            for feature in reader.iterShapeRecords(fields=field_names):
                properties = {key.upper(): str(value or '').strip() for key, value in feature.record.as_dict().items()}
                code = properties['BAS_ID']
                if not re.fullmatch(r'[0-9]{5}', code):
                    raise ValueError('Expected a 5-digit BAS_ID, including leading zeros')
                geometry = shape(feature.shape.__geo_interface__)
                if attributes is not None:
                    # GeoServer SHAPE-ZIP uses northing/easting ordered EPSG:5179.
                    # Confirmed against the same feature's GeoJSON representation.
                    geometry = transform(geometry, lambda north, east: (east, north), interleaved=False)
                repaired = not geometry.is_valid
                if repaired:
                    corrected = make_valid(geometry)
                    # Keep only polygonal components of repaired rings, retain and report
                    # all enclosed areas, and never assign a point from unrepairable data.
                    if corrected.geom_type == 'GeometryCollection':
                        corrected = unary_union([part for part in corrected.geoms if part.geom_type in ('Polygon', 'MultiPolygon')])
                    geometry = corrected
                if geometry.geom_type not in ('Polygon', 'MultiPolygon') or not geometry.is_valid or geometry.is_empty:
                    raise ValueError(f'Invalid native polygon for BAS_ID {code}')
                if attributes is not None:
                    properties = attributes[code]
                label = ' '.join(dict.fromkeys(filter(None, (properties.get('CTP_KOR_NM'), properties.get('SIG_KOR_NM'), code))))
                old_label, geometries = geometry_by_id.setdefault(code, (label, []))
                if old_label != label:
                    raise ValueError(f'Conflicting regional attributes for BAS_ID {code}')
                geometries.append((geometry, repaired))
        for code, (label, geometries) in geometry_by_id.items():
            geometry = geometries[0][0] if len(geometries) == 1 else unary_union([part for part, _ in geometries])
            yield code, label, geometry, any(fixed for _, fixed in geometries)


def coordinates(geometry):
    as_json = geometry.__geo_interface__
    rings = as_json['coordinates']
    return [rings] if as_json['type'] == 'Polygon' else rings


def serialize(code, label, geometry):
    exact = transform(geometry, TO_WGS84.transform, interleaved=False)
    west, south, east, north = exact.bounds
    if not (123 <= west < east <= 133 and 32 <= south < north <= 40):
        raise ValueError(f'Boundary for {code} is outside the documented South Korea coordinate range')
    center = exact.representative_point()
    # Simplify display geometry in source meters. Raw polygon governs inclusion and area.
    regional = transform(geometry.simplify(18, preserve_topology=True), TO_WGS84.transform, interleaved=False)
    overview = transform(geometry.simplify(250, preserve_topology=True), TO_WGS84.transform, interleaved=False)
    return {
        'id': code,
        'label': label,
        'areaKm2': geometry.area / 1_000_000,
        'center': [center.x, center.y],
        'bbox': [west, south, east, north],
        'rings': coordinates(exact),
        'regional': coordinates(regional),
        'overview': coordinates(overview),
    }


def write_region(directory, province, archive_path, all_codes, attributes=None):
    basename = f'postal-{province}.ndjson'
    target = directory / basename
    count = 0
    repaired_count = 0
    with target.open('xb') as output:
        for code, label, geometry, repaired in zones(archive_path, attributes):
            if code in all_codes:
                raise ValueError(f'Duplicate BAS_ID across regional archives: {code}')
            all_codes.add(code)
            line = (compact(serialize(code, label, geometry)) + '\n').encode('utf-8')
            if len(line) > 8 * 1024 * 1024:
                raise ValueError(f'Postal geometry exceeds record limit: {code}')
            output.write(line)
            count += 1
            repaired_count += repaired
    if not count:
        raise ValueError('Postal archive did not contain any boundary')
    return {
        'basename': basename,
        'bytes': target.stat().st_size,
        'count': count,
        'repaired': repaired_count,
        'sha256': sha256_file(target),
        'sourceSha256': sha256_file(archive_path),
    }


def wfs_sources(directory):
    provenance = json.loads((directory / 'wfs-source.json').read_text(encoding='utf-8'))
    attribute_path = directory / 'wfs-attributes.json'
    if (provenance.get('source') != 'https://energyinfo.seoul.go.kr/gis/wfs' or
            provenance.get('layer') != 'magok:tl_kodis_bas' or
            sha256_file(attribute_path) != provenance.get('attributesSha256')):
        raise ValueError('Official Seoul WFS source manifest does not match the supplied attributes')
    attributes = {}
    document = json.loads(attribute_path.read_text(encoding='utf-8'))
    for row in document['features']:
        props = {key.upper(): value for key, value in row['properties'].items()}
        attributes[props['BAS_ID']] = props
    if len(attributes) != provenance['total'] or provenance['total'] != sum(entry['count'] for entry in provenance['regions']):
        raise ValueError('Incomplete official Seoul WFS source')
    archives = {
        entry['code']: directory / f"{entry['code']}.zip" for entry in provenance['regions']
    }
    for entry in provenance['regions']:
        if sha256_file(archives[entry['code']]) != entry['sha256']:
            raise ValueError('Official Seoul WFS region hash mismatch')
    return archives, attributes, provenance


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--origin', choices=ORIGINS, default=ORIGINS[0])
    parser.add_argument('--vintage', help='Official source snapshot as YYYY-MM')
    parser.add_argument('--wfs-source', type=Path, help='Seoul WFS source directory from fetch-postal-wfs.py')
    parser.add_argument('--output', type=Path, required=True, help='New directory outside the repository')
    parser.add_argument('archive', nargs='*', help='Province code and acquired official ZIP as 41=path.zip')
    args = parser.parse_args()
    archive_map = dict(item.split('=', 1) for item in args.archive)
    if len(archive_map) != len(args.archive) or len(archive_map) > 17 or any(not re.fullmatch(r'[0-9]{2}', code) for code in archive_map):
        parser.error('Expected distinct official province codes')
    attributes = None
    provenance = {}
    if args.origin == 'SEOUL_WFS':
        if args.wfs_source is None or archive_map or args.vintage:
            parser.error('Seoul WFS requires --wfs-source and has no documented file vintage')
        archive_map, attributes, provenance = wfs_sources(args.wfs_source)
    elif not archive_map or args.wfs_source is not None or not re.fullmatch(r'[0-9]{4}-(0[1-9]|1[0-2])', args.vintage or ''):
        parser.error('Expected official archives and their official YYYY-MM vintage')
    if args.output.exists():
        parser.error('Output must be a new directory')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=args.output.parent, prefix='postal-conversion-') as temp:
        prepared = Path(temp) / 'boundaries'
        prepared.mkdir()
        all_codes = set()
        regions = []
        for code, path in sorted(archive_map.items()):
            regional_attributes = None if attributes is None else {key: value for key, value in attributes.items() if value['SIG_CD'].startswith(code)}
            region = write_region(prepared, code, Path(path), all_codes, regional_attributes)
            if regional_attributes is not None and region['count'] != len(regional_attributes):
                raise ValueError('Official Seoul WFS zone IDs are incomplete')
            regions.append(region)
            print(f"Prepared {code}: {region['count']} zones, {region['repaired']} repaired geometries", flush=True)
        manifest = {
            'schema': 'opsmap-postal-boundaries-v1',
            'origin': args.origin,
            'vintage': args.vintage,
            'latestSourceChange': provenance.get('latestSourceChange'),
            'retrievedAt': provenance.get('retrievedAt'),
            'attributesSha256': provenance.get('attributesSha256'),
            'regions': regions,
        }
        (prepared / 'manifest.json').write_text(compact(manifest) + '\n', encoding='utf-8')
        prepared.rename(args.output)
    print(f'Prepared {len(all_codes)} five-digit boundaries across {len(regions)} regional archives')


if __name__ == '__main__':
    main()
