"""Build an offline index from postal parcel bindings and licensed geometries."""
from contextlib import ExitStack, closing
from datetime import date
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
from uuid import uuid4
import zipfile

SCHEMA = "opsmap-parcel-index-v1"
PARCEL_SOURCE = "https://www.data.go.kr/data/15045882/fileData.do"
OSM_SOURCE = "https://download.geofabrik.de/asia/south-korea.html"
PNU = re.compile(r"[0-9]{10}[12][0-9]{8}")
CODE = re.compile(r"[0-9]{10}")
BUILDING = re.compile(r"[0-9]{25}")
HASH = re.compile(r"[0-9a-f]{64}")
LOT = re.compile(r"(?P<name>.+?)\s*(?P<mountain>산\s*)?(?P<main>[0-9]{1,4})(?:-(?P<sub>[0-9]{1,4}))?$")


def iso_day(value):
    if date.fromisoformat(value).isoformat() != value:
        raise ValueError("PARCEL_SOURCE_DATE")
    return value


def parcel_id(code, mountain, main, sub):
    if not CODE.fullmatch(code) or mountain not in ("0", "1") or not (
        main.isascii() and main.isdecimal() and sub.isascii() and sub.isdecimal()
    ) or not 0 < int(main) <= 9999 or not 0 <= int(sub) <= 9999:
        return None
    return code + ("2" if mountain == "1" else "1") + f"{int(main):04}{int(sub):04}"


def valid_pnu(value):
    return bool(PNU.fullmatch(value)) and int(value[11:15]) > 0


def file_sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def postal_rows(streams):
    for stream in streams:
        fields = next(stream, "").rstrip("\r\n").split("|")
        expected = {1: "시도", 3: "시군구", 5: "읍면", 8: "도로명", 13: "건물관리번호", 16: "법정동코드",
                    20: "산여부", 21: "지번본번", 23: "지번부번"}
        if len(fields) <= max(expected) or any(fields[i] != field for i, field in expected.items()):
            raise ValueError("PARCEL_POSTAL_HEADERS")
        for line in stream:
            col = line.rstrip("\r\n").split("|")
            if len(col) < 24 or not BUILDING.fullmatch(col[13]) or not int(col[13]):
                continue
            pnu = parcel_id(col[16], col[20] or "0", col[21], col[23] or "0")
            if not pnu or col[10] not in ("0", "1"):
                continue
            admin = [x for x in (col[1], col[3], col[5]) if x]
            locality = [x for x in (col[17], col[18]) if x and x != col[5]]
            lot_number = col[21] + ("-" + col[23] if col[23] not in ("", "0") else "")
            road_number = col[11] + ("-" + col[12] if col[12] not in ("", "0") else "")
            road = " ".join([*admin, col[8], *(["지하"] if col[10] == "1" else []), road_number])
            lot = " ".join([*admin, *locality, ("산 " if col[20] == "1" else "") + lot_number])
            yield col[13], pnu, road, lot


def legal_rows(path, clean):
    with zipfile.ZipFile(path) as archive:
        entries = [e for e in archive.infolist() if e.filename.lower().endswith(".txt")]
        if len(entries) != 1 or entries[0].file_size > 10_000_000:
            raise ValueError("PARCEL_LEGAL_CODES_ARCHIVE")
        data = archive.read(entries[0])
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = data.decode("cp949")
    header, *lines = text.splitlines()
    if header.split() != ["법정동코드", "법정동명", "폐지여부"]:
        raise ValueError("PARCEL_LEGAL_CODES_HEADER")
    for line in lines:
        code, name, status = (v.strip() for v in line.split("\t"))
        if not CODE.fullmatch(code) or status not in ("존재", "폐지"):
            raise ValueError("PARCEL_LEGAL_CODE_ROW")
        yield code, clean(name), name, status == "존재"


