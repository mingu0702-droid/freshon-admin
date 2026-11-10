"""Build and query the offline postal/building coordinate catalog used by Opsmap."""
import argparse
from contextlib import ExitStack, closing
import csv
import hashlib
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import re
import sqlite3
from statistics import median
import sys
from uuid import uuid4
import zipfile

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("address_match", Path(__file__).with_name("match-official-addresses.py"))
address_match = importlib.util.module_from_spec(spec)
spec.loader.exec_module(address_match)

POSTAL = "https://www.epost.go.kr/search/zipcode/areacdAddressDown.jsp"
BUSINESS = "https://www.data.go.kr/data/15083033/fileData.do"
ELEVATOR = "https://www.data.go.kr/data/15156424/fileData.do"
SCHEMA = "opsmap-public-address-catalog-v1"
MAX_QUERIES = 15000
PROVINCES = {**address_match.PROVINCES, "인천시": "인천광역시", "부산시": "부산광역시",
             "대전시": "대전광역시", "대구시": "대구광역시",
             "울산시": "울산광역시", "세종시": "세종특별자치시"}
FULL_PROVINCES = set(PROVINCES.values()) | {"전남광주통합특별시"}
HWASEONG_DISTRICTS = ("만세구", "효행구", "병점구", "동탄구")
SCOPED_ALIASES = (
    (r"^(경기도 화성시) (?:만세구|효행구|병점구|동탄구) ", r"\1 "),
    (r"^인천광역시 (?:서해구|검단구) ", "인천광역시 서구 "),
    (r"^인천광역시 제물포구 ", "인천광역시 동구 "),
    (r"^인천광역시 제물포구 ", "인천광역시 중구 "),
    (r"^인천광역시 영종구 ", "인천광역시 중구 "),
    (r"^인천광역시 서구 ", "인천광역시 서해구 "),
    (r"^인천광역시 서구 ", "인천광역시 검단구 "),
    (r"^인천광역시 중구 ", "인천광역시 제물포구 "),
    (r"^인천광역시 중구 ", "인천광역시 영종구 "),
    (r"^인천광역시 동구 ", "인천광역시 제물포구 "),
    (r"^전남광주통합특별시 (?=\S+(?:시|군) )", "전라남도 "),
    (r"^전남광주통합특별시 (?=[동서남북]구 |광산구 )", "광주광역시 "),
    (r"^전라남도 (?=\S+(?:시|군) )", "전남광주통합특별시 "),
    (r"^광주광역시 (?=[동서남북]구 |광산구 )", "전남광주통합특별시 "),
)


def compact(value):
    return "".join(value.split())


def clean_address(value):
    value = address_match.clean(value).translate(str.maketrans("‐‑–—−", "-----"))
    value = re.sub(r"(대로|로)\s+(\d+(?:번)?길)", r"\1\2", value)
    value = re.sub(r"(?<=\d)\s*-\s*(?=\d)", "-", value)
    value = re.sub(r"(?<=\d)\s*번지(?=$|[\s,(\[])", "", value)
    head, sep, rest = value.partition(" ")
    return PROVINCES.get(head, head) + sep + rest


def address_parts(value):
    matches = [match for pattern in (address_match.ROAD, address_match.LOT) if (match := pattern.search(value))]
    if not matches:
        return None
    match = min(matches, key=lambda item: item.start())
    return compact(match[0]), value[:match.start()].strip()


def query_parts(value):
    normalized = clean_address(value)
    parts = address_parts(normalized)
    if not parts:
        return None
    house, area = parts
    variants = {area}
    for pattern, replacement in SCOPED_ALIASES:
        corrected = re.sub(pattern, replacement, normalized)
        if corrected != normalized and (other := address_parts(corrected)):
            variants.add(other[1])
    city = "경기도 화성시"
    if (area == city or area.startswith(city + " ")) and not area.removeprefix(city).strip().startswith(HWASEONG_DISTRICTS):
        variants.update(city + " " + district + area.removeprefix(city) for district in HWASEONG_DISTRICTS)
    # Road addresses sometimes carry the legal-dong name before the street.
    if address_match.ROAD.search(normalized):
        variants.update(re.sub(r"\s+\S+(?:동\d+가|동|리)$", "", item) for item in list(variants))
    full_scope = area.split(" ", 1)[0] in FULL_PROVINCES
    return house, {compact(item) for item in variants}, full_scope


