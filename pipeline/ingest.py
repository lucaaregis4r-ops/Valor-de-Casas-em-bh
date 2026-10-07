from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from .collectors.base import Collector
from .database import PostgresDatabase
from .deduplicate import deduplicate_snapshots
from .models import Listing, Observation


@dataclass(frozen=True, slots=True)
class IngestionSummary:
    records_found: int
    records_new: int
    records_updated: int
    records_missing: int = 0


@dataclass(frozen=True, slots=True)
class PreparedCollection:
    source: str
    observed_at: datetime
    records_received: int
    snapshots: tuple[tuple[Listing, Observation], ...]
    normalization_errors: tuple[str, ...]
    normalization_error_count: int
    metrics: dict[str, Any]
    missing_source_listing_ids: tuple[str, ...] = ()


def prepare_collection(
    collector: Collector,
    *,
    observed_at: datetime | None = None,
) -> PreparedCollection:
    """Fetch and normalize a complete batch without changing the database."""
    timestamp = observed_at or datetime.now(timezone.utc)
    raw_records = collector.collect()
    normalized = []
    errors = []
    error_count = 0
    for item in raw_records:
        try:
            normalized.append(collector.normalize(item, timestamp))
        except (ValueError, TypeError, KeyError) as error:
            error_count += 1
            if len(errors) < 5:
                label = item.get("listing_id") or item.get("url") or "registro sem identificador"
                errors.append(f"{label}: {type(error).__name__}: {error}")
    snapshots = tuple(deduplicate_snapshots(normalized))
    return PreparedCollection(
        source=collector.source,
        observed_at=timestamp,
        records_received=len(raw_records),
        snapshots=snapshots,
        normalization_errors=tuple(errors),
        normalization_error_count=error_count,
        metrics=collector.metrics,
        missing_source_listing_ids=tuple(getattr(collector, "missing_source_listing_ids", ())),
    )


def persist_prepared_collection(
    prepared: PreparedCollection,
    database: PostgresDatabase,
) -> IngestionSummary:
    """Persist an already fetched and validated batch."""
    records_new, records_updated, records_missing = database.persist_collection_batch(
        prepared.snapshots,
        source=prepared.source,
        observed_at=prepared.observed_at,
        missing_source_listing_ids=prepared.missing_source_listing_ids,
    )
    return IngestionSummary(len(prepared.snapshots), records_new, records_updated, records_missing)


def ingest_collector(
    collector: Collector,
    database: PostgresDatabase,
    *,
    observed_at: datetime | None = None,
) -> IngestionSummary:
    """Collect, normalize, deduplicate, then persist a source snapshot."""
    prepared = prepare_collection(collector, observed_at=observed_at)
    return persist_prepared_collection(prepared, database)
