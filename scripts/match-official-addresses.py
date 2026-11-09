"""Match the supplied two-column TSV to the official commercial address archive offline."""
import argparse
import csv
import hashlib
import io
import json
import math
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path
import re
import unicodedata
import zipfile

SOURCE = "https://www.data.go.kr/data/15083033/fileData.do"
PROVINCES = {
    "서울": "서울특별시", "서울시": "서울특별시", "경기": "경기도", "인천": "인천광역시",
    "부산": "부산광역시", "대구": "대구광역시", "대전": "대전광역시", "울산": "울산광역시",
    "광주": "광주광역시", "세종": "세종특별자치시", "강원": "강원특별자치도",
    "강원도": "강원특별자치도", "충남": "충청남도", "충북": "충청북도", "전북": "전북특별자치도",
    "전라북도": "전북특별자치도", "전남": "전라남도", "경북": "경상북도", "경남": "경상남도",
    "제주": "제주특별자치도", "제주도": "제주특별자치도",
}
BUILDING = re.compile(r"^\d{25}$")
NUMBER = r"\d+(?:-\d+)?(?=$|[\s,(\[])"
ROAD = re.compile(r"(?<![가-힣0-9·.])[가-힣0-9·.]+(?:대로|로|길)\s*(?:지하\s*)?" + NUMBER)
LOT = re.compile(r"(?<![가-힣0-9·.])[가-힣0-9·.]+(?:동\d+가|동|리|읍|면|가)\s*(?:산\s*)?" + NUMBER)


def clean(value):
    return " ".join(unicodedata.normalize("NFKC", value or "").lower().split())


def address_key(value):
    normalized = clean(value)
    normalized = re.sub(r"(대로|로)\s+(\d+(?:번)?길)", r"\1\2", normalized)
    match = ROAD.search(normalized) or LOT.search(normalized)
    if not match:
        return ""
    head, _, rest = normalized[:match.end()].partition(" ")
    return (PROVINCES.get(head, head) + rest).replace(" ", "")


def address_keys(value):
    primary = address_key(value)
    if not primary:
        return []
    normalized = clean(value)
    aliases = [re.sub(r"^((?:경기|경기도)\s+화성시)\s+(?:만세구|효행구|병점구|동탄구)\s+", r"\1 ", normalized)]
    districts = (("제물포구", "송림동", "동구"), ("영종구", "운남동", "중구"), ("검단구", "당하동", "서구"))
    for current, locality, previous in districts:
        if re.search(r"(?:^|[\s(,])" + locality + r"(?=[\s),]|$)", normalized):
            aliases.append(re.sub(r"^인천(?:광역시|시)?\s+" + current + r"(?=\s)", "인천광역시 " + previous, normalized))
    # Keep both plausible published forms for the affected area and accept only agreement.
    if re.match(r"^전남광주통합특별시\s+(?:순천시|광양시|강진군)\s", normalized):
        aliases.append(normalized.replace("전남광주통합특별시 ", "전라남도 ", 1))
    if re.search(r"(?:^|[\s(,])용봉동(?=[\s),]|$)", normalized):
        aliases.append(re.sub(r"^전남광주통합특별시\s+북구(?=\s)", "광주광역시 북구", normalized))
    return sorted({primary, *(key for address in aliases if (key := address_key(address)))})


def point(lat, lng):
    try:
        lat, lng = float(lat), float(lng)
        if 33 <= lat <= 39.5 and 124 <= lng <= 132:
            return round(lat, 6), round(lng, 6)
    except (ValueError, TypeError):
        pass
    return None


def site_name(value):
    value = re.sub(r"(?:주식회사|\(주\))", "", clean(value))
    return re.sub(r"[\s·.,\-_]+", "", value)


def official_rows(archive, wanted):
    found = defaultdict(set)
    numbers = {re.search(r"\d+(?:-\d+)?$", key)[0] for key in wanted}
    candidates = re.compile(r"(?<![\d-])\d+(?:-\d+)?(?![\d-])")
    total = 0
    with zipfile.ZipFile(archive, metadata_encoding="cp949") as source:
        names = [name for name in source.namelist() if name.lower().endswith(".csv")]
        if len(names) != 16 or sum(source.getinfo(name).file_size for name in names) > 2_500_000_000:
            raise ValueError("OFFICIAL_FILE_SCOPE")
        for name in names:
            with source.open(name) as stream:
                reader = csv.DictReader(io.TextIOWrapper(stream, encoding="utf-8-sig", newline=""))
                if not {"상호명", "지점명", "도로명주소", "지번주소", "건물관리번호", "위도", "경도"}.issubset(reader.fieldnames or []):
                    raise ValueError("OFFICIAL_FILE_HEADERS")
                for item in reader:
                    total += 1
                    road, lot = item["도로명주소"], item["지번주소"]
                    matches = {address_key(address) for address in (road, lot)
                               if any(candidate in numbers for candidate in candidates.findall(unicodedata.normalize("NFKC", address)))} & wanted
                    if not matches:
                        continue
                    record = (item["건물관리번호"], point(item["위도"], item["경도"]), road, lot, item["상호명"], item["지점명"])
                    for key in matches:
                        found[key].add(record)
    return found, total


