import unittest
from datetime import datetime, timedelta, timezone

from pipeline.collectors.base import Collector
from pipeline.database import PostgresDatabase
from pipeline.aggregate import build_public_dataset
from pipeline.models import Listing, Observation, CollectionStatus
from pipeline.run_collection import run_collection
from pipeline.validation import CollectionValidationError, CollectionValidationPolicy
from db_support import SQLiteConnectionAdapter


class StaticCollector(Collector):
    source = "test-source"

    def __init__(self, count, *, truncated=False, page_failures=0):
        self.count = count
        self.page_failures = page_failures
        self._metrics = {
            "truncated": truncated,
            "candidate_pages": count + page_failures,
            "pages_attempted": count + page_failures,
            "pages_fetched": count,
            "pages_failed": page_failures,
            "records_parsed": count,
        }

    @property
    def metrics(self):
        return dict(self._metrics)

    def collect(self):
        return [{"id": str(index)} for index in range(self.count)]

    def normalize(self, item, observed_at):
        listing = Listing(
            source=self.source,
            source_listing_id=item["id"],
            city="Belo Horizonte",
            neighborhood="Prado",
        )
        observation = Observation(observed_at=observed_at, rent_price=1800, total_price=1800)
        return listing, observation


class CollectionValidationTests(unittest.TestCase):
    def setUp(self):
        self.database = PostgresDatabase(SQLiteConnectionAdapter())
        self.addCleanup(self.database.close)
        self.first_seen = datetime(2026, 10, 6, tzinfo=timezone.utc)

    def test_truncated_collection_is_recorded_as_failed_without_writing(self):
        first = run_collection(StaticCollector(4), self.database, observed_at=self.first_seen)
        self.assertEqual(first.records_found, 4)

        with self.assertRaisesRegex(CollectionValidationError, "incompleta"):
            run_collection(
                StaticCollector(8, truncated=True),
                self.database,
                observed_at=self.first_seen + timedelta(days=1),
            )

        connection = self.database.connection.connection
        self.assertEqual(connection.execute("SELECT COUNT(*) FROM listings").fetchone()[0], 4)
        self.assertEqual(connection.execute("SELECT COUNT(*) FROM observations").fetchone()[0], 4)
        self.assertEqual(self.database.latest_successful_record_count("test-source"), 4)
        failed = self.database.get_collection_run(2)
        self.assertEqual(failed.status, CollectionStatus.FAILED)
        self.assertEqual(failed.records_found, 8)

    def test_large_drop_is_rejected_before_persisting(self):
        run_collection(StaticCollector(4), self.database, observed_at=self.first_seen)

        with self.assertRaisesRegex(CollectionValidationError, "queda de"):
            run_collection(
                StaticCollector(1),
                self.database,
                observed_at=self.first_seen + timedelta(days=1),
                policy=CollectionValidationPolicy(max_drop_percent=50),
            )

        connection = self.database.connection.connection
        self.assertEqual(connection.execute("SELECT COUNT(*) FROM listings").fetchone()[0], 4)
        self.assertEqual(connection.execute("SELECT COUNT(*) FROM observations").fetchone()[0], 4)

    def test_missing_bairro_or_city_is_rejected(self):
        class MissingLocationCollector(StaticCollector):
            def normalize(self, item, observed_at):
                listing, observation = super().normalize(item, observed_at)
                return Listing(source=self.source, source_listing_id=item["id"]), observation

        with self.assertRaisesRegex(CollectionValidationError, "sem cidade ou bairro"):
            run_collection(MissingLocationCollector(1), self.database, observed_at=self.first_seen)

        connection = self.database.connection.connection
        self.assertEqual(connection.execute("SELECT COUNT(*) FROM listings").fetchone()[0], 0)

    def test_low_json_ld_parse_rate_is_rejected(self):
        class ParseFailureCollector(StaticCollector):
            @property
            def metrics(self):
                return {
                    "truncated": False,
                    "candidate_pages": 10,
                    "pages_attempted": 10,
                    "pages_not_found": 0,
                    "records_parsed": 2,
                }

        with self.assertRaisesRegex(CollectionValidationError, "geraram anúncio normalizado"):
            run_collection(ParseFailureCollector(2), self.database, observed_at=self.first_seen)

        connection = self.database.connection.connection
        self.assertEqual(connection.execute("SELECT COUNT(*) FROM listings").fetchone()[0], 0)

    def test_partial_page_failure_is_rejected_and_saved_in_health_metrics(self):
        with self.assertRaisesRegex(CollectionValidationError, "falhas parciais"):
            run_collection(
                StaticCollector(10, page_failures=1),
                self.database,
                observed_at=self.first_seen,
                policy=CollectionValidationPolicy(max_page_failure_fraction=0.05),
            )

        failed = self.database.get_collection_run(1)
        self.assertEqual(failed.status, CollectionStatus.FAILED)
        self.assertEqual(failed.metrics["pages_failed"], 1)
        self.assertEqual(failed.metrics["page_failure_fraction"], 0.090909)

    def test_accepted_partial_run_is_marked_degraded(self):
        run_collection(
            StaticCollector(10, page_failures=1),
            self.database,
            observed_at=self.first_seen,
            policy=CollectionValidationPolicy(max_page_failure_fraction=0.1),
        )

        dataset = build_public_dataset(
            self.database.list_public_history(), self.database.list_collection_runs()
        )
        self.assertEqual(dataset.meta["health"]["status"], "degraded")
        self.assertEqual(dataset.meta["sources"][0]["health"], "degraded")
        self.assertEqual(dataset.meta["sources"][0]["metrics"]["pages_failed"], 1)


if __name__ == "__main__":
    unittest.main()
