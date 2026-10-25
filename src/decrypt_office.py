import sys

import msoffcrypto


def main():
    if len(sys.argv) != 4:
        print("usage: decrypt_office.py input output password", file=sys.stderr)
        return 2

    input_path, output_path, password = sys.argv[1:4]
    with open(input_path, "rb") as source:
        office_file = msoffcrypto.OfficeFile(source)
        office_file.load_key(password=password)
        with open(output_path, "wb") as target:
            office_file.decrypt(target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
