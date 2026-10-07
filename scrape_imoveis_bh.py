import argparse
import csv
import html
import json
import re
import time
import unicodedata
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse


OUTPUT = Path("moradias_bh_raspadas.csv")
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"
)

RMBH_SLUGS = {
    "belo-horizonte",
    "contagem",
    "betim",
    "nova-lima",
    "sabara",
    "santa-luzia",
    "ribeirao-das-neves",
    "lagoa-santa",
    "vespasiano",
    "ibirite",
    "sarzedo",
    "brumadinho",
    "raposos",
    "mateus-leme",
    "pedro-leopoldo",
    "sao-jose-da-lapa",
    "confins",
    "jaboticatubas",
    "juatuba",
    "mario-campos",
    "sao-joaquim-de-bicas",
}

RMBH_CITIES = {
    "belo horizonte",
    "contagem",
    "betim",
    "nova lima",
    "sabara",
    "santa luzia",
    "ribeirao das neves",
    "lagoa santa",
    "vespasiano",
    "ibirite",
    "sarzedo",
    "brumadinho",
    "raposos",
    "mateus leme",
    "pedro leopoldo",
    "sao jose da lapa",
    "confins",
    "jaboticatubas",
    "juatuba",
    "mario campos",
    "sao joaquim de bicas",
}

FIELDNAMES = [
    "source",
    "listing_id",
    "url",
    "operation",
    "property_type",
    "address",
    "adm-fees",
    "iptu",
    "garage-places",
    "price",
    "rooms",
    "bathrooms",
    "square-foot",
    "neighborhood",
    "city",
    "latitude",
    "longitude",
    "collected_at",
    "sitemap_lastmod",
]


def request_text(url, timeout=30):
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "application/xml,text/xml,text/html,application/xhtml+xml,*/*;q=0.9",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
        "Referer": "https://www.google.com/",
    }
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.read().decode("utf-8", errors="replace")


def xml_locs(xml_text):
    root = ET.fromstring(xml_text)
    ns = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    entries = []
    for node in root.findall(".//sm:url", ns) + root.findall(".//sm:sitemap", ns):
        loc_node = node.find("sm:loc", ns)
        if loc_node is None or not loc_node.text:
            continue
        lastmod_node = node.find("sm:lastmod", ns)
        entries.append(
            {
                "loc": loc_node.text.strip(),
                "lastmod": lastmod_node.text.strip() if lastmod_node is not None and lastmod_node.text else "",
            }
        )
    return entries


def looks_like_rm_bh(url):
    low = url.lower()
    return any(slug in low for slug in RMBH_SLUGS)


def normalize_text(value):
    value = str(value or "").strip().lower()
    value = unicodedata.normalize("NFKD", value)
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def is_rm_bh_city(city):
    return normalize_text(city) in RMBH_CITIES


def clean_number(value):
    if value is None:
        return ""
    if isinstance(value, (int, float)):
        return value
    text = str(value)
    text = re.sub(r"[^\d,.-]", "", text)
    if "," in text and "." in text:
        text = text.replace(".", "").replace(",", ".")
    elif "," in text:
        text = text.replace(",", ".")
    try:
        return float(text)
    except ValueError:
        return ""