def zip_members(filename, suffix, encoding):
    with zipfile.ZipFile(filename) as archive:
        files = [entry for entry in archive.infolist() if entry.filename.lower().endswith(suffix) and entry.file_size]
        if not files or len(files) > 25 or sum(entry.file_size for entry in files) > 2_500_000_000:
            raise ValueError("PUBLIC_ADDRESS_ARCHIVE_SCOPE")
        for entry in files:
            with archive.open(entry) as raw:
                yield io.TextIOWrapper(raw, encoding=encoding, newline="")


def number(main, sub):
    return main + ("-" + sub if sub and sub != "0" else "")


def valid_id(value):
    return bool(address_match.BUILDING.fullmatch(value)) and int(value) != 0


def insert_batches(db, statement, rows, size=30000):
    batch = []
    for row in rows:
        batch.append(row)
        if len(batch) >= size:
            db.executemany(statement, batch)
            batch.clear()
    db.executemany(statement, batch)


def add_postal(db, path):
    names = []

    def rows():
        for stream in zip_members(path, ".txt", "utf-8-sig"):
            if "건물관리번호" not in next(stream, ""):
                raise ValueError("PUBLIC_ADDRESS_POSTAL_HEADERS")
            for line in stream:
                col = line.rstrip("\r\n").split("|")
                if len(col) < 24 or not valid_id(col[13]):
                    continue
                province, city, town, road, below, main, sub, bid, dong, ri, mountain, lotmain, lotsub = (
                    col[i] for i in (1, 3, 5, 8, 10, 11, 12, 13, 17, 18, 20, 21, 23)
                )
                area = compact(PROVINCES.get(province, province) + city + town)
                yield (compact(road) + ("지하" if below == "1" else "") + number(main, sub), area, 0, bid)
                if lotmain not in ("", "0"):
                    locality = ri or dong or town
                    lot_area = compact(PROVINCES.get(province, province) + city)
                    if ri:
                        lot_area += compact(town)
                        if dong and dong != town:
                            lot_area += compact(dong)
                    elif town != locality:
                        lot_area += compact(town)
                    yield (compact(locality) + ("산" if mountain == "1" else "") + number(lotmain, lotsub), lot_area, 0, bid)
                for name in set(col[14:16]) - {""}:
                    names.append((bid, address_match.site_name(name)))
                if len(names) >= 30000:
                    db.executemany("INSERT OR IGNORE INTO name VALUES (?, ?)", names)
                    names.clear()

    insert_batches(db, "INSERT OR IGNORE INTO address VALUES (?, ?, ?, ?)", rows())
    db.executemany("INSERT OR IGNORE INTO name VALUES (?, ?)", names)


def add_business(db, path):
    coordinates, names = [], []

    def rows():
        for stream in zip_members(path, ".csv", "utf-8-sig"):
            reader = csv.reader(stream)
            header = next(reader, [])
            if not header:
                continue
            indices = [header.index(field) for field in ("건물관리번호", "도로명주소", "지번주소", "위도", "경도", "건물명")]
            for row in reader:
                bid, road, lot, lat, lng, name = (row[i] for i in indices)
                if not valid_id(bid):
                    continue
                if (point := address_match.point(lat, lng)):
                    coordinates.append((bid, 1, *point))
                if name:
                    names.append((bid, address_match.site_name(name)))
                for raw in (road, lot):
                    if (parts := address_parts(clean_address(raw))):
                        yield (parts[0], compact(parts[1]), 1, bid)
                if len(coordinates) >= 30000:
                    db.executemany("INSERT OR IGNORE INTO point VALUES (?, ?, ?, ?)", coordinates)
                    coordinates.clear()
                if len(names) >= 30000:
                    db.executemany("INSERT OR IGNORE INTO name VALUES (?, ?)", names)
                    names.clear()

    insert_batches(db, "INSERT OR IGNORE INTO address VALUES (?, ?, ?, ?)", rows())
    db.executemany("INSERT OR IGNORE INTO point VALUES (?, ?, ?, ?)", coordinates)
    db.executemany("INSERT OR IGNORE INTO name VALUES (?, ?)", names)


