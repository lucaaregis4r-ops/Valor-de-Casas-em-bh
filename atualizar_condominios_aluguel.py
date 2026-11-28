import csv
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

from scrape_imoveis_bh import FIELDNAMES, extract_condo_fee


INPUT = Path("moradias_bh_quintoandar_aluguel_2026.csv")
OUTPUT = Path("moradias_bh_quintoandar_aluguel_2026_corrigido.csv")
BACKUP = Path("moradias_bh_quintoandar_aluguel_2026.backup.csv")
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"
)


def request_text(url, timeout=30):
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,*/*;q=0.9",
            "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.read().decode("utf-8", errors="replace")


def main():
    if not INPUT.exists():
        raise SystemExit(f"Arquivo nao encontrado: {INPUT}")

    with INPUT.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        rows = list(reader)
        fieldnames = reader.fieldnames or FIELDNAMES

    if "adm-fees" not in fieldnames:
        fieldnames = list(fieldnames) + ["adm-fees"]

    if not BACKUP.exists():
        BACKUP.write_text(INPUT.read_text(encoding="utf-8-sig"), encoding="utf-8-sig")
    updated = 0
    checked = 0

    with OUTPUT.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()

        for row in rows:
            if row.get("adm-fees"):
                writer.writerow(row)
                continue

            url = row.get("url", "")
            if not url:
                writer.writerow(row)
                continue

            checked += 1
            try:
                page = request_text(url)
                condo = extract_condo_fee(page)
                if condo != "":
                    row["adm-fees"] = condo
                    updated += 1
                    print(f"ok {updated:>4}/{checked}: {condo} - {url}")
                else:
                    print(f"sem dado {checked}: {url}")
            except urllib.error.HTTPError as exc:
                print(f"HTTP {exc.code}: {url}")
            except Exception as exc:
                print(f"erro: {url} -> {exc}")

            writer.writerow(row)
            handle.flush()
            time.sleep(0.35)

    print()
    print(f"Conferidos: {checked}")
    print(f"Condominios preenchidos agora: {updated}")
    print(f"Arquivo corrigido: {OUTPUT}")
    print(f"Backup inicial preservado: {BACKUP}")


if __name__ == "__main__":
    main()
