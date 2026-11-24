"""Read the allowlisted columns of a FreshOn fixed-dispatch export."""
import hashlib
import json
import os
import re
import signal
import sys
from tempfile import TemporaryFile
from xml.etree import ElementTree as XML
from zipfile import ZipFile

MAX_DOWNLOAD = 64 * 1024**2
MAX_EXPANDED = 384 * 1024**2
CUSTOMER_CODE = re.compile(r"(?:[A-Z][0-9]+|[0-9]+)\Z")
NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
COLUMNS = tuple("ACDEFGHIJ")
CELL_ADDRESS = re.compile(r"([A-Z]+)([0-9]+)\Z")


def cell_text(cell, shared):
    if cell is None or cell.find(NS + "f") is not None:
        raise ValueError("FIXED_MASTER_EXCEL_FIELD")
    kind, value = cell.get("t", "n"), cell.find(NS + "v")
    if kind == "inlineStr":
        inline = cell.find(NS + "is")
        if inline is not None:
            return "".join(t.text or "" for t in inline.iter(NS + "t"))
    if value is not None:
        if kind == "str":
            return value.text or ""
        if kind == "n" and re.fullmatch(r"[0-9]+", value.text or ""):
            return value.text
        if kind == "s" and re.fullmatch(r"[0-9]+", value.text or ""):
            return shared[int(value.text)]
    raise ValueError("FIXED_MASTER_EXCEL_FIELD")


def xml_part(archive, name, limit):
    if archive.getinfo(name).file_size > limit:
        raise ValueError("FIXED_MASTER_EXCEL_LAYOUT")
    return XML.fromstring(archive.read(name))


def read_sheet(archive, expected, eligible):
    workbook = xml_part(archive, "xl/workbook.xml", 1024**2)
    sheets = workbook.findall(".//" + NS + "sheet")
    if len(sheets) != 1 or sheets[0].get("name") != "Sheet0":
        raise ValueError("FIXED_MASTER_EXCEL_LAYOUT")
    links = xml_part(archive, "xl/_rels/workbook.xml.rels", 1024**2)
    sheet_id = sheets[0].get(REL + "id")
    target = next((link.get("Target") for link in links if link.get("Id") == sheet_id
                   and (link.get("Type") or "").endswith("/worksheet")
                   and link.get("TargetMode") != "External"), None)
    if target not in ("worksheets/sheet1.xml", "/xl/worksheets/sheet1.xml"):
        raise ValueError("FIXED_MASTER_EXCEL_LAYOUT")
    shared = []
    if "xl/sharedStrings.xml" in archive.namelist():
        strings = xml_part(archive, "xl/sharedStrings.xml", 8 * 1024**2)
        shared = ["".join(t.text or "" for t in item.iter(NS + "t")) for item in strings]
    codes, selected, first = set(), [], None
    data = None
    number = 0
    with archive.open("xl/worksheets/sheet1.xml") as stream:
        for event, node in XML.iterparse(stream, events=("start", "end")):
            if event == "start" and node.tag == NS + "sheetData":
                data = node
            if event != "end" or node.tag != NS + "row" or data is None:
                continue
            number += 1
            if node.get("r") != str(number) or number > expected + 1:
                raise ValueError("FIXED_MASTER_EXCEL_ROW_COUNT")
            cells = {}
            for cell in node:
                address = CELL_ADDRESS.fullmatch(cell.get("r") or "")
                if address and address[1] in COLUMNS:
                    column = address[1]
                    if column in cells or address[2] != str(number):
                        raise ValueError("FIXED_MASTER_EXCEL_LAYOUT")
                    cells[column] = cell
            if number == 1:
                if [cell_text(cells.get(c), shared) for c in COLUMNS] != [
                    "고객", "주 호차정보", *"월화수목금토일"
                ]:
                    raise ValueError("FIXED_MASTER_EXCEL_LAYOUT")
            else:
                code = cell_text(cells.get("A"), shared).strip().upper()
                if len(code) > 64 or not CUSTOMER_CODE.fullmatch(code) or code in codes:
                    raise ValueError("FIXED_MASTER_EXCEL_CUSTOMER_KEY")
                codes.add(code)
                if first is None or code in eligible:
                    row = [code, *(cell_text(cells.get(c), shared) for c in COLUMNS[1:])]
                    if first is None:
                        first = row
                    if code in eligible:
                        selected.append(row)
            data.remove(node)
    if len(codes) != expected:
        raise ValueError("FIXED_MASTER_EXCEL_ROW_COUNT")
    return dict(codes=list(codes), selected=selected, first=first)


def read_export(config, source):
    expected = config["declaredRows"]
    eligible = set(config["codes"])
    digest = hashlib.sha256()
    size = 0
    with TemporaryFile() as spool:
        while chunk := source.read(128 * 1024):
            size += len(chunk)
            if size > MAX_DOWNLOAD:
                raise ValueError("FIXED_MASTER_EXCEL_DOWNLOAD_LIMIT")
            digest.update(chunk)
            spool.write(chunk)
        checksum = digest.hexdigest()
        if config.get("sha256") and checksum != config["sha256"]:
            raise ValueError("FIXED_MASTER_EXCEL_HASH")
        spool.seek(0)
        with ZipFile(spool) as archive:
            if sum(entry.file_size for entry in archive.infolist()) > MAX_EXPANDED:
                raise ValueError("FIXED_MASTER_EXCEL_EXPANSION_LIMIT")
            return dict(sha256=checksum, **read_sheet(archive, expected, eligible))


if __name__ == "__main__":
    if sys.platform == "linux":
        import ctypes

        # The memory guard can terminate the Node worker with SIGKILL.
        if ctypes.CDLL(None).prctl(1, signal.SIGTERM, 0, 0, 0) != 0 or os.getppid() != int(sys.argv[1]):
            sys.exit(1)
    try:
        result = read_export(json.loads(sys.stdin.buffer.readline(1024**2)), sys.stdin.buffer)
        print(json.dumps(result, separators=(",", ":")))
    except MemoryError:
        print("FIXED_MASTER_EXCEL_MEMORY", file=sys.stderr)
        sys.exit(1)
    except Exception as failure:
        message = str(failure)
        code = message if re.fullmatch(r"FIXED_MASTER_EXCEL_[A-Z_]+", message) else "FIXED_MASTER_EXCEL_INVALID"
        print(code, file=sys.stderr)
        sys.exit(1)