def extract_condo_fee(page_html):
    patterns = [
        r'"condoPrice"\s*:\s*("?[\d.,]+"?)',
        r'"condo(?:minium)?Fee"\s*:\s*("?[\d.,]+"?)',
        r'"condominium"\s*:\s*("?[\d.,]+"?)',
        r'"condominiumFee"\s*:\s*("?[\d.,]+"?)',
        r'"monthlyCondoFee"\s*:\s*("?[\d.,]+"?)',
        r'Condom.{0,8}nio[^\d]{0,40}?R\$\s*([\d.]+(?:,\d{2})?)',
        r'taxa de condom.{0,8}nio[^\d]{0,40}?R\$\s*([\d.]+(?:,\d{2})?)',
    ]
    for pattern in patterns:
        match = re.search(pattern, page_html, flags=re.I)
        if match:
            value = match.group(1).strip('"')
            number = clean_number(value)
            if number != "":
                return number
    clean_html = html.unescape(re.sub(r"<[^>]+>", " ", page_html))
    clean_html = re.sub(r"\s+", " ", clean_html)
    clean_patterns = [
        r"Condom.{0,8}nio.{0,80}?R\$\s*([\d.]+(?:,\d{2})?)",
        r"taxa de condom.{0,8}nio.{0,80}?R\$\s*([\d.]+(?:,\d{2})?)",
    ]
    for pattern in clean_patterns:
        match = re.search(pattern, clean_html, flags=re.I)
        if match:
            number = clean_number(match.group(1))
            if number != "":
                return number
    return ""


def sanitize_condo_fee(condo_fee, rent_price):
    if condo_fee in {"", None}:
        return ""
    try:
        condo = float(condo_fee)
        rent = float(rent_price)
    except (TypeError, ValueError):
        return ""
    if condo < 0:
        return ""
    # Some QuintoAndar pages expose broken condominium values such as
    # "Condomínio R$ 430.000" for a R$ 6.310 rent. Treat those as missing
    # instead of letting them distort the condominium index.
    if rent > 0 and condo > rent:
        return ""
    if condo > 10000:
        return ""
    return condo


def split_address(address):
    parts = [part.strip() for part in (address or "").split(",") if part.strip()]
    city = ""
    neighborhood = ""
    if len(parts) >= 2:
        city = parts[-1]
        neighborhood = parts[-2]
    return neighborhood, city


def json_ld_blocks(page_html):
    pattern = re.compile(
        r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        re.I | re.S,
    )
    for match in pattern.finditer(page_html):
        raw = html.unescape(match.group(1)).strip()
        try:
            yield json.loads(raw)
        except json.JSONDecodeError:
            continue


def next_data_house_info(page_html):
    """Return the public listing payload embedded by the current Next.js page."""
    pattern = re.compile(
        r'<script\b(?=[^>]*\bid=["\']__NEXT_DATA__["\'])[^>]*>(.*?)</script>',
        re.I | re.S,
    )
    match = pattern.search(page_html)
    if not match:
        return {}
    try:
        payload = json.loads(html.unescape(match.group(1)).strip())
    except (json.JSONDecodeError, TypeError):
        return {}
    value = payload
    for key in ("props", "pageProps", "initialState", "house", "houseInfo"):
        if not isinstance(value, dict):
            return {}
        value = value.get(key)
    return value if isinstance(value, dict) else {}


def _json_ld_dicts(value):
    if isinstance(value, list):
        for item in value:
            yield from _json_ld_dicts(item)
    elif isinstance(value, dict):
        yield value
        if "@graph" in value:
            yield from _json_ld_dicts(value["@graph"])


