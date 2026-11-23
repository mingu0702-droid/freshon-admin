"""Audit approved Stage coordinate gaps against the pinned public address archive.

Takes a current, read-only staff-registration/snapshot merge and optional original
batch TSV. Writes review-only candidates without names or raw addresses. Never
contacts a provider, writes a registry, or treats a commercial-catalog miss as
evidence that a registered address does not exist.
"""
import argparse
import csv
import hashlib
import importlib.util
import json
from collections import Counter, defaultdict
from pathlib import Path
import re
import unicodedata

SPEC = importlib.util.spec_from_file_location(
    "opsmap_official_matcher", Path(__file__).with_name("match-official-addresses.py")
)
MATCHER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MATCHER)

CENTERS = {"osan", "yeongnam", "honam"}
CODE = re.compile(r"^[A-Z]\d{1,20}$")
HASH = re.compile(r"^[a-f0-9]{64}$")
PRIVATE = re.compile(r"[\x00-\x1f]|비밀번호|보안키|공동현관|bearer\s|(?:01[016789])[- ]?\d{3,4}[- ]?\d{4}", re.I)


def digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def address_hash(value):
    normalized = unicodedata.normalize("NFKC", value).strip().lower()
    return digest(" ".join(normalized.split()))


def classify(row, found):
    address = row["address"]
    if row.get("center") not in CENTERS:
        return "CENTER_REVIEW", None
    if not address.strip():
        return "ADDRESS_MISSING", None
    if len(address) > 200 or PRIVATE.search(address):
        return "ADDRESS_REVIEW", None
    if row.get("addressChanged") or row.get("coordinateStatus") == "CONFLICT":
        return "ADDRESS_CHANGED_REVIEW", None
    if row.get("previousPoint"):
        return "EXISTING_POINT_BINDING_REVIEW", None
    if row.get("currentAddressHash") != address_hash(address):
        return "ADDRESS_BINDING_REVIEW", None
    keys = MATCHER.address_keys(address)
    primary = MATCHER.address_key(address)
    if not primary:
        return "BUILDING_NUMBER_OR_SCOPE_UNCLEAR", None
    records = set().union(*(found.get(key, set()) for key in keys))
    if not records:
        return "OUTSIDE_OFFICIAL_CORPUS", None
    point, _ = MATCHER.choose_public(records, "")
    if not point:
        if any(item[1] is not None for item in records):
            return "OFFICIAL_CANDIDATES_REVIEW", None
        return "OFFICIAL_POINT_UNAVAILABLE", None
    if not found.get(primary):
        return "OFFICIAL_ALIAS_REVIEW", None
    # The commercial catalog carries business observations, not surveyed
    # building geometry. A shared point or a corrected-address alias never
    # authorizes applying a pin before structural-address review.
    identities = [{MATCHER.address_key(item[column]) for item in records} - {""} for column in (2, 3)]
    if any(len(identity) > 1 for identity in identities):
        return "OFFICIAL_ADDRESS_IDENTITY_REVIEW", None
    return "OFFICIAL_EXACT_CANDIDATE", {
        "customerCode": row["customerCode"], "centerGroup": row["center"],
        "addressHash": row["currentAddressHash"], "officialBuildingSha256": digest(point[0]),
        "lat": point[1][0], "lng": point[1][1],
        "candidateBasis": "COMMERCIAL_CATALOG_ADDRESS_MATCH", "reviewRequired": True,
        "deduplicatedObservations": len(records),
        "officialRoadKeySha256": digest(next(iter(identities[0]))) if identities[0] else None,
        "officialParcelKeySha256": digest(next(iter(identities[1]))) if identities[1] else None
    }


def audit(scope, found, queries):
    counts = Counter()
    by_center = defaultdict(Counter)
    candidates = []
    decisions = []
    for row in scope["rows"]:
        reason, candidate = classify(row, found)
        counts[reason] += 1
        by_center[row.get("center") if row.get("center") in CENTERS else "unclassified"][reason] += 1
        decisions.append({"customerCode": row["customerCode"], "reason": reason})
        if candidate:
            candidates.append(candidate)
    samples = defaultdict(list)
    for index, query in enumerate(queries, 1):
        records = set().union(*(found.get(key, set()) for key in MATCHER.address_keys(query)))
        point, _ = MATCHER.choose_public(records, "")
        samples["OFFICIAL_VERIFIED" if point else "CANDIDATE_REVIEW" if records else "SOURCE_NOT_COVERED"].append(index)
    return {
        "counts": dict(counts), "byCenter": {center: dict(reasons) for center, reasons in by_center.items()},
        "batchByStatus": dict(samples), "candidates": candidates, "decisions": decisions,
    }


def structural_matches(file, digest_expected, wanted):
    if not HASH.fullmatch(digest_expected):
        raise ValueError("STRUCTURAL_DATASET_DIGEST")
    if file.stat().st_size > 100 * 1024 * 1024:
        raise ValueError("STRUCTURAL_DATASET_SIZE")
    with file.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != digest_expected:
            raise ValueError("STRUCTURAL_DATASET_DIGEST")
    points = defaultdict(set)
    scanned = 0
    with file.open(encoding="utf-8-sig", newline="") as stream:
        rows = csv.DictReader(stream)
        if not {"건물명", "건물주소", "경도", "위도"}.issubset(rows.fieldnames or ()):
            raise ValueError("STRUCTURAL_DATASET_HEADERS")
        for record in rows:
            scanned += 1
            key = MATCHER.address_key(record["건물주소"])
            if key in wanted:
                point = MATCHER.point(record["위도"], record["경도"])
                if point:
                    points[key].add(point)
    return points, scanned