def read_changes(path, db):
    if path is None:
        return {}
    value = json.loads(path.read_text(encoding="utf-8"))
    if value.get("schema") != "opsmap-official-legal-code-changes-v1" or not HASH.fullmatch(value["noticeSha256"]):
        raise ValueError("PARCEL_LEGAL_CODE_CHANGES")
    changes = {}
    for entry in value["changes"]:
        old, new = entry["oldCode"], entry["newCode"]
        effective = iso_day(entry["effectiveDate"])
        names = db.execute("SELECT code, name, active FROM legal WHERE code IN (?, ?)", (old, new)).fetchall()
        by_code = {code: (name, active) for code, name, active in names}
        if old in changes or old == new or set(by_code) != {old, new} or by_code[old][1] or not by_code[new][1] or (
            by_code[old][0].split()[-1] != by_code[new][0].split()[-1]
        ):
            raise ValueError("PARCEL_LEGAL_CODE_CHANGE_ROW")
        changes[old] = new, effective
    return changes


def checked_point(geometry, transformer=None):
    from shapely.geometry import shape
    if not hasattr(geometry, "representative_point"):
        geometry = shape(geometry)
    if geometry.geom_type not in ("Polygon", "MultiPolygon") or not geometry.is_valid or geometry.is_empty:
        return None
    point = geometry.representative_point()
    if not geometry.contains(point):
        return None
    lng, lat = transformer.transform(point.x, point.y) if transformer else (point.x, point.y)
    return (lat, lng) if 33 <= lat <= 39.5 and 124 <= lng <= 132 else None


def geometry_layers(file):
    required = (".shp", ".shx", ".dbf", ".prj")
    if file.suffix.lower() == ".zip":
        digest = file_sha(file)
        with zipfile.ZipFile(file) as archive:
            groups = {}
            for entry in archive.infolist():
                name = Path(entry.filename)
                suffix = name.suffix.lower()
                if entry.is_dir() or suffix not in (*required, ".cpg"):
                    continue
                if name.is_absolute() or name.drive or ".." in name.parts:
                    raise ValueError("PARCEL_SHAPEFILE_ARCHIVE_PATH")
                group = groups.setdefault(str(name.with_suffix("")).casefold(), {})
                if suffix in group:
                    raise ValueError("PARCEL_SHAPEFILE_ARCHIVE_DUPLICATE")
                group[suffix] = entry
            if not groups or any(not set(required).issubset(group) for group in groups.values()):
                raise ValueError("PARCEL_SHAPEFILE_ARCHIVE_COMPONENTS")
            for group in groups.values():
                yield group.keys(), lambda suffix: archive.open(group[suffix]), digest
    elif file.suffix.lower() == ".shp":
        components = {suffix: file.with_suffix(suffix) for suffix in required}
        cpg = file.with_suffix(".cpg")
        if cpg.is_file():
            components[".cpg"] = cpg
        digest = hashlib.sha256("".join(file_sha(f) for f in components.values()).encode("ascii")).hexdigest()
        yield components.keys(), lambda suffix: components[suffix].open("rb"), digest
    else:
        raise ValueError("PARCEL_SHAPEFILE_REQUIRED")


def add_geometry(db, file, as_of, sources, changes, postal_observed_on, targets=None):
    valid_count = 0
    with closing(geometry_layers(file)) as layers:
        for components, open_component, digest in layers:
            valid_count += add_geometry_layer(db, components, open_component, digest, as_of, sources, changes,
                                              postal_observed_on, targets, file.suffix.lower() == ".zip")
    if targets is None and not valid_count:
        raise ValueError("PARCEL_SHAPEFILE_NO_VALID_PNU")