def address_buildings(db, parts):
    house, areas, full_scope = parts
    found = [set(), set()]
    for area, source, bid in db.execute("SELECT area, source, building FROM address WHERE house = ?", (house,)):
        if area in areas or not full_scope and any(area.endswith(variant) for variant in areas):
            found[source].add(bid)
    return found


def add_elevators(db, path):
    def rows():
        with path.open(encoding="utf-8-sig", newline="") as stream:
            for row in csv.DictReader(stream):
                point = address_match.point(row["위도"], row["경도"])
                parts = query_parts(row["건물주소"])
                if point and parts and parts[2]:
                    postal, business = address_buildings(db, parts)
                    ids = postal or business
                    if len(ids) == 1:
                        yield (next(iter(ids)), 0, *point)

    insert_batches(db, "INSERT OR IGNORE INTO point VALUES (?, ?, ?, ?)", rows())


def source_record(path, url, date=None):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"url": url, "sha256": digest.hexdigest(), **({"date": date} if date else {})}


def build(args):
    if args.database.exists():
        raise ValueError("PUBLIC_ADDRESS_CATALOG_EXISTS")
    tmp = args.database.with_name("." + args.database.name + "-" + uuid4().hex)
    try:
        with closing(sqlite3.connect(tmp)) as db:
            db.executescript("""
                PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-65536;
                CREATE TABLE address (house TEXT, area TEXT, source INTEGER, building TEXT,
                  PRIMARY KEY (house, area, source, building)) WITHOUT ROWID;
                CREATE TABLE name (building TEXT, value TEXT, PRIMARY KEY (building, value)) WITHOUT ROWID;
                CREATE TABLE point (building TEXT, source INTEGER, lat REAL, lng REAL,
                  PRIMARY KEY (building, source, lat, lng)) WITHOUT ROWID;
                CREATE TABLE metadata (value TEXT);
            """)
            add_postal(db, args.postal)
            add_business(db, args.business)
            add_elevators(db, args.elevator)
            metadata = {"schema": SCHEMA, "postal": source_record(args.postal, POSTAL),
                        "sources": [source_record(args.elevator, ELEVATOR, args.elevator_date),
                                    source_record(args.business, BUSINESS, args.business_date)]}
            db.execute("INSERT INTO metadata VALUES (?)", (json.dumps(metadata),))
            db.commit()
        os.link(tmp, args.database)
    finally:
        tmp.unlink(missing_ok=True)


def representative(points):
    if len(points) == 1:
        return points[0]
    lat = median(point[0] for point in points)
    lng = median(point[1] for point in points)
    scale = math.cos(math.radians(lat))
    return min(points, key=lambda point: ((point[0] - lat)**2 + ((point[1] - lng) * scale)**2, point))


def known_points(db, ids):
    points = [[], []]
    for bid in ids:
        for source, lat, lng in db.execute("SELECT source, lat, lng FROM point WHERE building = ?", (bid,)):
            points[source].append((lat, lng))
    return points