def corroborate(scope, result, queries, points):
    candidates = {candidate["customerCode"]: candidate for candidate in result["candidates"]}
    counts = Counter()
    for row in scope["rows"]:
        matches = points.get(MATCHER.address_key(row["address"]), set())
        candidate = candidates.get(row["customerCode"])
        if not matches:
            status = "NOT_IN_ELEVATOR_DATASET"
        elif len(matches) > 1:
            status = "MULTIPLE_ELEVATOR_POINTS"
        elif candidate:
            meters = round(MATCHER.distances((candidate["lat"], candidate["lng"]), next(iter(matches))) * 1000)
            status = "WITHIN_25M" if meters <= 25 else "OVER_25M"
            candidate["structuralAddressComparison"] = {"state": status, "distanceMeters": meters}
        else:
            status = "SINGLE_ELEVATOR_POINT_NO_COMMERCIAL_CANDIDATE"
        counts[status] += 1
    unresolved = set(result["batchByStatus"].get("CANDIDATE_REVIEW", [])) | set(result["batchByStatus"].get("SOURCE_NOT_COVERED", []))
    samples = defaultdict(list)
    for index in sorted(unresolved):
        count = len(points.get(MATCHER.address_key(queries[index-1]), set()))
        samples["MULTIPLE_ELEVATOR_POINTS" if count > 1 else "SINGLE_ELEVATOR_POINT" if count else "NOT_IN_ELEVATOR_DATASET"].append(index)
    return {"counts": dict(counts), "unresolvedBatchByStatus": dict(samples)}


def main():
    parser = argparse.ArgumentParser()
    for key in ("scope", "archive", "out"):
        parser.add_argument(f"--{key}", type=Path, required=True)
    parser.add_argument("--archive-sha256", required=True)
    parser.add_argument("--batch-tsv", type=Path)
    parser.add_argument("--building-csv", type=Path)
    parser.add_argument("--building-sha256")
    options = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    out = options.out.resolve()
    if root == out or root in out.parents or not out.is_dir():
        raise ValueError("PRIVATE_OUTPUT_DIRECTORY_REQUIRED")
    scope = json.loads(options.scope.read_text(encoding="utf-8-sig"))
    rows = scope["rows"]
    codes = [row["customerCode"] for row in rows]
    if not HASH.fullmatch(scope["sourceVersion"]) or not all(CODE.fullmatch(code) for code in codes) or (
        len(set(codes)) != len(rows) or len(rows) != scope["registered"] - scope["located"]
        or not rows or scope["registered"] > 30000 or any(not isinstance(row.get("address"), str) for row in rows)
    ):
        raise ValueError("COORDINATE_GAP_SCOPE_INCOMPLETE")
    with options.archive.open("rb") as stream:
        archive_hash = hashlib.file_digest(stream, "sha256").hexdigest()
    if archive_hash != options.archive_sha256:
        raise ValueError("OFFICIAL_ARCHIVE_DIGEST")
    queries = []
    if options.batch_tsv:
        with options.batch_tsv.open(encoding="utf-8-sig", newline="") as stream:
            batch = list(csv.reader(stream, delimiter="\t"))
        if not batch or any(len(row) != 2 or not row[0].strip() for row in batch):
            raise ValueError("ADDRESS_INPUT_CONTRACT")
        queries = [row[0] for row in batch]
    wanted = {key for query in [*queries, *(row["address"] for row in rows)] if len(query) <= 200
              and not PRIVATE.search(query) for key in MATCHER.address_keys(query)}
    found, scanned = MATCHER.official_rows(options.archive, wanted) if wanted else ({}, 0)
    result = audit(scope, found, queries)
    if bool(options.building_csv) != bool(options.building_sha256):
        raise ValueError("STRUCTURAL_DATASET_CONFIG")
    if options.building_csv:
        keys = {MATCHER.address_key(address) for address in [*queries, *(row["address"] for row in rows)]
                if len(address) <= 200 and not PRIVATE.search(address)} - {""}
        building_points, building_rows = structural_matches(options.building_csv, options.building_sha256, keys)
        result["structuralComparison"] = {"source": "https://www.data.go.kr/data/15156424/fileData.do",
            "sha256": options.building_sha256, "scanned": building_rows, **corroborate(scope, result, queries, building_points)}
    manifest = {
        "state": "CANDIDATE_ONLY", "sourceVersion": scope["sourceVersion"], "checkedAt": scope["checkedAt"],
        "registered": scope["registered"], "located": scope["located"], "missing": len(rows),
        "officialDatasetSha256": archive_hash, "officialRecordsScanned": scanned,
        "providerCalls": 0, "sourceWrites": 0, "batchRows": len(queries)
    }
    candidates, decisions = result.pop("candidates"), result.pop("decisions")
    with (out / "coordinate-gap-candidates.private.json").open("x", encoding="utf-8") as stream:
        json.dump({**manifest, "rows": candidates, "decisions": decisions}, stream, ensure_ascii=False)
    with (out / "coordinate-gap-summary.safe.json").open("x", encoding="utf-8") as stream:
        json.dump({**manifest, **result}, stream, ensure_ascii=False, indent=2)
    print(json.dumps({**manifest, **result}, ensure_ascii=True))


if __name__ == "__main__":
    main()
