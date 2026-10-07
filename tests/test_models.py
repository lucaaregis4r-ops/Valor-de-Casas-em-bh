import unittest
from datetime import datetime, timezone
from decimal import Decimal

from pipeline.models import CollectionRun, CollectionStatus, Listing, Observation


class ListingIdentityTests(unittest.TestCase):
    def test_source_listing_id_has_priority(self):
        listing = Listing(
            source="quintoandar",
            source_listing_id="7431",
            canonical_url="https://example.com/apartamento-7431",
        )
        self.assertEqual(listing.identity_key, "source_id:7431")

    def test_tracking_query_variants_share_canonical_url(self):
        first = Listing(
            source="site",
            canonical_url="HTTPS://EXAMPLE.COM/imovel/7431/?utm_source=mail&gclid=abc#details",
        )
        second = Listing(
            source="site",
            canonical_url="https://example.com/imovel/7431?utm_campaign=summer",
        )
        self.assertEqual(first.canonical_url, "https://example.com/imovel/7431")
        self.assertEqual(first.identity_key, second.identity_key)

    def test_stable_hash_uses_features_and_ignores_price(self):
        first = Listing(source="site", address="Rua A, 10", neighborhood="Centro", area_m2=55, bedrooms=2)
        second = Listing(source="site", address=" rua a, 10 ", neighborhood="CENTRO", area_m2="55.00", bedrooms=2)
        self.assertEqual(first.identity_key, second.identity_key)
        self.assertTrue(first.identity_key.startswith("stable_hash:"))

    def test_address_alone_is_not_an_identity(self):
        listing = Listing(source="site", address="Rua A, 10")
        with self.assertRaisesRegex(ValueError, "característica física"):
            _ = listing.identity_key

    def test_invalid_relative_url_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "HTTP ou HTTPS"):
            Listing(source="site", canonical_url="/imovel/7431")


class ObservationModelTests(unittest.TestCase):
    def test_prices_are_normalized_to_decimal(self):
        observation = Observation(
            observed_at=datetime(2026, 10, 1, tzinfo=timezone.utc),
            rent_price=1800,
            condo_fee="250.50",
        )
        self.assertEqual(observation.rent_price, Decimal("1800"))
        self.assertEqual(observation.condo_fee, Decimal("250.50"))

    def test_timestamp_requires_timezone(self):
        with self.assertRaisesRegex(ValueError, "fuso horário"):
            Observation(observed_at=datetime(2026, 10, 1))

    def test_unavailable_observation_cannot_carry_prices(self):
        with self.assertRaisesRegex(ValueError, "não pode conter valores"):
            Observation(
                observed_at=datetime(2026, 10, 1, tzinfo=timezone.utc),
                rent_price=1800,
                available=False,
            )

    def test_collection_run_tracks_status_and_counts(self):
        run = CollectionRun(
            source="site",
            started_at=datetime(2026, 10, 1, tzinfo=timezone.utc),
            status=CollectionStatus.SUCCESS,
            records_found=12,
            records_new=3,
            metrics={"duration_seconds": 12.5},
        )
        self.assertEqual(run.status, CollectionStatus.SUCCESS)
        self.assertEqual(run.records_found, 12)
        self.assertEqual(run.metrics["duration_seconds"], 12.5)


if __name__ == "__main__":
    unittest.main()
