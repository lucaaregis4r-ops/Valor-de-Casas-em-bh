import csv
from pathlib import Path


INPUT = Path("moradias_bh_quintoandar_aluguel_2026.csv")
AUDIT = Path("condominios_outliers_removidos.csv")


def is_suspicious(row):
    try:
        rent = float(row.get("price") or 0)
        condo = float(row.get("adm-fees") or 0)
    except ValueError:
        return False
    if not condo:
        return False
    return condo > rent or condo > 10000


def main():
    with INPUT.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        rows = list(reader)
        fieldnames = reader.fieldnames or []

    removed = []
    for row in rows:
        if is_suspicious(row):
            removed.append(dict(row))
            row["adm-fees"] = ""

    with INPUT.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)

    with AUDIT.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(removed)

    print(f"Outliers removidos: {len(removed)}")
    print(f"Relatorio: {AUDIT}")


if __name__ == "__main__":
    main()