def choose_public(records, name):
    if not records:
        return None, "공식 주소 일치 자료 없음"
    name_key = site_name(name)
    named = [row for row in records if name_key and name_key in {site_name(row[4]), site_name(row[4] + " " + row[5])}]
    for candidates, label in [(records, "OFFICIAL_BUILDING"), (named, "OFFICIAL_NAME_AND_ADDRESS")]:
        buildings = {row[0] for row in candidates}
        positions = {row[1] for row in candidates}
        if len(buildings) == len(positions) == 1 and all(BUILDING.fullmatch(value) and int(value) for value in buildings) and None not in positions:
            row = min(candidates)
            return row, "OFFICIAL_NAME_AND_ADDRESS" if named else label
    return None, "공식 자료 건물 또는 좌표 복수"


def distances(origin, destination):
    a, b = map(math.radians, origin)
    c, d = map(math.radians, destination)
    chord = math.sin((c-a)/2)**2 + math.cos(a)*math.cos(c)*math.sin((d-b)/2)**2
    return 12742 * math.asin(math.sqrt(min(1, chord)))


def load_coverage(directory):
    catalog = json.loads((directory / "stores.private.json").read_text(encoding="utf-8-sig"))
    stores = catalog["stores"]
    if not stores or len({row["code"] for row in stores}) != len(stores):
        raise ValueError("COVERAGE_REGISTRY_ROWS")
    observed, days, identities = defaultdict(set), set(), set()
    catalog_by_code = {row["code"]: row for row in stores}
    for path in sorted((directory / "observed-days").glob("*.json")):
        day = json.loads(path.read_text(encoding="utf-8-sig"))
        if day["proof"] != "OBSERVED_ARCHIVE_CURRENT" or day["date"] != path.stem:
            raise ValueError("COVERAGE_DAY_PROOF")
        days.add(day["date"])
        for identity, code, vehicle, _center, address_hash in day["visits"]:
            row = catalog_by_code.get(code)
            if identity in identities or not row or row.get("matchHash") != address_hash:
                continue
            identities.add(identity)
            observed[code].add((day["date"], vehicle))
    observed_days = sorted(days)
    proof = json.loads((directory / "source-import.safe.json").read_text(encoding="utf-8-sig"))
    first, last = map(date.fromisoformat, (proof["start"], proof["end"]))
    if proof["days"] != len(days) or any(day < first.isoformat() or day > last.isoformat() for day in days):
        raise ValueError("COVERAGE_WINDOW_PROOF")
    days_missing = [(first + timedelta(days=offset)).isoformat() for offset in range((last-first).days+1)
                    if (first + timedelta(days=offset)).isoformat() not in days]
    return stores, observed, observed_days, days_missing, catalog["registryComplete"]


