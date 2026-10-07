import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from pipeline.collectors.source_01 import QuintoAndarCollector
from pipeline.geocoding_cache import NeighborhoodGeocodingCache


class GeocodingCacheTests(unittest.TestCase):
    def test_source_coordinates_are_cached_by_normalized_neighborhood(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "geocoding.json"
            cache = NeighborhoodGeocodingCache(path)
            updated = cache.update_from([
                {"city": "Belo Horizonte", "neighborhood": "Prado", "latitude": -19.93, "longitude": -43.96},
                {"city": "Belo Horizonte", "neighborhood": "Prado", "latitude": -19.94, "longitude": -43.97},
                {"city": "Belo Horizonte", "neighborhood": "Savassi", "latitude": -19.93, "longitude": -43.93},
            ], updated_at=datetime(2026, 10, 6, tzinfo=timezone.utc))
            cache.save()

            self.assertEqual(updated, 2)
            reloaded = NeighborhoodGeocodingCache(path)
            self.assertEqual(reloaded.lookup("belo horizonte", "PRÁDO"), (-19.935, -43.965))
            payload = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(payload["entries"]["belo horizonte|prado"]["precision"], "neighborhood")

    def test_collector_uses_cached_neighborhood_location_when_source_has_none(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = NeighborhoodGeocodingCache(Path(directory) / "geocoding.json")
            cache.update_from([{
                "city": "Belo Horizonte", "neighborhood": "Prado", "latitude": -19.93, "longitude": -43.96,
            }])
            collector = QuintoAndarCollector(delay_seconds=0, geocoding_cache=cache)

            listing, observation = collector.normalize({
                "source": "quintoandar",
                "listing_id": "example-1",
                "url": "https://www.quintoandar.com.br/imovel/example-1/alugar/apartamento-prado-belo-horizonte",
                "title": "Apartamento no Prado",
                "property_type": "apartment",
                "city": "Belo Horizonte",
                "neighborhood": "Prado",
                "address": "Rua de teste, Prado",
                "price": 1800,
                "square-foot": 60,
            }, datetime(2026, 10, 6, tzinfo=timezone.utc))

        self.assertEqual((listing.latitude, listing.longitude), (-19.93, -43.96))
        self.assertEqual(listing.location_precision, "neighborhood")
        self.assertEqual(collector.metrics["geocoding_cache_hits"], 1)
        self.assertEqual(observation.rent_price, 1800)

    def test_invalid_cache_is_ignored_and_reported(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "geocoding.json"
            path.write_text("not json", encoding="utf-8")
            cache = NeighborhoodGeocodingCache(path)

        self.assertIsNotNone(cache.load_warning)
        self.assertEqual(cache.entries, {})


if __name__ == "__main__":
    unittest.main()
