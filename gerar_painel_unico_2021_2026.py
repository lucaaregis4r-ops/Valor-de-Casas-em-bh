import csv
import json
import math
from pathlib import Path


BASE_2021 = Path("data.csv")
BASE_2026 = Path("moradias_bh_quintoandar_venda_2026.csv")
BASE_RENT_2026 = Path("moradias_bh_quintoandar_aluguel_2026.csv")
BASE_RENT_2026_FIXED = Path("moradias_bh_quintoandar_aluguel_2026_corrigido.csv")
BASELINE_DIR = Path("data/baseline")
BH_CENTER = (-19.9167, -43.9345)


def parse_area(value):
    value = str(value or "").strip()
    if not value or value == "--":
        return None
    if "-" in value:
        nums = []
        for part in value.split("-"):
            try:
                nums.append(float(part.strip()))
            except ValueError:
                pass
        return sum(nums) / len(nums) if nums else None
    try:
        return float(value)
    except ValueError:
        return None


def haversine_km(lat1, lon1, lat2, lon2):
    radius = 6371.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(a))


def load_points_2021():
    points = []
    with BASE_2021.open(newline="", encoding="utf-8-sig") as handle:
        for row in csv.DictReader(handle):
            try:
                lat = float(row["latitude"])
                lon = float(row["longitude"])
                price = float(row["price"])
            except (KeyError, TypeError, ValueError):
                continue
            area = parse_area(row.get("square-foot"))
            if not area or area <= 0 or price <= 0:
                continue
            if haversine_km(BH_CENTER[0], BH_CENTER[1], lat, lon) > 80:
                continue
            points.append(
                {
                    "year": 2021,
                    "source": "base_2021",
                    "operation": "sale",
                    "property_type": "apartment",
                    "city": (row.get("city") or "").strip(),
                    "neighborhood": (row.get("neighborhood") or "").strip(),
                    "address": (row.get("address") or "").strip(),
                    "lat": lat,
                    "lon": lon,
                    "price": round(price, 2),
                    "area": round(area, 2),
                    "price_m2": round(price / area, 2),
                    "rooms": (row.get("rooms") or "").strip(),
                    "condo_fee": None,
                }
            )
    return points


def load_points_2026():
    points = []
    with BASE_2026.open(newline="", encoding="utf-8-sig") as handle:
        for row in csv.DictReader(handle):
            try:
                lat = float(row["latitude"])
                lon = float(row["longitude"])
                price = float(row["price"])
            except (KeyError, TypeError, ValueError):
                continue
            area = parse_area(row.get("square-foot"))
            if not area or area <= 0 or price <= 0:
                continue
            if haversine_km(BH_CENTER[0], BH_CENTER[1], lat, lon) > 80:
                continue
            points.append(
                {
                    "year": 2026,
                    "source": (row.get("source") or "quintoandar").strip(),
                    "operation": "sale",
                    "property_type": (row.get("property_type") or "").strip() or "unknown",
                    "city": (row.get("city") or "").strip(),
                    "neighborhood": (row.get("neighborhood") or "").strip(),
                    "address": (row.get("address") or "").strip(),
                    "lat": lat,
                    "lon": lon,
                    "price": round(price, 2),
                    "area": round(area, 2),
                    "price_m2": round(price / area, 2),
                    "rooms": (row.get("rooms") or "").strip(),
                    "bathrooms": (row.get("bathrooms") or "").strip(),
                    "url": (row.get("url") or "").strip(),
                    "collected_at": (row.get("collected_at") or "").strip(),
                    "sitemap_lastmod": (row.get("sitemap_lastmod") or "").strip(),
                    "condo_fee": None,
                }
            )
    return points


def load_points_rent_2026():
    rent_source = BASE_RENT_2026_FIXED if BASE_RENT_2026_FIXED.exists() else BASE_RENT_2026
    if not rent_source.exists():
        return []
    points = []
    with rent_source.open(newline="", encoding="utf-8-sig") as handle:
        for row in csv.DictReader(handle):
            try:
                lat = float(row["latitude"])
                lon = float(row["longitude"])
                rent = float(row["price"])
            except (KeyError, TypeError, ValueError):
                continue
            area = parse_area(row.get("square-foot"))
            if not area or area <= 0 or rent <= 0:
                continue
            if haversine_km(BH_CENTER[0], BH_CENTER[1], lat, lon) > 80:
                continue
            try:
                condo_fee = float(row.get("adm-fees") or "") if row.get("adm-fees") else None
            except ValueError:
                condo_fee = None
            points.append(
                {
                    "year": 2026,
                    "source": (row.get("source") or "quintoandar").strip(),
                    "operation": "rent",
                    "property_type": (row.get("property_type") or "").strip() or "unknown",
                    "city": (row.get("city") or "").strip(),
                    "neighborhood": (row.get("neighborhood") or "").strip(),
                    "address": (row.get("address") or "").strip(),
                    "lat": lat,
                    "lon": lon,
                    "price": round(rent, 2),
                    "area": round(area, 2),
                    "price_m2": round(rent / area, 2),
                    "rooms": (row.get("rooms") or "").strip(),
                    "bathrooms": (row.get("bathrooms") or "").strip(),
                    "url": (row.get("url") or "").strip(),
                    "collected_at": (row.get("collected_at") or "").strip(),
                    "sitemap_lastmod": (row.get("sitemap_lastmod") or "").strip(),
                    "condo_fee": round(condo_fee, 2) if condo_fee is not None else None,
                }
            )
    return points


def main():
    points = load_points_2021() + load_points_2026() + load_points_rent_2026()
    BASELINE_DIR.mkdir(parents=True, exist_ok=True)

    for year in (2021, 2026):
        year_points = [point for point in points if point["year"] == year]
        output = BASELINE_DIR / f"{year}.json"
        output.write_text(
            json.dumps(year_points, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        print(f"Gerado: {output} ({len(year_points)} pontos)")

    cities = sorted({point["city"] for point in points if point["city"]})
    neighborhoods = sorted({point["neighborhood"] for point in points if point["neighborhood"]})
    print(f"Pontos totais: {len(points)}")
    print(f"Cidades: {len(cities)}")
    print(f"Bairros: {len(neighborhoods)}")


if __name__ == "__main__":
    main()