def nearby(origin, positioned, observed):
    hits = sorted((distances(origin, position), code) for position, code in positioned)
    inside = [code for distance, code in hits if distance <= 0.5 and code in observed]
    vehicles = {}
    for distance, code in hits:
        if distance > 30:
            break
        for _, vehicle in observed.get(code, ()):
            if vehicle and (vehicle not in vehicles or distance < vehicles[vehicle]):
                vehicles[vehicle] = distance
    vehicle_distances = sorted(vehicles.items(), key=lambda item: (item[1], item[0]))
    weekday_counts = Counter(date.fromisoformat(day).weekday() for code in inside for day, _ in observed[code])
    return inside, vehicle_distances, weekday_counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-tsv", type=Path, required=True)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--dataset-date", required=True)
    parser.add_argument("--coverage-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    options = parser.parse_args()
    dataset_date = date.fromisoformat(options.dataset_date).isoformat()
    output = options.output_dir.resolve()
    if output.is_relative_to(Path(__file__).resolve().parents[1]):
        raise ValueError("PRIVATE_OUTPUT_REQUIRES_EXTERNAL_DIRECTORY")
    output.mkdir(parents=True, exist_ok=True)
    with options.input_tsv.open(encoding="utf-8-sig", newline="") as stream:
        inputs = list(csv.reader(stream, delimiter="\t"))
    if not inputs or any(len(row) != 2 or not row[0].strip() for row in inputs):
        raise ValueError("ADDRESS_INPUT_CONTRACT")
    with options.archive.open("rb") as stream:
        sha = hashlib.file_digest(stream, "sha256").hexdigest()
    keys = [address_keys(row[0]) for row in inputs]
    stores, observed, days, missing, registry_complete = load_coverage(options.coverage_dir)
    found, scanned = official_rows(options.archive, {key for group in keys for key in group})
    positioned, registry = [], defaultdict(set)
    for row in stores:
        position = point(row["lat"], row["lng"])
        if position:
            positioned.append((position, row["code"]))
            for key in address_keys(row["address"]):
                registry[key].add(position)
    result, index, counts = [], defaultdict(set), Counter()
    for number, (raw, group) in enumerate(zip(inputs, keys), start=1):
        address, name = raw
        existing = set().union(*(registry[key] for key in group))
        records = set().union(*(found[key] for key in group))
        public, reason = choose_public(records, name)
        if len(existing) == 1:
            location, accuracy, state = next(iter(existing)), "REGISTERED_PROJECTION", "EXISTING_REGISTRY"
        elif len(existing) > 1:
            location, accuracy, state = None, "", "REGISTRY_MULTIPLE"
        elif public:
            location, accuracy, state = public[1], "BUILDING", reason
            # Index only address keys considered against the complete corpus. A name-only match never authorizes an address-only lookup.
            building_only, _ = choose_public(records, "")
            if building_only:
                building_hash = hashlib.sha256(building_only[0].encode()).hexdigest()
                for key in group:
                    index[hashlib.sha256(key.encode()).hexdigest()].add((building_hash, *location))
        else:
            location, accuracy, state = None, "", "OFFICIAL_UNMATCHED" if not records else "OFFICIAL_AMBIGUOUS"
        counts[state] += 1
        if location:
            inside, vehicles, weekdays = nearby(location, positioned, observed)
            counts["located"] += 1
            counts["withRecorded500m"] += bool(inside)
            counts["withRecordedVehicles30km"] += bool(vehicles)
            counts["withRecordedWeekdays500m"] += bool(weekdays)
        else:
            inside, vehicles, weekdays = [], [], {}
            counts["unresolved"] += 1
        result.append({"row": number, "address": address, "customer": name, "state": state, "accuracy": accuracy,
                       "lat": location[0] if location else None, "lng": location[1] if location else None,
                       "road": public[2] if public and state.startswith("OFFICIAL_") else "",
                       "lot": public[3] if public and state.startswith("OFFICIAL_") else "",
                       "reviewReason": reason if not location else "",
                       "recordedDeliveryStores500m": len(inside), "recordedVehicleReferences30km": vehicles,
                       "observedWeekdays500m": weekdays})
    summary = {"scope": "OFFLINE_OFFICIAL_ADDRESS_AND_RECORDED_DELIVERY_EVIDENCE", "source": SOURCE,
               "datasetDate": dataset_date, "datasetSha256": sha, "datasetRows": scanned,
               "inputRows": len(inputs), "registryRows": len(stores), "registryLocated": len(positioned), "coverageRegistryComplete": registry_complete,
               "firstDay": days[0], "lastDay": days[-1], "recordedDays": len(days), "missingDays": missing,
               "recorded500mStoresWithCoordinates": sum(code in observed for _, code in positioned),
               "referenceDistance": "STRAIGHT_LINE", "vehicleReferences": "OBSERVED_ADDRESS_BOUND_COMPLETION",
               "counts": dict(counts), "providerCalls": 0}
    with (output / "A_ADDRESS_MATCH.private.csv").open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(result[0]))
        writer.writeheader()
        writer.writerows(result)
    index_rows = [{"addressSha256": key, "buildingSha256": building, "lat": lat, "lng": lng}
                  for key, candidates in sorted(index.items()) if len(candidates) == 1
                  for building, lat, lng in candidates]
    artifact = {"schema": "opsmap-official-address-index-v1", "source": SOURCE, "date": dataset_date,
                "datasetSha256": sha, "rows": index_rows}
    public_path = output / "A_OFFICIAL_ADDRESS_INDEX.public.json"
    public_path.write_text(json.dumps(artifact, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    summary["publicIndexRows"] = len(index_rows)
    summary["publicIndexSha256"] = hashlib.sha256(public_path.read_bytes()).hexdigest()
    (output / "A_ADDRESS_MATCH.safe.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