def locate(db, value):
    parts = query_parts(value)
    if not parts:
        return {"status": "ADDRESS_NOT_IDENTIFIED"}
    postal, business = address_buildings(db, parts)
    ids = postal or business
    if len(ids) > 1:
        hints = {address_match.site_name(hint) for group in re.findall(r"\(([^()]*)\)", value)
                 for hint in group.split(",") if hint.strip()}
        named = {bid for bid in ids if any(name in hints for (name,) in
                 db.execute("SELECT value FROM name WHERE building = ?", (bid,)))}
        if len(named) != 1:
            return {"status": "AMBIGUOUS_BUILDING"}
        ids = named
    if not ids:
        return {"status": "ADDRESS_NOT_IDENTIFIED"}
    bid = next(iter(ids))
    points = known_points(db, [bid])
    if not any(points) and len(postal) == len(business) == 1 and bid not in business and parts[2]:
        # The same exact address can use a newer building ID in the postal edition.
        points[1] = db.execute("SELECT lat, lng FROM point WHERE building = ? AND source = 1",
                               (next(iter(business)),)).fetchall()
    if not any(points):
        return {"status": "NO_LICENSED_POINT"}
    source = 0 if points[0] else 1
    lat, lng = representative(points[source])
    return {"status": "MATCHED", "source": source, "lat": lat, "lng": lng,
            "buildingId": bid, "buildingSha256": hashlib.sha256(bid.encode("ascii")).hexdigest()}


def lookup_parcel(base, index, metadata, value):
    from opsmap_parcel_index import binding_for, direct_lot, parcel_point
    normalized = clean_address(value)
    road = address_match.ROAD.search(normalized)
    lot = address_match.LOT.search(normalized)
    is_lot = lot is not None and (road is None or lot.start() < road.start())
    part = lot if is_lot else road
    if not part:
        return {"status": "ADDRESS_NOT_IDENTIFIED"}
    query = normalized[:part.end()]
    postal, _ = address_buildings(base, query_parts(value))
    bound = binding_for(index, postal)
    bindings = sorted({row for rows in bound.values() for row in rows})
    pnus = {row[0] for row in bindings}
    direct = direct_lot(index, query, metadata["postalObservedOn"]) if is_lot else None
    if direct:
        if pnus and pnus != {direct[0]}:
            return {"status": "PARCEL_IDENTITY_CONFLICT"}
        pnus.add(direct[0])
    road_names = sorted({row[1] for row in bindings})
    canonical_names = {row[2 if is_lot else 1] for row in bindings}
    canonical = direct[1] if direct else next(iter(canonical_names)) if len(canonical_names) == 1 else query
    if not is_lot and bound and len(bound) == len(postal) and len(road_names) == 1:
        site = index.execute("SELECT pnus,address,id,source,lat,lng,reference FROM site WHERE key=?",
                             (clean_address(road_names[0]),)).fetchone()
        if site and set(site[0].split(",")) == pnus:
            _, address, identifier, source, lat, lng, reference = site
            return {"status": "MATCHED_REPRESENTATIVE", "kind": "CAMPUS", "identifier": identifier,
                    "address": address, "parcelSource": source, "lat": lat, "lng": lng,
                    "parcelIds": sorted(pnus), "officialReference": reference}
    if len(pnus) > 1:
        return {"status": "MULTIPLE_PARCELS"}
    if len(postal) > 1 and len(bound) != len(postal):
        return {"status": "PARCEL_BINDING_UNAVAILABLE"}
    ordinary = None
    if len(postal) <= 1:
        ordinary = locate(base, value)
        if ordinary["status"] == "MATCHED":
            identifier = "PNU:" + next(iter(pnus)) if pnus else "BUILDING:" + ordinary["buildingId"]
            return {**ordinary, "kind": "BUILDING" if ordinary["source"] == 0 else "ADDRESS",
                    "identifier": identifier, "address": canonical}
    if not pnus:
        return ordinary or {"status": "PARCEL_BINDING_UNAVAILABLE"}
    pnu = next(iter(pnus))
    identifier = "PNU:" + pnu
    # With an exact road address and a shared parcel, licensed points may
    # represent that address without choosing a specific building.
    if not is_lot and len(postal) > 1 and len(road_names) == 1:
        points = known_points(base, postal)
        if any(points):
            source = 0 if points[0] else 1
            lat, lng = representative(points[source])
            return {"status": "MATCHED", "kind": "ADDRESS", "identifier": identifier, "address": canonical,
                    "source": source, "lat": lat, "lng": lng}
    point = parcel_point(index, pnu, metadata["sources"])
    if point:
        source, lat, lng, original_pnu = point
        return {"status": "MATCHED_REPRESENTATIVE", "kind": "PARCEL", "identifier": identifier,
                "address": canonical, "parcelSource": source, "lat": lat, "lng": lng, "sourcePnu": original_pnu}
    return {"status": "PARCEL_GEOMETRY_UNAVAILABLE", "identifier": identifier, "address": canonical,
            "identitySource": "POSTAL_PARCEL_BINDING" if bindings else "LEGAL_CODE_LOOKUP"}


