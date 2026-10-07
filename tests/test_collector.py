import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError

from pipeline.collectors.source_01 import QuintoAndarCollector, SITEMAP_URL
from pipeline.models import CollectionStatus
from pipeline.run_collection import run_collection
from pipeline.database import PostgresDatabase
from db_support import SQLiteConnectionAdapter


FIXTURE_DIR = Path(__file__).parent / "fixtures" / "quintoandar"
LISTING_URL = (
    "https://www.quintoandar.com.br/imovel/895532233/alugar/"
    "apartamento-2-quartos-prado-belo-horizonte"
)


def fixture_fetch(url):
    if url == SITEMAP_URL:
        return (FIXTURE_DIR / "sitemap_index.xml").read_text(encoding="utf-8")
    if url.endswith("sitemap-v2-listings-part-1.xml"):
        return (FIXTURE_DIR / "sitemap_listings.xml").read_text(encoding="utf-8")
    if url.rstrip("/") == LISTING_URL:
        return (FIXTURE_DIR / "listing_prado.html").read_text(encoding="utf-8")
    raise AssertionError(f"requisição inesperada: {url}")


class QuintoAndarCollectorTests(unittest.TestCase):
    def test_collects_and_normalizes_public_structured_listing(self):
        collector = QuintoAndarCollector(delay_seconds=0, fetch_text=fixture_fetch)
        records = collector.collect()

        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["listing_id"], "895532233")
        self.assertEqual(records[0]["title"], "Apartamento de 2 quartos no Prado")
        self.assertEqual(records[0]["property_type"], "apartment")

        observed_at = datetime(2026, 10, 6, tzinfo=timezone.utc)
        listing, observation = collector.normalize(records[0], observed_at)
        self.assertEqual(listing.identity_key, "source_id:895532233")
        self.assertNotIn("utm_source", listing.canonical_url)
        self.assertEqual(listing.neighborhood, "Prado")
        self.assertEqual(listing.city, "Belo Horizonte")
        self.assertEqual(listing.latitude, -19.9302)
        self.assertEqual(listing.area_m2, 60)
        self.assertEqual(listing.bedrooms, 2)
        self.assertEqual(listing.parking_spaces, 1)
        self.assertEqual(observation.rent_price, 1800)
        self.assertEqual(observation.condo_fee, 250)
        self.assertEqual(observation.total_price, 2050)
        self.assertEqual(observation.price_m2, 30)
        self.assertEqual(observation.observed_at, observed_at)

    def test_one_temporary_listing_error_does_not_discard_other_pages(self):
        failed_url = (
            "https://www.quintoandar.com.br/imovel/895532234/alugar/"
            "apartamento-2-quartos-prado-belo-horizonte"
        )
        index = """<sitemapindex><sitemap><loc>https://www.quintoandar.com.br/sitemap-v2-listings-part-1.xml</loc></sitemap></sitemapindex>"""
        sitemap = f"""<urlset><url><loc>{LISTING_URL}</loc></url><url><loc>{failed_url}</loc></url></urlset>"""

        def partial_fetch(url):
            if url == SITEMAP_URL:
                return index
            if url.endswith("sitemap-v2-listings-part-1.xml"):
                return sitemap
            if url.rstrip("/") == LISTING_URL:
                return (FIXTURE_DIR / "listing_prado.html").read_text(encoding="utf-8")
            if url.rstrip("/") == failed_url:
                raise HTTPError(url, 503, "temporariamente indisponível", None, None)
            raise AssertionError(f"requisição inesperada: {url}")

        collector = QuintoAndarCollector(delay_seconds=0, fetch_text=partial_fetch)
        records = collector.collect()

        self.assertEqual(len(records), 1)
        self.assertEqual(collector.metrics["pages_attempted"], 2)
        self.assertEqual(collector.metrics["pages_failed"], 1)
        self.assertEqual(collector.metrics["records_parsed"], 1)

    def test_two_runs_keep_one_listing_and_add_two_observations(self):
        collector = QuintoAndarCollector(delay_seconds=0, fetch_text=fixture_fetch)
        database = PostgresDatabase(SQLiteConnectionAdapter())
        self.addCleanup(database.close)
        first_seen = datetime(2026, 10, 6, tzinfo=timezone.utc)

        first = run_collection(collector, database, observed_at=first_seen)
        second = run_collection(collector, database, observed_at=first_seen + timedelta(days=1))

        self.assertEqual(first.records_new, 1)
        self.assertEqual(second.records_updated, 1)
        connection = database.connection.connection
        self.assertEqual(connection.execute("SELECT COUNT(*) FROM listings").fetchone()[0], 1)
        listing_id = connection.execute("SELECT id FROM listings").fetchone()[0]
        self.assertEqual(len(database.list_observations(listing_id)), 2)
        self.assertEqual(database.get_collection_run(1).status, CollectionStatus.SUCCESS)
        self.assertEqual(database.get_collection_run(2).status, CollectionStatus.SUCCESS)


if __name__ == "__main__":
    unittest.main()