def add_geometry_layer(db, components, open_component, digest, as_of, sources, changes, postal_observed_on,
                       targets, require_official_identity):
    import shapefile
    from pyproj import CRS, Transformer

    def read_metadata(suffix):
        with open_component(suffix) as stream:
            data = stream.read(16_385)
        if len(data) > 16_384:
            raise ValueError("PARCEL_SHAPEFILE_METADATA_SIZE")
        return data.decode("utf-8-sig").strip()

    crs = CRS.from_wkt(read_metadata(".prj"))
    expected = CRS.from_epsg(5186)
    if not crs.equals(expected, ignore_axis_order=True) and not (
        crs.to_epsg(min_confidence=100) == 5186 and crs.to_wkt("WKT1_ESRI") == expected.to_wkt("WKT1_ESRI")
    ):
        raise ValueError("PARCEL_SHAPEFILE_CRS")
    transformer = Transformer.from_crs(expected, 4326, always_xy=True)
    encoding = "cp949"
    if ".cpg" in components:
        label = read_metadata(".cpg").lower()
        encoding = {"949": "cp949", "cp949": "cp949", "euc-kr": "cp949",
                    "65001": "utf-8", "utf-8": "utf-8", "utf8": "utf-8"}.get(label)
        if not encoding:
            raise ValueError("PARCEL_SHAPEFILE_ENCODING")
    provenance = {"url": PARCEL_SOURCE, "sha256": digest, "date": as_of,
                  "license": "CC-BY-2.0-KR", "crs": "EPSG:5186"}
    source = sources.index(provenance) if provenance in sources else len(sources)
    with ExitStack() as stack:
        streams = {suffix[1:]: stack.enter_context(open_component(suffix)) for suffix in (".shp", ".shx", ".dbf")}
        shp = stack.enter_context(shapefile.Reader(**streams, encoding=encoding))
        if shp.numRecords != len(shp):
            raise ValueError("PARCEL_SHAPEFILE_RECORD_COUNT")
        fields = {field[0].upper(): field[0] for field in shp.fields[1:]}
        pnu_field = fields.get("A1") or fields.get("PNU")
        if not pnu_field or (require_official_identity and "A1" not in fields):
            raise ValueError("PARCEL_SHAPEFILE_PNU_COLUMN")
        columns = [pnu_field]
        if "A1" in fields:
            if not {"A2", "A4", "A6"}.issubset(fields):
                raise ValueError("PARCEL_SHAPEFILE_IDENTITY_COLUMNS")
            columns.extend(fields[key] for key in ("A2", "A4", "A6"))
        valid_count = written = 0
        for record in shp.iterRecords(fields=columns if targets is None else [pnu_field]):
            original = str(record[pnu_field]).strip()
            if not valid_pnu(original):
                continue
            current = original
            if original[:10] in changes:
                new, effective = changes[original[:10]]
                if not as_of < effective <= postal_observed_on:
                    continue
                current = new + original[10:]
            if targets is not None and current not in targets:
                continue
            if "A1" in fields:
                if targets is not None:
                    record = shp.record(record.oid, fields=columns)
                legal = str(record[fields["A2"]]).strip()
                number = re.fullmatch(r"(산)?\s*([0-9]{1,4})(?:-([0-9]{1,4}))?",
                                      str(record[fields["A4"]]).strip())
                if not number or parcel_id(legal, "1" if number[1] else "0", number[2], number[3] or "0") != original:
                    continue
                try:
                    feature_date = iso_day(str(record[fields["A6"]]).strip())
                except ValueError:
                    continue
                if feature_date > as_of:
                    continue
            valid_count += 1
            geometry = shp.shape(record.oid)
            if geometry.shapeType not in (shapefile.POLYGON, shapefile.POLYGONM, shapefile.POLYGONZ):
                continue
            point = checked_point(geometry.__geo_interface__, transformer)
            if point is None:
                continue
            values = (*point, original)
            old = db.execute("SELECT lat, lng, source_pnu FROM point WHERE pnu=? AND source=?",
                             (current, source)).fetchone()
            if old and old != values:
                raise ValueError("PARCEL_DUPLICATE_GEOMETRY")
            if not old:
                db.execute("INSERT INTO point VALUES (?, ?, ?, ?, ?)", (current, source, *values))
                written += 1
    if written and source == len(sources):
        sources.append(provenance)
    return valid_count


