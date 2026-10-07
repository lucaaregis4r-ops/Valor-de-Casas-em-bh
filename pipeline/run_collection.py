from __future__ import annotations

import time
from datetime import datetime, timezone

from .collectors.base import Collector
from .database import PostgresDatabase
from .ingest import IngestionSummary, persist_prepared_collection, prepare_collection
from .models import CollectionRun, CollectionStatus
from .validation import CollectionValidationPolicy, validate_prepared_collection


def _run_metrics(collector: Collector, prepared, elapsed_seconds: float) -> dict[str, object]:
    metrics: dict[str, object] = dict(collector.metrics)
    metrics["duration_seconds"] = round(elapsed_seconds, 3)
    attempted = int(metrics.get("pages_attempted", 0) or 0)
    not_found = int(metrics.get("pages_not_found", 0) or 0)
    failed_pages = int(metrics.get("pages_failed", 0) or 0)
    denominator = max(0, attempted - not_found)
    metrics["page_failure_fraction"] = round(failed_pages / denominator, 6) if denominator else None
    fetched_pages = max(0, denominator - failed_pages)
    parsed_pages = metrics.get("records_parsed")
    metrics["page_parse_success_fraction"] = (
        round(int(parsed_pages) / fetched_pages, 6)
        if parsed_pages is not None and fetched_pages else None
    )
    if prepared is not None:
        metrics.update({
            "records_received": prepared.records_received,
            "records_found": len(prepared.snapshots),
            "normalization_error_count": prepared.normalization_error_count,
            "normalization_success_fraction": round(
                1 - prepared.normalization_error_count / prepared.records_received, 6
            ) if prepared.records_received else None,
            "duplicate_records_removed": max(0, prepared.records_received - len(prepared.snapshots)
                                              - prepared.normalization_error_count),
        })
    return metrics


def run_collection(
    collector: Collector,
    database: PostgresDatabase,
    *,
    observed_at: datetime | None = None,
    policy: CollectionValidationPolicy | None = None,
) -> IngestionSummary:
    """Validate one complete source batch before persisting its observations."""
    started_at = observed_at or datetime.now(timezone.utc)
    started_monotonic = time.monotonic()
    validation_policy = policy or CollectionValidationPolicy()
    run_id = database.create_collection_run(
        CollectionRun(source=collector.source, started_at=started_at)
    )
    prepared = None
    try:
        prepared = prepare_collection(collector, observed_at=started_at)
        previous_count = database.latest_successful_record_count(collector.source)
        validate_prepared_collection(
            prepared,
            previous_success_count=previous_count,
            elapsed_seconds=time.monotonic() - started_monotonic,
            policy=validation_policy,
        )
        summary = persist_prepared_collection(prepared, database)
    except Exception as error:
        elapsed = time.monotonic() - started_monotonic
        metrics = _run_metrics(collector, prepared, elapsed)
        database.finish_collection_run(
            run_id,
            CollectionRun(
                source=collector.source,
                started_at=started_at,
                finished_at=datetime.now(timezone.utc),
                status=CollectionStatus.FAILED,
                records_found=(len(prepared.snapshots) if prepared else int(metrics.get("records_parsed", 0) or 0)),
                error_message=f"{type(error).__name__}: {error}"[:4000],
                metrics=metrics,
            ),
        )
        raise

    elapsed = time.monotonic() - started_monotonic
    metrics = _run_metrics(collector, prepared, elapsed)
    metrics["records_new"] = summary.records_new
    metrics["records_updated"] = summary.records_updated
    metrics["records_missing"] = summary.records_missing
    database.finish_collection_run(
        run_id,
        CollectionRun(
            source=collector.source,
            started_at=started_at,
            finished_at=datetime.now(timezone.utc),
            status=CollectionStatus.SUCCESS,
            records_found=summary.records_found,
            records_new=summary.records_new,
            records_updated=summary.records_updated,
            records_missing=summary.records_missing,
            metrics=metrics,
        ),
    )
    return summary