def parse_quintoandar_listing(url, page_html, lastmod=""):
    house_info = next_data_house_info(page_html)
    for value in json_ld_blocks(page_html):
        for candidate in _json_ld_dicts(value):
            block = candidate
            block_type = block.get("@type")
            if isinstance(block_type, list):
                block_type = next((item for item in block_type if isinstance(item, str)), "")
            listing_block = block
            if block_type == "RealEstateListing" and isinstance(block.get("about"), dict):
                block = block["about"]
                block_type = block.get("@type")
                if isinstance(block_type, list):
                    block_type = next((item for item in block_type if isinstance(item, str)), "")
            if block_type not in {"Apartment", "House", "SingleFamilyResidence", "Residence"}:
                continue

            actions = listing_block.get("potentialAction") or block.get("potentialAction") or []
            if isinstance(actions, dict):
                actions = [actions]
            action = next(
                (
                    item
                    for item in actions
                    if isinstance(item, dict)
                    and (item.get("price") is not None or item.get("priceSpecification") is not None)
                ),
                {},
            )
            offers = listing_block.get("offers") or block.get("offers") or {}
            if isinstance(offers, list):
                offers = offers[0] if offers else {}
            if not isinstance(offers, dict):
                offers = {}
            price_value = action.get("price")
            if price_value is None:
                specification = action.get("priceSpecification") or offers.get("priceSpecification") or {}
                if isinstance(specification, dict):
                    price_value = specification.get("price")
            if price_value is None:
                price_value = offers.get("price")
            if price_value is None:
                price_value = house_info.get("rentPrice") if "/alugar/" in url else house_info.get("salePrice")

            house_address = house_info.get("address") if isinstance(house_info.get("address"), dict) else {}
            geo = block.get("geo") or {}
            address_data = block.get("address") or house_address or ""
            if isinstance(address_data, dict):
                address = address_data.get("streetAddress") or address_data.get("name") or ""
                neighborhood = (
                    address_data.get("addressNeighborhood")
                    or address_data.get("neighborhood")
                    or house_address.get("neighborhood")
                    or (house_info.get("region") or {}).get("name", "")
                )
                city = address_data.get("addressLocality") or address_data.get("city") or house_info.get("city") or ""
            else:
                address = address_data
                neighborhood, city = split_address(address)
            parsed = urlparse(url)
            listing_id = ""
            match = re.search(r"/imovel/(\d+)", parsed.path)
            if match:
                listing_id = match.group(1)

            property_type = str(block_type).lower()
            url_lower = url.lower()
            if "/kitnet-" in url_lower or "/kitnet/" in url_lower:
                property_type = "kitnet"
            elif "/casa-" in url_lower or "/casa/" in url_lower:
                property_type = "house"
            elif "/apartamento-" in url_lower or "/apartamento/" in url_lower:
                property_type = "apartment"

            price = clean_number(price_value)
            condo_value = house_info.get("condoPrice")
            if condo_value in {None, ""}:
                condo_value = block.get("condoPrice")
            if condo_value in {None, ""}:
                condo_value = extract_condo_fee(page_html)
            condo_fee = sanitize_condo_fee(condo_value, price)
            floor_size = block.get("floorSize") or house_info.get("area")
            if isinstance(floor_size, dict):
                floor_size = floor_size.get("value") or floor_size.get("name")

            latitude = geo.get("latitude") if isinstance(geo, dict) else None
            longitude = geo.get("longitude") if isinstance(geo, dict) else None
            if latitude in {None, ""}:
                latitude = house_address.get("lat")
            if longitude in {None, ""}:
                longitude = house_address.get("lng")

            return {
                "source": "quintoandar",
                "listing_id": listing_id,
                "url": url,
                "operation": "rent" if "/alugar/" in url else "sale" if "/comprar/" in url else "",
                "property_type": property_type,
                "title": listing_block.get("name") or block.get("name") or block.get("headline") or "",
                "address": address,
                "adm-fees": condo_fee,
                "iptu": clean_number(house_info.get("iptu")),
                "garage-places": clean_number(block.get("numberOfParkingSpaces") or house_info.get("parkingSpaces")),
                "price": price,
                "rooms": block.get("numberOfBedrooms") or block.get("numberOfRooms") or house_info.get("bedrooms") or "",
                "bathrooms": block.get("numberOfFullBathrooms") or house_info.get("bathrooms") or "",
                "square-foot": clean_number(floor_size),
                "neighborhood": neighborhood,
                "city": city,
                "latitude": clean_number(latitude),
                "longitude": clean_number(longitude),
                "collected_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "sitemap_lastmod": lastmod,
            }
    return None


