from __future__ import annotations

import logging
import re
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import replace
from typing import Any, Callable
from urllib.parse import urlsplit

from ..geocoding_cache import NeighborhoodGeocodingCache
from ..models import normalize_url
from ..normalize import normalize_quintoandar_item
from .base import Collector

# Reuse the established QuintoAndar structured-data parser. This collector has
# its own conservative HTTP client and never calls the legacy browser-like one.
from scrape_imoveis_bh import (  # noqa: E402
    RMBH_SLUGS,
    is_rm_bh_city,
    parse_quintoandar_listing,
)


SITEMAP_URL = "https://www.quintoandar.com.br/sitemap-v2.xml"
QUINTOANDAR_HOST = "quintoandar.com.br"
logger = logging.getLogger(__name__)
_SOURCE_ID_IN_PATH = re.compile(r"/(?:imovel|imóvel)/([^/]+)", re.IGNORECASE)


class CollectionDeadlineExceeded(TimeoutError):
    """The configured whole-run deadline was reached."""


def _sitemap_entries(xml_text: str) -> list[dict[str, str]]:
    root = ET.fromstring(xml_text)
    entries = []
    for node in root.iter():
        if node.tag.rsplit("}", 1)[-1] not in {"url", "sitemap"}:
            continue
        fields = {child.tag.rsplit("}", 1)[-1]: (child.text or "").strip() for child in node}
        if fields.get("loc"):
            entries.append({"loc": fields["loc"], "lastmod": fields.get("lastmod", "")})
    return entries


def _is_quintoandar_url(url: str) -> bool:
    host = (urlsplit(url).hostname or "").lower()
    return host == QUINTOANDAR_HOST or host.endswith(f".{QUINTOANDAR_HOST}")


def _fetch_public_text(url: str, timeout: float = 25) -> str:
    if not _is_quintoandar_url(url):
        raise ValueError(f"URL fora do domínio público esperado: {url}")
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/xml,text/xml,text/html,application/xhtml+xml"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8", errors="replace")


