from __future__ import annotations

import json
import os
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator

from .models import CollectionRun, CollectionStatus, Listing, Observation


class PostgresDatabase:
    """Small PostgreSQL persistence layer for listings and their observations."""

    def __init__(self, connection: Any):
        self.connection = connection

    @classmethod
    def connect(cls, database_url: str) -> PostgresDatabase:
        if not database_url or not database_url.strip():
            raise ValueError("DATABASE_URL não pode estar vazio")
        try:
            import psycopg
        except ImportError as error:
            raise RuntimeError("Instale as dependências com: python -m pip install -r requirements.txt") from error
        return cls(psycopg.connect(database_url))

    @classmethod
    def from_env(cls) -> PostgresDatabase:
        database_url = os.environ.get("DATABASE_URL")
        if not database_url:
            raise RuntimeError("Defina DATABASE_URL no ambiente antes de conectar ao PostgreSQL")
        return cls.connect(database_url)

    def __enter__(self) -> PostgresDatabase:
        return self

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        self.close()

    def close(self) -> None:
        self.connection.close()

    @contextmanager
    def _transaction(self) -> Iterator[None]:
        try:
            yield
        except Exception:
            self.connection.rollback()
            raise
        else:
            self.connection.commit()

    def initialize_schema(self) -> None:
        schema_path = Path(__file__).with_name("schema.sql")
        cursor = self.connection.cursor()
        try:
            schema = schema_path.read_text(encoding="utf-8")
            for statement in schema.split(";"):
                if statement.strip():
                    cursor.execute(statement)
        finally:
            cursor.close()
        self.connection.commit()

    def save_snapshot(self, listing: Listing, observation: Observation) -> int:
        """Upsert an available listing and its observation as one transaction."""
        if not observation.available:
            raise ValueError("use record_observation para registrar uma ausência")
        with self._transaction():
            listing_id = self._save_snapshot_uncommitted(listing, observation)
        return listing_id

    def persist_collection_batch(
        self,
        snapshots: list[tuple[Listing, Observation]] | tuple[tuple[Listing, Observation], ...],
        *,
        source: str,
        observed_at: datetime,
        missing_source_listing_ids: tuple[str, ...] = (),
    ) -> tuple[int, int, int]:
        """Persist all accepted snapshots and known 404s in one transaction."""
        records_new = 0
        records_updated = 0
        records_missing = 0
        present_source_ids = {
            listing.source_listing_id for listing, _ in snapshots if listing.source_listing_id
        }
        with self._transaction():
            for listing, observation in snapshots:
                if self.listing_id_for(listing) is None:
                    records_new += 1
                else:
                    records_updated += 1
                self._save_snapshot_uncommitted(listing, observation)
            for source_listing_id in missing_source_listing_ids:
                if source_listing_id in present_source_ids:
                    continue
                listing_id = self.listing_id_for_source_listing_id(source, source_listing_id)
                if listing_id is None:
                    continue
                self._upsert_observation(
                    listing_id,
                    Observation(observed_at=observed_at, available=False),
                )
                records_missing += 1
        return records_new, records_updated, records_missing

    def _save_snapshot_uncommitted(self, listing: Listing, observation: Observation) -> int:
        listing_id = self._upsert_listing(listing, observation.observed_at)
        self._upsert_observation(listing_id, observation)
        self._update_seen_at(listing_id, observation.observed_at)
        return listing_id

    def record_observation(self, listing_id: int, observation: Observation) -> int:
        """Record an available or missing observation for an existing listing."""
        if observation.listing_id is not None and observation.listing_id != listing_id:
            raise ValueError("listing_id da observação não corresponde ao argumento")
        with self._transaction():
            observation_id = self._upsert_observation(listing_id, observation)
            if observation.available:
                self._update_seen_at(listing_id, observation.observed_at)
        return observation_id

    def _upsert_listing(self, listing: Listing, observed_at: datetime) -> int:
        columns = (
            "source", "identity_key", "source_listing_id", "canonical_url", "title", "property_type", "address",
            "neighborhood", "city", "latitude", "longitude", "location_precision", "area_m2", "bedrooms", "bathrooms",
            "parking_spaces", "first_seen_at", "last_seen_at", "current_status", "created_at", "updated_at",
        )
        values = (
            listing.source, listing.identity_key, listing.source_listing_id, listing.canonical_url,
            listing.title, listing.property_type, listing.address, listing.neighborhood, listing.city, listing.latitude,
            listing.longitude, listing.location_precision, listing.area_m2, listing.bedrooms, listing.bathrooms,
            listing.parking_spaces, observed_at, observed_at, "active", observed_at, observed_at,
        )
        update_fields = (
            "source_listing_id", "canonical_url", "title", "property_type", "address", "neighborhood", "city",
            "latitude", "longitude", "area_m2", "bedrooms", "bathrooms", "parking_spaces",
        )
        updates = ", ".join(
            f"{field} = COALESCE(EXCLUDED.{field}, listings.{field})" for field in update_fields
        )
        updates += ", location_precision = CASE " \
            "WHEN EXCLUDED.latitude IS NOT NULL AND EXCLUDED.longitude IS NOT NULL " \
            "THEN EXCLUDED.location_precision ELSE listings.location_precision END"
        sql = (
            f"INSERT INTO listings ({', '.join(columns)}) "
            f"VALUES ({', '.join(['%s'] * len(columns))}) "
            f"ON CONFLICT (source, identity_key) DO UPDATE SET {updates}, updated_at = EXCLUDED.updated_at "
            "RETURNING id"
        )
        return int(self._fetchone(sql, values)[0])

    def listing_id_for(self, listing: Listing) -> int | None:
        """Return an existing source-scoped identity, if it has been collected before."""
        row = self._fetchone(
            "SELECT id FROM listings WHERE source = %s AND identity_key = %s",
            (listing.source, listing.identity_key),
        )
        return int(row[0]) if row is not None else None

    def listing_id_for_source_listing_id(self, source: str, source_listing_id: str) -> int | None:
        row = self._fetchone(
            """SELECT id FROM listings
               WHERE source = %s AND source_listing_id = %s
               ORDER BY id ASC LIMIT 1""",
            (source, source_listing_id),
        )
        return int(row[0]) if row is not None else None

    def latest_successful_record_count(self, source: str) -> int | None:
        """Return the newest accepted collection size for a source, if one exists."""
        row = self._fetchone(
            """SELECT records_found FROM collection_runs
               WHERE source = %s AND status = 'success'
               ORDER BY started_at DESC, id DESC LIMIT 1""",
            (source,),
        )
        return int(row[0]) if row is not None else None

    def list_collection_runs(self) -> list[CollectionRun]:
        cursor = self.connection.cursor()
        try:
            cursor.execute(
                """SELECT id, source, started_at, finished_at, status, records_found, records_new,
                          records_updated, records_missing, error_message, metrics_json
                   FROM collection_runs ORDER BY started_at ASC, id ASC"""
            )
            rows = cursor.fetchall()
        finally:
            cursor.close()
        return [_collection_run_from_row(row) for row in rows]

    def list_public_history(self) -> list[dict[str, Any]]:
        """Return only observations from successfully validated collection runs."""
        fields = (
            "listing_id", "source", "source_listing_id", "canonical_url", "title", "property_type",
            "address", "neighborhood", "city", "latitude", "longitude", "location_precision", "area_m2", "bedrooms",
            "bathrooms", "parking_spaces", "first_seen_at", "last_seen_at", "current_status",
            "observed_at", "rent_price", "condo_fee", "iptu", "total_price", "price_m2", "available",
        )
        cursor = self.connection.cursor()
        try:
            cursor.execute(
                """SELECT l.id, l.source, l.source_listing_id, l.canonical_url, l.title, l.property_type,
                          l.address, l.neighborhood, l.city, l.latitude, l.longitude, l.location_precision, l.area_m2,
                          l.bedrooms, l.bathrooms, l.parking_spaces, l.first_seen_at, l.last_seen_at,
                          l.current_status, o.observed_at, o.rent_price, o.condo_fee, o.iptu,
                          o.total_price, o.price_m2, o.available
                   FROM listings l
                   JOIN observations o ON o.listing_id = l.id
                   WHERE EXISTS (
                       SELECT 1 FROM collection_runs r
                       WHERE r.source = l.source AND r.started_at = o.observed_at AND r.status = 'success'
                   )
                   ORDER BY o.observed_at ASC, l.source ASC, l.id ASC"""
            )
            rows = cursor.fetchall()
        finally:
            cursor.close()

        result = []
        for row in rows:
            item = dict(zip(fields, row))
            for field_name in ("first_seen_at", "last_seen_at", "observed_at"):
                item[field_name] = _parse_datetime(item[field_name])
            item["available"] = bool(item["available"])
            result.append(item)
        return result

    def _upsert_observation(self, listing_id: int, observation: Observation) -> int:
        columns = (
            "listing_id", "observed_at", "rent_price", "condo_fee", "iptu", "total_price", "price_m2", "available"
        )
        values = (
            listing_id, observation.observed_at, observation.rent_price, observation.condo_fee,
            observation.iptu, observation.total_price, observation.price_m2, observation.available,
        )
        update_fields = ("rent_price", "condo_fee", "iptu", "total_price", "price_m2", "available")
        updates = ", ".join(f"{field} = EXCLUDED.{field}" for field in update_fields)
        sql = (
            f"INSERT INTO observations ({', '.join(columns)}) "
            f"VALUES ({', '.join(['%s'] * len(columns))}) "
            f"ON CONFLICT (listing_id, observed_at) DO UPDATE SET {updates} "
            "RETURNING id"
        )
        return int(self._fetchone(sql, values)[0])

    def _update_seen_at(self, listing_id: int, observed_at: datetime) -> None:
        sql = """
            UPDATE listings
            SET first_seen_at = CASE WHEN first_seen_at > %s THEN %s ELSE first_seen_at END,
                last_seen_at = CASE WHEN last_seen_at < %s THEN %s ELSE last_seen_at END,
                current_status = 'active',
                updated_at = %s
            WHERE id = %s
        """
        self._execute(sql, (observed_at, observed_at, observed_at, observed_at, observed_at, listing_id))

    def list_observations(self, listing_id: int) -> list[Observation]:
        sql = """
            SELECT id, listing_id, observed_at, rent_price, condo_fee, iptu, total_price, price_m2, available
            FROM observations
            WHERE listing_id = %s
            ORDER BY observed_at ASC, id ASC
        """
        cursor = self.connection.cursor()
        try:
            cursor.execute(sql, (listing_id,))
            rows = cursor.fetchall()
        finally:
            cursor.close()
        return [
            Observation(
                id=int(row[0]),
                listing_id=int(row[1]),
                observed_at=_parse_datetime(row[2]),
                rent_price=row[3],
                condo_fee=row[4],
                iptu=row[5],
                total_price=row[6],
                price_m2=row[7],
                available=bool(row[8]),
            )
            for row in rows
        ]

    def create_collection_run(self, run: CollectionRun) -> int:
        sql = """
            INSERT INTO collection_runs (
                source, started_at, finished_at, status, records_found, records_new,
                records_updated, records_missing, error_message, metrics_json
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
        """
        values = (
            run.source, run.started_at, run.finished_at, run.status.value, run.records_found,
            run.records_new, run.records_updated, run.records_missing, run.error_message,
            json.dumps(run.metrics, ensure_ascii=False, separators=(",", ":"), allow_nan=False),
        )
        with self._transaction():
            return int(self._fetchone(sql, values)[0])

    def finish_collection_run(self, run_id: int, result: CollectionRun) -> None:
        sql = """
            UPDATE collection_runs
            SET finished_at = %s, status = %s, records_found = %s, records_new = %s,
                records_updated = %s, records_missing = %s, error_message = %s, metrics_json = %s
            WHERE id = %s
            RETURNING id
        """
        values = (
            result.finished_at, result.status.value, result.records_found, result.records_new,
            result.records_updated, result.records_missing, result.error_message,
            json.dumps(result.metrics, ensure_ascii=False, separators=(",", ":"), allow_nan=False), run_id,
        )
        with self._transaction():
            if self._fetchone(sql, values) is None:
                raise KeyError(f"collection_run {run_id} não encontrado")

    def get_collection_run(self, run_id: int) -> CollectionRun | None:
        cursor = self.connection.cursor()
        try:
            cursor.execute(
                """SELECT id, source, started_at, finished_at, status, records_found, records_new,
                          records_updated, records_missing, error_message, metrics_json
                   FROM collection_runs WHERE id = %s""",
                (run_id,),
            )
            row = cursor.fetchone()
        finally:
            cursor.close()
        if row is None:
            return None
        return _collection_run_from_row(row)

    def _fetchone(self, sql: str, values: tuple[Any, ...]) -> Any:
        cursor = self.connection.cursor()
        try:
            cursor.execute(sql, values)
            return cursor.fetchone()
        finally:
            cursor.close()

    def _execute(self, sql: str, values: tuple[Any, ...]) -> None:
        cursor = self.connection.cursor()
        try:
            cursor.execute(sql, values)
        finally:
            cursor.close()


def _parse_datetime(value: datetime | str) -> datetime:
    parsed = datetime.fromisoformat(value) if isinstance(value, str) else value
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("o banco retornou um timestamp sem fuso horário")
    return parsed


def _collection_run_from_row(row: Any) -> CollectionRun:
    metrics = row[10] if isinstance(row[10], dict) else json.loads(row[10] or "{}")
    return CollectionRun(
        id=int(row[0]),
        source=row[1],
        started_at=_parse_datetime(row[2]),
        finished_at=_parse_datetime(row[3]) if row[3] is not None else None,
        status=CollectionStatus(row[4]),
        records_found=int(row[5]),
        records_new=int(row[6]),
        records_updated=int(row[7]),
        records_missing=int(row[8]),
        error_message=row[9],
        metrics=metrics,
    )