def quintoandar_urls(limit_sitemaps=None, operation="all"):
    index = request_text("https://www.quintoandar.com.br/sitemap-v2.xml")
    sitemaps = [
        entry["loc"]
        for entry in xml_locs(index)
        if "sitemap-v2-listings-part" in entry["loc"]
    ]
    if limit_sitemaps:
        sitemaps = sitemaps[:limit_sitemaps]

    for sitemap_url in sitemaps:
        print(f"Lendo sitemap QuintoAndar: {sitemap_url}")
        try:
            entries = xml_locs(request_text(sitemap_url))
        except Exception as exc:
            print(f"  erro no sitemap: {exc}")
            continue
        for entry in entries:
            loc = entry["loc"]
            if operation == "sale" and "/comprar/" not in loc:
                continue
            if operation == "rent" and "/alugar/" not in loc:
                continue
            if "/imovel/" in loc and looks_like_rm_bh(loc):
                yield entry


def scrape_quintoandar(
    max_pages,
    delay,
    limit_sitemaps=None,
    operation="all",
    writer=None,
    handle=None,
    existing_urls=None,
):
    rows = []
    seen = set(existing_urls or [])
    for entry in quintoandar_urls(limit_sitemaps=limit_sitemaps, operation=operation):
        url = entry["loc"]
        if url in seen:
            continue
        seen.add(url)
        if len(rows) >= max_pages:
            break
        try:
            page = request_text(url)
            row = parse_quintoandar_listing(url, page, entry.get("lastmod", ""))
            if row:
                if row["city"] and not is_rm_bh_city(row["city"]):
                    print(f"  fora RMBH: {row['city']} / {row['neighborhood']}")
                    time.sleep(delay)
                    continue
                rows.append(row)
                if writer:
                    writer.writerow(row)
                    if handle:
                        handle.flush()
                condo = row.get("adm-fees")
                condo_label = f"condominio R$ {condo}" if condo not in {"", None} else "sem condominio"
                type_label = row.get("property_type") or "tipo?"
                print(
                    f"  ok {len(rows):>4}: {type_label} / {row['city']} / {row['neighborhood']} / "
                    f"{row['price']} / {condo_label}"
                )
        except urllib.error.HTTPError as exc:
            print(f"  HTTP {exc.code}: {url}")
        except Exception as exc:
            print(f"  erro: {url} -> {exc}")
        time.sleep(delay)
    return rows


def olx_candidate_urls(limit_sitemaps=3):
    index = request_text("https://www.olx.com.br/mg/sitemap_index.xml")
    sitemaps = [entry["loc"] for entry in xml_locs(index)][:limit_sitemaps]
    for sitemap_url in sitemaps:
        print(f"Lendo sitemap OLX: {sitemap_url}")
        try:
            entries = xml_locs(request_text(sitemap_url))
        except Exception as exc:
            print(f"  erro no sitemap: {exc}")
            continue
        for entry in entries:
            loc = entry["loc"]
            low = loc.lower()
            if (
                "belo-horizonte-e-regiao" in low
                and any(term in low for term in ["imoveis", "apartamento", "casa", "aluguel", "venda"])
                and re.search(r"\d{8,}", low)
            ):
                yield entry


def parse_olx_listing(url, page_html, lastmod=""):
    data = None
    for block in json_ld_blocks(page_html):
        block_type = block.get("@type")
        if block_type in {"Product", "Offer", "Apartment", "House", "Residence"}:
            data = block
            break
    if not data:
        return None

    offers = data.get("offers") or {}
    address = ""
    neighborhood = ""
    city = ""
    if isinstance(data.get("address"), dict):
        address = data["address"].get("streetAddress", "") or data["address"].get("addressLocality", "")
        city = data["address"].get("addressLocality", "")
    else:
        address = data.get("address") or data.get("name") or ""
    if not city:
        neighborhood, city = split_address(address)

    geo = data.get("geo") or {}
    listing_id = ""
    match = re.search(r"(\d{8,})", url)
    if match:
        listing_id = match.group(1)

    return {
        "source": "olx",
        "listing_id": listing_id,
        "url": url,
        "operation": "",
        "property_type": "",
        "address": address,
        "adm-fees": "",
        "garage-places": "",
        "price": clean_number(offers.get("price") if isinstance(offers, dict) else ""),
        "rooms": "",
        "bathrooms": "",
        "square-foot": "",
        "neighborhood": neighborhood,
        "city": city,
        "latitude": clean_number(geo.get("latitude")),
        "longitude": clean_number(geo.get("longitude")),
        "collected_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sitemap_lastmod": lastmod,
    }