class QuintoAndarCollector(Collector):
    """Collect rental listings from the public QuintoAndar sitemap and JSON-LD."""

    source = "quintoandar"

    def __init__(
        self,
        *,
        max_pages: int = 100,
        delay_seconds: float = 1.0,
        limit_sitemaps: int | None = None,
        max_duration_seconds: float = 14400,
        fetch_text: Callable[[str], str] | None = None,
        geocoding_cache: NeighborhoodGeocodingCache | None = None,
    ):
        if max_pages < 1:
            raise ValueError("max_pages precisa ser pelo menos 1")
        if delay_seconds < 0:
            raise ValueError("delay_seconds não pode ser negativo")
        if limit_sitemaps is not None and limit_sitemaps < 1:
            raise ValueError("limit_sitemaps precisa ser pelo menos 1")
        if max_duration_seconds < 1:
            raise ValueError("max_duration_seconds precisa ser pelo menos 1")
        self.max_pages = max_pages
        self.delay_seconds = delay_seconds
        self.limit_sitemaps = limit_sitemaps
        self.max_duration_seconds = max_duration_seconds
        self.fetch_text = fetch_text or _fetch_public_text
        self.geocoding_cache = geocoding_cache
        self._requests_made = 0
        self._collection_started = 0.0
        self._metrics: dict[str, Any] = {}
        self._source_coordinate_rows: list[dict[str, Any]] = []
        self._missing_source_listing_ids: set[str] = set()

    @property
    def source_coordinate_rows(self) -> list[dict[str, Any]]:
        return [dict(row) for row in self._source_coordinate_rows]

    @property
    def missing_source_listing_ids(self) -> tuple[str, ...]:
        return tuple(sorted(self._missing_source_listing_ids))

    @property
    def metrics(self) -> dict[str, Any]:
        return dict(self._metrics)

    def _fetch(self, url: str) -> str:
        if time.monotonic() - self._collection_started > self.max_duration_seconds:
            raise CollectionDeadlineExceeded("tempo máximo da coleta excedido")
        if self._requests_made and self.delay_seconds:
            time.sleep(self.delay_seconds)
        if time.monotonic() - self._collection_started > self.max_duration_seconds:
            raise CollectionDeadlineExceeded("tempo máximo da coleta excedido")
        self._requests_made += 1
        result = self.fetch_text(url)
        if time.monotonic() - self._collection_started > self.max_duration_seconds:
            raise CollectionDeadlineExceeded("tempo máximo da coleta excedido")
        return result

    def collect(self) -> list[dict[str, Any]]:
        self._requests_made = 0
        self._collection_started = time.monotonic()
        self._source_coordinate_rows = []
        self._missing_source_listing_ids = set()
        self._metrics = {
            "candidate_pages": 0,
            "pages_attempted": 0,
            "pages_not_found": 0,
            "pages_failed": 0,
            "pages_fetched": 0,
            "records_parsed": 0,
            "truncated": False,
            "geocoding_cache_hits": 0,
            "geocoding_cache_misses": 0,
            "geocoding_cache_load_warning": bool(
                self.geocoding_cache and self.geocoding_cache.load_warning
            ),
            "page_failure_samples": [],
        }
        index_entries = _sitemap_entries(self._fetch(SITEMAP_URL))
        sitemap_urls = [
            entry["loc"]
            for entry in index_entries
            if "sitemap-v2-listings-part" in entry["loc"]
        ]
        if self.limit_sitemaps is not None:
            sitemap_urls = sitemap_urls[: self.limit_sitemaps]

        candidates: list[dict[str, str]] = []
        seen_urls: set[str] = set()
        for sitemap_url in sitemap_urls:
            if not _is_quintoandar_url(sitemap_url):
                raise ValueError(f"Sitemap fora do domínio QuintoAndar: {sitemap_url}")
            for entry in _sitemap_entries(self._fetch(sitemap_url)):
                url = entry["loc"]
                if not _is_quintoandar_url(url):
                    continue
                lower_url = url.lower()
                if "/imovel/" not in lower_url or "/alugar/" not in lower_url:
                    continue
                if not any(slug in lower_url for slug in RMBH_SLUGS):
                    continue
                canonical = normalize_url(url)
                if canonical and canonical not in seen_urls:
                    candidates.append({"loc": url, "lastmod": entry.get("lastmod", "")})
                    seen_urls.add(canonical)

        self._metrics["candidate_pages"] = len(candidates)
        self._metrics["truncated"] = len(candidates) > self.max_pages
        records: list[dict[str, Any]] = []
        attempted = 0
        for entry in candidates:
            if attempted >= self.max_pages:
                break
            attempted += 1
            self._metrics["pages_attempted"] = attempted
            url = entry["loc"]
            try:
                page = self._fetch(url)
            except urllib.error.HTTPError as error:
                # A removed ad is expected; access blocks and rate limits stop the run.
                if error.code == 404:
                    self._metrics["pages_not_found"] += 1
                    match = _SOURCE_ID_IN_PATH.search(urlsplit(url).path)
                    if match:
                        self._missing_source_listing_ids.add(match.group(1))
                    continue
                if error.code in {408, 425} or 500 <= error.code < 600:
                    self._record_page_failure(url, error)
                    continue
                raise
            except CollectionDeadlineExceeded:
                raise
            except (urllib.error.URLError, TimeoutError) as error:
                self._record_page_failure(url, error)
                continue
            self._metrics["pages_fetched"] += 1
            try:
                row = parse_quintoandar_listing(url, page, entry.get("lastmod", ""))
            except (ValueError, TypeError, KeyError, ET.ParseError) as error:
                self._metrics["pages_unparsed"] = int(self._metrics.get("pages_unparsed", 0)) + 1
                self._record_page_failure(url, error)
                continue
            if not row or row.get("operation") != "rent":
                continue
            if row.get("city") and not is_rm_bh_city(row["city"]):
                continue

            records.append(row)
            self._metrics["records_parsed"] = len(records)
        return records

    def normalize(self, item: dict[str, Any], observed_at):
        listing, observation = normalize_quintoandar_item(item, observed_at)
        if listing.latitude is not None and listing.longitude is not None:
            if listing.city and listing.neighborhood:
                self._source_coordinate_rows.append({
                    "city": listing.city,
                    "neighborhood": listing.neighborhood,
                    "latitude": listing.latitude,
                    "longitude": listing.longitude,
                })
            return listing, observation

        if self.geocoding_cache is not None:
            coordinates = self.geocoding_cache.lookup(listing.city, listing.neighborhood)
            if coordinates is None:
                self._metrics["geocoding_cache_misses"] = int(self._metrics.get("geocoding_cache_misses", 0)) + 1
            else:
                self._metrics["geocoding_cache_hits"] = int(self._metrics.get("geocoding_cache_hits", 0)) + 1
                listing = replace(
                    listing,
                    latitude=coordinates[0],
                    longitude=coordinates[1],
                    location_precision="neighborhood",
                )
        return listing, observation

    def _record_page_failure(self, url: str, error: Exception) -> None:
        self._metrics["pages_failed"] = int(self._metrics.get("pages_failed", 0)) + 1
        samples = self._metrics.setdefault("page_failure_samples", [])
        if len(samples) < 5:
            samples.append({"url": url, "error": f"{type(error).__name__}: {error}"[:300]})
        logger.warning("Falha recuperável ao ler anúncio %s: %s: %s", url, type(error).__name__, error)
