import json
import os
import sys
import tempfile
from datetime import date, datetime

import msoffcrypto
from openpyxl import load_workbook


def normalize_cell(value):
    if value is None:
        return ""
    if isinstance(value, (datetime, date)):
        return value.isoformat()[:10]
    return str(value).strip()


def load_plain_workbook(path):
    return load_workbook(path, read_only=True, data_only=True)


def load_decrypted_workbook(input_path, password):
    temp = tempfile.NamedTemporaryFile(delete=False, suffix=".xlsx")
    temp.close()
    try:
        with open(input_path, "rb") as source:
            office_file = msoffcrypto.OfficeFile(source)
            office_file.load_key(password=password)
            with open(temp.name, "wb") as target:
                office_file.decrypt(target)
        return load_plain_workbook(temp.name), temp.name
    except Exception:
        try:
            os.unlink(temp.name)
        except OSError:
            pass
        raise


def workbook_for(path, password):
    try:
        return load_plain_workbook(path), None
    except Exception as plain_error:
        try:
            return load_decrypted_workbook(path, password)
        except Exception as decrypt_error:
            raise RuntimeError(f"plain open failed: {plain_error} / decrypt failed: {decrypt_error}") from decrypt_error


def rows_from_sheet(sheet, source_file):
    rows = []
    columns = set()
    header = None

    for row_values in sheet.iter_rows(values_only=True):
        normalized = [normalize_cell(value) for value in row_values]
        if header is None:
            if not any(normalized):
                continue
            header = [value or f"column_{index + 1}" for index, value in enumerate(normalized)]
            for column in header:
                if column and not column.startswith("__EMPTY"):
                    columns.add(column)
            continue

        row = {}
        for index, column in enumerate(header):
            if not column or column.startswith("__EMPTY"):
                continue
            row[column] = normalized[index] if index < len(normalized) else ""
        if any(row.values()):
            row["_sourceFile"] = source_file
            row["_sourceSheet"] = sheet.title
            rows.append(row)

    return rows, columns


def main():
    if len(sys.argv) != 5:
        print("usage: parse_excel.py input output password source_name", file=sys.stderr)
        return 2

    input_path, output_path, password, source_name = sys.argv[1:5]
    decrypted_path = None
    try:
        workbook, decrypted_path = workbook_for(input_path, password)
        all_rows = []
        all_columns = set()
        for sheet in workbook.worksheets:
            rows, columns = rows_from_sheet(sheet, source_name)
            all_rows.extend(rows)
            all_columns.update(columns)
        workbook.close()

        with open(output_path, "w", encoding="utf-8") as target:
            json.dump({"rows": all_rows, "columns": sorted(all_columns)}, target, ensure_ascii=False, separators=(",", ":"))
        return 0
    finally:
        if decrypted_path:
            try:
                os.unlink(decrypted_path)
            except OSError:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