def scrape_olx(max_pages, delay, limit_sitemaps=3):
    rows = []
    seen = set()
    for entry in olx_candidate_urls(limit_sitemaps=limit_sitemaps):
        url = entry["loc"]
        if url in seen:
            continue
        seen.add(url)
        if len(rows) >= max_pages:
            break
        try:
            page = request_text(url)
            row = parse_olx_listing(url, page, entry.get("lastmod", ""))
            if row:
                rows.append(row)
                print(f"  ok {len(rows):>4}: {row['city']} / {row['price']}")
        except urllib.error.HTTPError as exc:
            print(f"  HTTP {exc.code}: {url}")
        except Exception as exc:
            print(f"  erro: {url} -> {exc}")
        time.sleep(delay)
    return rows


def write_rows(rows, output):
    with output.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDNAMES)
        writer.writeheader()
        writer.writerows(rows)


def read_existing_urls(output):
    if not output.exists() or output.stat().st_size == 0:
        return set()
    with output.open(newline="", encoding="utf-8-sig") as handle:
        return {row.get("url", "") for row in csv.DictReader(handle) if row.get("url")}


def main():
    parser = argparse.ArgumentParser(
        description="Raspa anúncios públicos de imóveis em BH/RMBH via sitemaps e JSON-LD."
    )
    parser.add_argument("--source", choices=["quintoandar", "olx", "all"], default="quintoandar")
    parser.add_argument(
        "--operation",
        choices=["sale", "rent", "all"],
        default="all",
        help="Filtra anúncios do QuintoAndar por compra/venda ou aluguel.",
    )
    parser.add_argument("--max-pages", type=int, default=50, help="Máximo de páginas de anúncio por fonte.")
    parser.add_argument("--delay", type=float, default=1.5, help="Pausa em segundos entre anúncios.")
    parser.add_argument("--output", default=str(OUTPUT))
    parser.add_argument("--limit-sitemaps", type=int, default=None, help="Útil para testes rápidos.")
    parser.add_argument(
        "--incremental",
        action="store_true",
        help="Salva cada anúncio imediatamente no CSV de saída.",
    )
    parser.add_argument(
        "--append",
        action="store_true",
        help="Continua um CSV existente, pulando URLs já salvas.",
    )
    args = parser.parse_args()

    rows = []
    output = Path(args.output)
    if args.incremental:
        existing_urls = read_existing_urls(output) if args.append else set()
        mode = "a" if args.append and output.exists() else "w"
        with output.open(mode, newline="", encoding="utf-8-sig") as handle:
            writer = csv.DictWriter(handle, fieldnames=FIELDNAMES)
            if mode == "w":
                writer.writeheader()
            handle.flush()
            if args.source in {"quintoandar", "all"}:
                rows.extend(
                    scrape_quintoandar(
                        args.max_pages,
                        args.delay,
                        args.limit_sitemaps,
                        args.operation,
                        writer=writer,
                        handle=handle,
                        existing_urls=existing_urls,
                    )
                )
            if args.source in {"olx", "all"}:
                olx_rows = scrape_olx(args.max_pages, args.delay, args.limit_sitemaps or 3)
                rows.extend(olx_rows)
                writer.writerows(olx_rows)
    else:
        if args.source in {"quintoandar", "all"}:
            rows.extend(scrape_quintoandar(args.max_pages, args.delay, args.limit_sitemaps, args.operation))
        if args.source in {"olx", "all"}:
            rows.extend(scrape_olx(args.max_pages, args.delay, args.limit_sitemaps or 3))
        write_rows(rows, output)
    print(f"\nArquivo gerado: {output}")
    print(f"Registros: {len(rows)}")


if __name__ == "__main__":
    main()