def add_sites(db, file, sources, clean):
    value = json.loads(file.read_text(encoding="utf-8"))
    if value.get("schema") != "opsmap-reviewed-campus-geometry-v1" or not HASH.fullmatch(value["datasetSha256"]):
        raise ValueError("PARCEL_SITE_SCHEMA")
    source = len(sources)
    sources.append({"url": OSM_SOURCE, "sha256": value["datasetSha256"], "date": iso_day(value["date"]),
                    "license": "ODbL-1.0", "crs": "EPSG:4326"})
    for row in value["sites"]:
        ids = row["parcelIds"]
        if not ids or sorted(set(ids)) != ids or not all(valid_pnu(v) for v in ids) or not re.fullmatch(
            r"OSM:(?:way|relation):[1-9][0-9]{0,15}", row["identifier"]
        ) or not re.fullmatch(r"https://[^\s<>]+", row["officialReference"]):
            raise ValueError("PARCEL_SITE_IDENTITY")
        point = checked_point(row["geometry"])
        if point is None:
            raise ValueError("PARCEL_SITE_GEOMETRY")
        normalized = clean(row["address"])
        if not normalized or not all(db.execute(
            "SELECT 1 FROM binding WHERE pnu=? AND road=? LIMIT 1", (pnu, row["address"])
        ).fetchone() for pnu in ids):
            raise ValueError("PARCEL_SITE_POSTAL_BINDING")
        db.execute("INSERT INTO site VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                   (normalized, ",".join(ids), row["address"], row["identifier"], source, *point, row["officialReference"]))


def build(args, postal_streams, clean):
    if args.database.exists():
        raise ValueError("PARCEL_INDEX_EXISTS")
    observed = iso_day(args.postal_observed_on)
    tmp = args.database.with_name("." + args.database.name + "-" + uuid4().hex)
    sources = []
    try:
        with closing(sqlite3.connect(tmp)) as db:
            db.executescript("""
                PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-65536;
                CREATE TABLE binding (building TEXT, pnu TEXT, road TEXT, lot TEXT, PRIMARY KEY(building,pnu,road,lot)) WITHOUT ROWID;
                CREATE TABLE legal (code TEXT PRIMARY KEY, key TEXT, name TEXT, active INTEGER) WITHOUT ROWID;
                CREATE INDEX legal_name ON legal(key);
                CREATE TABLE transition (old TEXT PRIMARY KEY, new TEXT, effective TEXT) WITHOUT ROWID;
                CREATE TABLE point (pnu TEXT, source INTEGER, lat REAL, lng REAL, source_pnu TEXT, PRIMARY KEY(pnu,source)) WITHOUT ROWID;
                CREATE TABLE site (key TEXT PRIMARY KEY, pnus TEXT, address TEXT, id TEXT, source INTEGER, lat REAL, lng REAL, reference TEXT) WITHOUT ROWID;
                CREATE TABLE metadata (value TEXT);
            """)
            db.executemany("INSERT OR IGNORE INTO binding VALUES (?, ?, ?, ?)", postal_rows(postal_streams(args.postal)))
            if args.legal_dongs:
                db.executemany("INSERT INTO legal VALUES (?, ?, ?, ?)", legal_rows(args.legal_dongs, clean))
            changes = read_changes(args.code_changes, db)
            db.executemany("INSERT INTO transition VALUES (?, ?, ?)",
                           [(old, new, effective) for old, (new, effective) in changes.items()])
            for spec in args.parcel_shape:
                file, as_of = spec.rsplit("=", 1)
                add_geometry(db, Path(file), iso_day(as_of), sources, changes, observed)
            for path in args.site_index:
                add_sites(db, path, sources, clean)
            db.execute("INSERT INTO metadata VALUES (?)", (json.dumps({
                "schema": SCHEMA, "postalSha256": file_sha(args.postal), "postalObservedOn": observed,
                "legalCodesSha256": file_sha(args.legal_dongs) if args.legal_dongs else None,
                "codeChangesSha256": file_sha(args.code_changes) if args.code_changes else None,
                "sources": sources
            }),))
            db.commit()
        os.link(tmp, args.database)
    finally:
        tmp.unlink(missing_ok=True)


def extend(args):
    """Create a new sealed index containing only requested missing parcel points."""
    if args.database.exists():
        raise ValueError("PARCEL_INDEX_EXISTS")
    target_file = args.target_pnus
    if target_file.stat().st_size > 256_000:
        raise ValueError("PARCEL_TARGET_PNUS")
    requested = json.loads(target_file.read_text(encoding="utf-8-sig"))
    if not isinstance(requested, list) or not 0 < len(requested) <= 10_000 or any(
            not isinstance(pnu, str) or not valid_pnu(pnu) for pnu in requested
    ) or len(set(requested)) != len(requested):
        raise ValueError("PARCEL_TARGET_PNUS")
    base = args.base_index.resolve(strict=True)
    if not HASH.fullmatch(args.base_sha256) or any(
            base.with_name(base.name + suffix).exists() for suffix in ("-wal", "-shm", "-journal")
    ):
        raise ValueError("PARCEL_BASE_INDEX_NOT_SEALED")
    tmp = args.database.with_name("." + args.database.name + "-" + uuid4().hex)
    try:
        shutil.copyfile(base, tmp)
        if file_sha(tmp) != args.base_sha256:
            raise ValueError("PARCEL_BASE_INDEX_HASH")
        with closing(sqlite3.connect(tmp)) as db:
            (row,) = db.execute("SELECT value FROM metadata").fetchall()
            metadata = json.loads(row[0])
            if metadata["schema"] != SCHEMA:
                raise ValueError("PARCEL_BASE_INDEX_SCHEMA")
            observed = iso_day(metadata["postalObservedOn"])
            sources = metadata["sources"]
            changes = {old: (new, effective) for old, new, effective in db.execute(
                "SELECT old, new, effective FROM transition"
            )}
            targets = {pnu for pnu in requested if parcel_point(db, pnu, sources) is None}
            if not targets:
                raise ValueError("PARCEL_TARGETS_ALREADY_RESOLVED")
            for spec in args.parcel_shape:
                file, as_of = spec.rsplit("=", 1)
                add_geometry(db, Path(file), iso_day(as_of), sources, changes, observed, targets)
            resolved = sum(parcel_point(db, pnu, sources) is not None for pnu in targets)
            if not resolved:
                raise ValueError("PARCEL_TARGET_GEOMETRY_UNAVAILABLE")
            db.execute("UPDATE metadata SET value=?", (json.dumps(metadata),))
            db.commit()
        os.link(tmp, args.database)
        return {"requested": len(requested), "alreadyResolved": len(requested) - len(targets),
                "added": resolved, "unavailable": len(targets) - resolved}
    finally:
        tmp.unlink(missing_ok=True)


def binding_for(db, buildings):
    result = {}
    for building in buildings:
        rows = db.execute("SELECT pnu, road, lot FROM binding WHERE building=?", (building,)).fetchall()
        if rows:
            result[building] = rows
    return result


def direct_lot(db, query, observed):
    match = LOT.fullmatch(query.strip())
    if not match:
        return None
    name, mountain, main, sub = match.groups()
    legal = db.execute("""SELECT coalesce(t.new,l.code), coalesce(current.name,l.name)
        FROM legal l LEFT JOIN transition t ON t.old=l.code AND t.effective<=?
        LEFT JOIN legal current ON current.code=t.new WHERE l.key=? AND (l.active OR t.new IS NOT NULL)""",
        (observed, name.rstrip())).fetchall()
    if len(set(legal)) != 1:
        return None
    code, official = legal[0]
    pnu = parcel_id(code, "1" if mountain else "0", main, sub or "0")
    return (pnu, official + " " + ("산 " if mountain else "") + str(int(main)) +
            ("-" + str(int(sub)) if sub and int(sub) else "")) if pnu else None


def parcel_point(db, pnu, sources):
    rows = db.execute("SELECT source,lat,lng,source_pnu FROM point WHERE pnu=? ORDER BY source", (pnu,)).fetchall()
    if not rows:
        return None
    newest = max(sources[row[0]]["date"] for row in rows)
    chosen = {row[1:] for row in rows if sources[row[0]]["date"] == newest}
    if len(chosen) != 1:
        return None
    return next(row for row in rows if sources[row[0]]["date"] == newest)
