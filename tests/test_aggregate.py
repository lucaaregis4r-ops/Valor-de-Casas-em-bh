import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from db_support import SQLiteConnectionAdapter
from pipeline.aggregate import LOCAL_TIMEZONE, build_public_dataset
from pipeline.database import PostgresDatabase
from pipeline.export_public import export_dataset, export_from_database
from pipeline.models import CollectionRun, CollectionStatus, Listing, Observation
from pipeline.run_collection import run_collection


class SnapshotCollector:
    source = "quintoandar"

    def __init__(self, listings):
        self.listings = listings

    @property
    def metrics(self):
        return {}

    def collect(self):
        return self.listings

    def normalize(self, item, observed_at):
        listing = Listing(
            source=self.source,
            source_listing_id=item["id"],
            canonical_url=f"https://example.test/imovel/{item['id']}",
            title=f"Apartamento {item['id']}",
            property_type="apartment",
            address=f"Rua {item['id']}, Prado, Belo Horizonte",
            neighborhood="Prado",
            city="Belo Horizonte",
            latitude=-19.93,
            longitude=-43.96,
            area_m2=item["area"],
            bedrooms=2,
        )
        rent = item["rent"]
        area = item["area"]
        observation = Observation(
            observed_at=observed_at,
            rent_price=rent,
            condo_fee=100,
            total_price=rent + 100,
            price_m2=rent / area,
        )
        return listing, observation


class PublicAggregateTests(unittest.TestCase):
    def setUp(self):
        self.database = PostgresDatabase(SQLiteConnectionAdapter())
        self.addCleanup(self.database.close)
        now_local = datetime.now(LOCAL_TIMEZONE)
        today_at_five = now_local.replace(hour=5, minute=0, second=0, microsecond=0)
        if today_at_five > now_local:
            today_at_five -= timedelta(days=1)
        self.second_run_at = today_at_five.astimezone(timezone.utc)
        self.first_run_at = self.second_run_at - timedelta(days=7)

    def test_daily_metrics_current_snapshot_and_json_export(self):
        first = SnapshotCollector([
            {"id": "a", "rent": 1000, "area": 50},
            {"id": "b", "rent": 2000, "area": 100},
        ])
        second = SnapshotCollector([
            {"id": "a", "rent": 900, "area": 50},
            {"id": "b", "rent": 2200, "area": 100},
            {"id": "c", "rent": 2500, "area": 100},
        ])
        run_collection(first, self.database, observed_at=self.first_run_at)
        run_collection(second, self.database, observed_at=self.second_run_at)

        with tempfile.TemporaryDirectory() as temporary_directory:
            dataset = export_from_database(self.database, temporary_directory)
            output_dir = Path(temporary_directory)
            current = json.loads((output_dir / "current.json").read_text(encoding="utf-8"))
            daily = json.loads((output_dir / "neighborhood_daily.json").read_text(encoding="utf-8"))
            events = json.loads((output_dir / "listing_events.json").read_text(encoding="utf-8"))
            meta = json.loads((output_dir / "meta.json").read_text(encoding="utf-8"))

        self.assertEqual(len(current), 3)
        self.assertEqual(current[0]["operation"], "rent")
        self.assertEqual(current[0]["source_listing_id"], "a")
        self.assertEqual(len(current[0]["price_history"]), 2)
        self.assertEqual(current[0]["price_history"][-1]["price"], current[0]["price"])
        self.assertEqual(meta["active_listings"], 3)
        self.assertEqual(meta["sources_ok"], 1)
        self.assertEqual(meta["health"]["status"], "healthy")
        self.assertEqual(meta["sources"][0]["metrics"]["records_found"], 3)
        self.assertEqual(len(daily), 2)

        latest = daily[-1]
        self.assertEqual(latest["active"], 3)
        self.assertEqual(latest["new"], 1)
        self.assertEqual(latest["price_reduced"], 1)
        self.assertEqual(latest["price_increased"], 1)
        self.assertEqual(latest["median_rent"], 2200)
        self.assertEqual(latest["median_price_m2"], 22)
        self.assertEqual(latest["p25_price_m2"], 20)
        self.assertEqual(latest["p75_price_m2"], 23.5)
        self.assertEqual(latest["variation_7d"], 0.1)
        self.assertEqual(latest["lat"], -19.93)
        self.assertCountEqual(
            [event["type"] for event in events],
            ["new", "new", "new", "price_reduced", "price_increased"],
        )

    def test_failed_run_is_not_exported_as_latest_public_snapshot(self):
        run_collection(
            SnapshotCollector([{"id": "a", "rent": 1000, "area": 50}]),
            self.database,
            observed_at=self.second_run_at,
        )
        failed_at = self.second_run_at + timedelta(hours=1)
        run_id = self.database.create_collection_run(
            CollectionRun(source="quintoandar", started_at=failed_at)
        )
        self.database.finish_collection_run(
            run_id,
            CollectionRun(
                source="quintoandar",
                started_at=failed_at,
                finished_at=failed_at + timedelta(minutes=1),
                status=CollectionStatus.FAILED,
                error_message="fixture error",
            ),
        )

        dataset = build_public_dataset(
            self.database.list_public_history(),
            self.database.list_collection_runs(),
            generated_at=failed_at + timedelta(minutes=2),
        )

        self.assertEqual(len(dataset.current), 1)
        self.assertEqual(dataset.meta["active_listings"], 1)
        self.assertEqual(dataset.meta["sources_ok"], 0)
        self.assertEqual(dataset.meta["sources_failed"], 1)
        self.assertEqual(dataset.meta["health"]["status"], "failed")
        self.assertEqual(dataset.meta["sources"][0]["health"], "failed")
        successful_finish = self.database.get_collection_run(1).finished_at
        self.assertEqual(
            dataset.meta["last_successful_update"],
            successful_finish.astimezone(LOCAL_TIMEZONE).isoformat(timespec="seconds"),
        )
        self.assertEqual(
            dataset.meta["sources"][0]["last_successful_update"],
            successful_finish.astimezone(LOCAL_TIMEZONE).isoformat(timespec="seconds"),
        )

    def test_invalid_json_values_do_not_replace_existing_public_files(self):
        from pipeline.aggregate import PublicDataset

        with tempfile.TemporaryDirectory() as temporary_directory:
            paths = export_dataset(PublicDataset([], [], [], {"schema_version": 1}), temporary_directory)
            before = {path.name: path.read_text(encoding="utf-8") for path in paths.values()}
            self.assertNotIn("\n  ", before["current.json"])
            with self.assertRaises(ValueError):
                export_dataset(PublicDataset([], [], [], {"not_finite": float("nan")}), temporary_directory)
            after = {path.name: path.read_text(encoding="utf-8") for path in paths.values()}

        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