def lookup(args):
    queries = json.load(sys.stdin)
    if not isinstance(queries, list) or len(queries) > MAX_QUERIES or any(
            not isinstance(value, str) or not 0 < len(value) <= 500 for value in queries):
        raise ValueError("PUBLIC_ADDRESS_QUERY_SCOPE")
    with ExitStack() as stack:
        db = stack.enter_context(closing(sqlite3.connect(args.database.resolve().as_uri() + "?mode=ro&immutable=1", uri=True)))
        metadata = json.loads(db.execute("SELECT value FROM metadata").fetchone()[0])
        if args.parcel_index:
            from opsmap_parcel_index import SCHEMA as PARCEL_SCHEMA
            parcel = stack.enter_context(closing(sqlite3.connect(
                args.parcel_index.resolve().as_uri() + "?mode=ro&immutable=1", uri=True)))
            parcel_meta = json.loads(parcel.execute("SELECT value FROM metadata").fetchone()[0])
            if parcel_meta["schema"] != PARCEL_SCHEMA or parcel_meta["postalSha256"] != metadata["postal"]["sha256"]:
                raise ValueError("PARCEL_POSTAL_VERSION")
            result = {"metadata": metadata, "parcelMetadata": parcel_meta,
                      "rows": [lookup_parcel(db, parcel, parcel_meta, value) for value in queries]}
        else:
            result = {"metadata": metadata, "rows": [locate(db, value) for value in queries]}
    json.dump(result, sys.stdout, ensure_ascii=True, separators=(",", ":"))


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    build_parser = commands.add_parser("build")
    read_parser = commands.add_parser("lookup")
    parcel_parser = commands.add_parser("build-parcel")
    extend_parser = commands.add_parser("extend-parcel")
    for command in (build_parser, read_parser, parcel_parser, extend_parser):
        command.add_argument("database", type=Path)
    for name in ("postal", "business", "elevator"):
        build_parser.add_argument("--" + name, type=Path, required=True)
    for name in ("business-date", "elevator-date"):
        build_parser.add_argument("--" + name, required=True)
    read_parser.add_argument("--parcel-index", type=Path)
    parcel_parser.add_argument("--postal", type=Path, required=True)
    parcel_parser.add_argument("--postal-observed-on", required=True)
    parcel_parser.add_argument("--legal-dongs", type=Path)
    parcel_parser.add_argument("--code-changes", type=Path)
    parcel_parser.add_argument("--parcel-shape", action="append", default=[])
    parcel_parser.add_argument("--site-index", type=Path, action="append", default=[])
    extend_parser.add_argument("--base-index", type=Path, required=True)
    extend_parser.add_argument("--base-sha256", required=True)
    extend_parser.add_argument("--target-pnus", type=Path, required=True)
    extend_parser.add_argument("--parcel-shape", action="append", required=True)
    args = parser.parse_args()
    if args.command == "build-parcel":
        from opsmap_parcel_index import build as build_parcel
        build_parcel(args, lambda file: zip_members(file, ".txt", "utf-8-sig"), clean_address)
    elif args.command == "extend-parcel":
        from opsmap_parcel_index import extend as extend_parcel
        json.dump(extend_parcel(args), sys.stdout)
    else:
        (build if args.command == "build" else lookup)(args)


if __name__ == "__main__":
    main()
