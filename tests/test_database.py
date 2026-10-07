import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from decimal import Decimal

from pipeline.database import PostgresDatabase
from pipeline.aggregate import build_public_dataset
from pipeline.ingest import PreparedCollection, persist_prepared_collection
from pipeline.models import CollectionRun, CollectionStatus, Listing, Observation
from db_support import SQLiteConnectionAdapter


class PostgresDatabasePersistenceTests(unittest.TestCase):
    def setUp(self):
        self.connection = SQLiteConnectionAdapter()
        self.database = PostgresDatabase(self.connection)

    def tearDown(self):
        self.database.close()

    def test_reconstructs_price_history_and_a_missing_day(self):
        first_seen = datetime(2026, 10, 1, tzinfo=timezone.utc)
        listing = Listing(
            source="quintoandar",
            source_listing_id="7431",
            canonical_url="https://example.com/imovel/7431?utm_source=mail",
            title="Apartamento no Prado",
            address="Rua A, 10",
            neighborhood="Prado",
            city="Belo Horizonte",
            area_m2=60,
            bedrooms=2,
        )
        listing_id = self.database.save_snapshot(
            listing,
            Observation(observed_at=first_seen, rent_price=1800, condo_fee=250),
        )
        self.database.save_snapshot(
            listing,
            Observation(observed_at=first_seen + timedelta(days=1), rent_price=1800, condo_fee=250),
        )
        self.database.save_snapshot(
            listing,
            Observation(observed_at=first_seen + timedelta(days=2), rent_price=1750, condo_fee=250),
        )
        self.database.record_observation(
            listing_id,
            Observation(observed_at=first_seen + timedelta(days=3), available=False),
        )

        history = self.database.list_observations(listing_id)
        self.assertEqual(len(history), 4)
        self.assertEqual([row.rent_price for row in history[:3]], [Decimal("1800"), Decimal("1800"), Decimal("1750")])
        self.assertTrue(all(row.available for row in history[:3]))
        self.assertFalse(history[3].available)
        self.assertIsNone(history[3].rent_price)
        self.assertEqual([row.listing_id for row in history], [listing_id] * 4)

    def test_same_listing_and_timestamp_upsert_without_duplicate(self):
        observed_at = datetime(2026, 10, 1, tzinfo=timezone.utc)
        listing = Listing(source="site", source_listing_id="42")
        listing_id = self.database.save_snapshot(
            listing,
            Observation(observed_at=observed_at, rent_price=2000),
        )
        self.database.save_snapshot(
            listing,
            Observation(observed_at=observed_at, rent_price=1900),
        )

        history = self.database.list_observations(listing_id)
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0].rent_price, Decimal("1900"))

    def test_collection_run_can_be_started_and_finished(self):
        started_at = datetime(2026, 10, 1, tzinfo=timezone.utc)
        run_id = self.database.create_collection_run(CollectionRun(source="site", started_at=started_at))
        result = CollectionRun(
            source="site",
            started_at=started_at,
            finished_at=started_at + timedelta(minutes=5),
            status=CollectionStatus.SUCCESS,
            records_found=10,
            records_new=2,
            records_updated=8,
            metrics={"pages_attempted": 12, "pages_failed": 1},
        )
        self.database.finish_collection_run(run_id, result)

        saved = self.database.get_collection_run(run_id)
        self.assertIsNotNone(saved)
        self.assertEqual(saved.status, CollectionStatus.SUCCESS)
        self.assertEqual(saved.records_found, 10)
        self.assertEqual(saved.records_updated, 8)
        self.assertEqual(saved.metrics, {"pages_attempted": 12, "pages_failed": 1})
        self.assertEqual(saved.finished_at, result.finished_at)

    def test_known_404_listing_is_marked_removed_only_in_a_successful_run(self):
        first_at = datetime(2026, 10, 1, tzinfo=timezone.utc)
        second_at = first_at + timedelta(days=1)
        listing = Listing(
            source="quintoandar",
            source_listing_id="42",
            canonical_url="https://example.test/imovel/42",
            city="Belo Horizonte",
            neighborhood="Prado",
            latitude=-19.93,
            longitude=-43.96,
        )
        first_run = self.database.create_collection_run(CollectionRun(source="quintoandar", started_at=first_at))
        self.database.save_snapshot(listing, Observation(observed_at=first_at, rent_price=1800, price_m2=30))
        self.database.finish_collection_run(first_run, CollectionRun(
            source="quintoandar", started_at=first_at, finished_at=first_at,
            status=CollectionStatus.SUCCESS, records_found=1,
        ))

        prepared = PreparedCollection(
            source="quintoandar",
            observed_at=second_at,
            records_received=0,
            snapshots=(),
            normalization_errors=(),
            normalization_error_count=0,
            metrics={"pages_not_found": 1},
            missing_source_listing_ids=("42",),
        )
        second_run = self.database.create_collection_run(CollectionRun(source="quintoandar", started_at=second_at))
        summary = persist_prepared_collection(prepared, self.database)
        self.database.finish_collection_run(second_run, CollectionRun(
            source="quintoandar", started_at=second_at, finished_at=second_at,
            status=CollectionStatus.SUCCESS, records_missing=summary.records_missing,
        ))

        self.assertEqual(summary.records_missing, 1)
        history = self.database.list_observations(self.database.listing_id_for(listing))
        self.assertTrue(history[-1].available is False)
        dataset = build_public_dataset(self.database.list_public_history(), self.database.list_collection_runs())
        self.assertEqual(dataset.neighborhood_daily[-1]["removed"], 1)
        self.assertEqual(dataset.listing_events[-1]["type"], "removed")

    def test_batch_write_rolls_back_if_one_listing_fails(self):
        observed_at = datetime(2026, 10, 1, tzinfo=timezone.utc)
        snapshots = [
            (Listing(source="site", source_listing_id=str(index)),
             Observation(observed_at=observed_at, rent_price=1800))
            for index in (1, 2)
        ]
        with patch.object(self.database, "_upsert_observation", side_effect=[None, RuntimeError("db write failed")]):
            with self.assertRaisesRegex(RuntimeError, "db write failed"):
                self.database.persist_collection_batch(
                    snapshots, source="site", observed_at=observed_at
                )

        connection = self.database.connection.connection
        self.assertEqual(connection.execute("SELECT COUNT(*) FROM listings").fetchone()[0], 0)
        self.assertEqual(connection.execute("SELECT COUNT(*) FROM observations").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
