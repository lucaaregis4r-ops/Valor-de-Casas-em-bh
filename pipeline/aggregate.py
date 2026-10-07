from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal
from statistics import mean, median
from typing import Any, Iterable
from zoneinfo import ZoneInfo

from .models import CollectionRun, CollectionStatus


LOCAL_TIMEZONE = ZoneInfo("America/Sao_Paulo")


@dataclass(frozen=True, slots=True)
class PublicDataset:
    current: list[dict[str, Any]]
    neighborhood_daily: list[dict[str, Any]]
    listing_events: list[dict[str, Any]]
    meta: dict[str, Any]


def _datetime(value: datetime | str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00")) if isinstance(value, str) else value
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("data pública exige timestamps com fuso horário")
    return parsed


def _date(value: datetime | str) -> date:
    return _datetime(value).astimezone(LOCAL_TIMEZONE).date()


def _iso(value: datetime | str | None) -> str | None:
    if value is None:
        return None
    return _datetime(value).astimezone(LOCAL_TIMEZONE).isoformat(timespec="seconds")


def _number(value: Any, digits: int = 2) -> float | None:
    if value is None:
        return None
    number = float(value)
    return round(number, digits)


def _percentile(values: Iterable[float], percentile: float) -> float | None:
    ordered = sorted(values)
    if not ordered:
        return None
    position = (len(ordered) - 1) * percentile
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    fraction = position - lower
    return ordered[lower] * (1 - fraction) + ordered[upper] * fraction


def _listing_key(row: dict[str, Any]) -> tuple[str, int]:
    return row["source"], int(row["listing_id"])


def _source_run_key(source: str, started_at: datetime | str) -> tuple[str, datetime]:
    return source, _datetime(started_at)


def _public_listing(
    row: dict[str, Any], first_seen_at: datetime, *, days_listed: int,
    price_history: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "id": f"{row['source']}:{row['listing_id']}",
        "source": row["source"],
        "source_listing_id": row.get("source_listing_id"),
        "title": row.get("title"),
        "operation": "rent",
        "property_type": row.get("property_type"),
        "city": row.get("city"),
        "neighborhood": row.get("neighborhood"),
        "address": row.get("address"),
        "lat": _number(row.get("latitude"), 7),
        "lon": _number(row.get("longitude"), 7),
        "location_precision": row.get("location_precision", "source"),
        "price": _number(row.get("rent_price")),
        "condo_fee": _number(row.get("condo_fee")),
        "iptu": _number(row.get("iptu")),
        "total_price": _number(row.get("total_price")),
        "price_m2": _number(row.get("price_m2")),
        "area": _number(row.get("area_m2")),
        "rooms": _number(row.get("bedrooms"), 1),
        "bathrooms": _number(row.get("bathrooms"), 1),
        "parking_spaces": _number(row.get("parking_spaces"), 1),
        "url": row.get("canonical_url"),
        "first_seen_at": _iso(first_seen_at),
        "last_seen_at": _iso(row["observed_at"]),
        "days_listed": days_listed,
        "available": bool(row["available"]),
        "price_history": price_history,
    }


_PUBLIC_HEALTH_METRICS = (
    "candidate_pages", "pages_attempted", "pages_fetched", "pages_not_found", "pages_failed",
    "pages_unparsed", "records_parsed", "records_received", "records_found", "records_new",
    "records_updated", "records_missing", "duplicate_records_removed", "normalization_error_count",
    "normalization_success_fraction", "page_failure_fraction", "page_parse_success_fraction",
    "duration_seconds", "geocoding_cache_hits", "geocoding_cache_misses",
    "geocoding_cache_load_warning", "truncated",
)


def _public_source_health(
    run: CollectionRun, last_successful_run: CollectionRun | None
) -> dict[str, Any]:
    metrics = run.metrics or {}
    reasons: list[str] = []
    if run.status is CollectionStatus.FAILED:
        reasons.append("última execução falhou")
    elif run.status is CollectionStatus.RUNNING:
        reasons.append("execução em andamento")
    else:
        if int(metrics.get("pages_failed", 0) or 0):
            reasons.append("falhas parciais em páginas")
        if int(metrics.get("normalization_error_count", 0) or 0):
            reasons.append("registros não normalizados")
        if int(metrics.get("geocoding_cache_misses", 0) or 0):
            reasons.append("coordenadas não encontradas no cache")
        if metrics.get("geocoding_cache_load_warning"):
            reasons.append("cache de coordenadas não pôde ser lido")
        parse_fraction = metrics.get("page_parse_success_fraction")
        if parse_fraction is not None and float(parse_fraction) < 0.999:
            reasons.append("leitura parcial das páginas")
    health = (
        "failed" if run.status is CollectionStatus.FAILED else
        "running" if run.status is CollectionStatus.RUNNING else
        "degraded" if reasons else "healthy"
    )
    public_metrics = {key: metrics[key] for key in _PUBLIC_HEALTH_METRICS if key in metrics}
    return {
        "status": run.status.value,
        "health": health,
        "health_reasons": reasons,
        "last_run_at": _iso(run.started_at),
        "last_successful_update": _iso(
            last_successful_run.finished_at or last_successful_run.started_at
        ) if last_successful_run else None,
        "records_found": run.records_found,
        "records_new": run.records_new,
        "records_updated": run.records_updated,
        "records_missing": run.records_missing,
        "failure_type": run.error_message.split(":", 1)[0] if run.error_message else None,
        "metrics": public_metrics,
    }


def _price_history(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep the first observation, each price/fee change, and the latest point."""
    available = [row for row in rows if row["available"]]
    if not available:
        return []
    selected = [available[0]]
    previous = available[0]
    for row in available[1:]:
        if (row.get("rent_price"), row.get("condo_fee"), row.get("total_price")) != (
            previous.get("rent_price"), previous.get("condo_fee"), previous.get("total_price")
        ):
            selected.append(row)
        previous = row
    if selected[-1] is not available[-1]:
        selected.append(available[-1])
    return [
        {
            "observed_at": _iso(row["observed_at"]),
            "price": _number(row.get("rent_price")),
            "condo_fee": _number(row.get("condo_fee")),
            "total_price": _number(row.get("total_price")),
            "price_m2": _number(row.get("price_m2")),
        }
        for row in selected
    ]


def build_public_dataset(
    history_rows: Iterable[dict[str, Any]],
    collection_runs: Iterable[CollectionRun],
    *,
    generated_at: datetime | None = None,
) -> PublicDataset:
    """Build current listings and daily neighborhood statistics from trusted runs."""
    runs = list(collection_runs)
    successful_runs = [run for run in runs if run.status is CollectionStatus.SUCCESS]
    successful_keys = {_source_run_key(run.source, run.started_at) for run in successful_runs}
    history = [
        dict(row)
        for row in history_rows
        if _source_run_key(row["source"], row["observed_at"]) in successful_keys
    ]
    history.sort(key=lambda row: (_listing_key(row), _datetime(row["observed_at"])))

    history_by_listing: dict[tuple[str, int], list[dict[str, Any]]] = defaultdict(list)
    history_by_run: dict[tuple[str, datetime], list[dict[str, Any]]] = defaultdict(list)
    for row in history:
        history_by_listing[_listing_key(row)].append(row)
        history_by_run[_source_run_key(row["source"], row["observed_at"])].append(row)

    first_successful_seen: dict[tuple[str, int], datetime] = {}
    for key, rows in history_by_listing.items():
        available_rows = [row for row in rows if row["available"]]
        if available_rows:
            first_successful_seen[key] = min(_datetime(row["observed_at"]) for row in available_rows)

    latest_success_by_source: dict[str, CollectionRun] = {}
    latest_run_by_source: dict[str, CollectionRun] = {}
    for run in runs:
        previous = latest_run_by_source.get(run.source)
        if previous is None or (run.started_at, run.id or 0) > (previous.started_at, previous.id or 0):
            latest_run_by_source[run.source] = run
        if run.status is CollectionStatus.SUCCESS:
            previous_success = latest_success_by_source.get(run.source)
            if previous_success is None or (run.started_at, run.id or 0) > (
                previous_success.started_at, previous_success.id or 0
            ):
                latest_success_by_source[run.source] = run

    current_rows: list[dict[str, Any]] = []
    for source, run in latest_success_by_source.items():
        run_key = _source_run_key(source, run.started_at)
        current_rows.extend(
            row for row in history_by_run.get(run_key, ()) if row["available"]
        )
    current_rows.sort(
        key=lambda row: (
            row["source"], row.get("city") or "", row.get("neighborhood") or "", int(row["listing_id"])
        )
    )
    current = [
        _public_listing(
            row,
            first_successful_seen[_listing_key(row)],
            days_listed=max(0, (_date(row["observed_at"]) - _date(first_successful_seen[_listing_key(row)])).days),
            price_history=_price_history(history_by_listing[_listing_key(row)]),
        )
        for row in current_rows
        if _listing_key(row) in first_successful_seen
    ]

    daily_rows: dict[tuple[date, str | None, str | None], dict[str, Any]] = {}

    def daily_bucket(day: date, city: str | None, neighborhood: str | None) -> dict[str, Any]:
        key = (day, city, neighborhood)
        if key not in daily_rows:
            daily_rows[key] = {
                "date": day.isoformat(),
                "city": city,
                "neighborhood": neighborhood,
                "active": 0,
                "new": set(),
                "removed": set(),
                "price_reduced": set(),
                "price_increased": set(),
                "rents": [],
                "prices_m2": [],
                "areas": [],
                "days_active": [],
                "days_to_removal": {},
                "latitudes": [],
                "longitudes": [],
            }
        return daily_rows[key]

    # Daily activity events use every accepted run; sets prevent a manual and
    # scheduled run on the same day from counting the same ad twice.
    events_by_key: dict[tuple[date, str, tuple[str, int]], dict[str, Any]] = {}

    def add_event(row: dict[str, Any], day: date, event_type: str,
                  old_price: Any = None, new_price: Any = None) -> None:
        key = _listing_key(row)
        old_value = float(old_price) if old_price is not None else None
        new_value = float(new_price) if new_price is not None else None
        change_pct = (new_value / old_value - 1) if old_value and new_value is not None else None
        events_by_key[(day, event_type, key)] = {
            "date": day.isoformat(),
            "type": event_type,
            "id": f"{key[0]}:{key[1]}",
            "source": row["source"],
            "source_listing_id": row.get("source_listing_id"),
            "title": row.get("title"),
            "city": row.get("city"),
            "neighborhood": row.get("neighborhood"),
            "lat": _number(row.get("latitude"), 7),
            "lon": _number(row.get("longitude"), 7),
            "location_precision": row.get("location_precision", "source"),
            "url": row.get("canonical_url"),
            "observed_at": _iso(row["observed_at"]),
            "old_price": _number(old_value),
            "new_price": _number(new_value),
            "change_pct": round(change_pct, 6) if change_pct is not None else None,
        }

    for key, rows in history_by_listing.items():
        previous_available: dict[str, Any] | None = None
        first_seen = first_successful_seen.get(key)
        for row in rows:
            day = _date(row["observed_at"])
            bucket = daily_bucket(day, row.get("city"), row.get("neighborhood"))
            if not row["available"]:
                bucket["removed"].add(key)
                if previous_available is not None:
                    add_event(row, day, "removed", previous_available.get("rent_price"), None)
                if first_seen is not None:
                    bucket["days_to_removal"][key] = max(0, (day - _date(first_seen)).days)
                previous_available = None
                continue
            if first_seen is not None and _datetime(row["observed_at"]) == first_seen:
                bucket["new"].add(key)
                add_event(row, day, "new", None, row.get("rent_price"))
            if previous_available is not None:
                old_price = previous_available.get("rent_price")
                new_price = row.get("rent_price")
                if old_price is not None and new_price is not None:
                    if Decimal(str(new_price)) < Decimal(str(old_price)):
                        bucket["price_reduced"].add(key)
                        add_event(row, day, "price_reduced", old_price, new_price)
                    elif Decimal(str(new_price)) > Decimal(str(old_price)):
                        bucket["price_increased"].add(key)
                        add_event(row, day, "price_increased", old_price, new_price)
            previous_available = row

    # For each source and local date, summarize its latest successful snapshot.
    latest_daily_run: dict[tuple[str, date], CollectionRun] = {}
    for run in successful_runs:
        key = (run.source, _date(run.started_at))
        previous = latest_daily_run.get(key)
        if previous is None or (run.started_at, run.id or 0) > (previous.started_at, previous.id or 0):
            latest_daily_run[key] = run

    for (source, day), run in latest_daily_run.items():
        timestamp = _datetime(run.started_at)
        snapshot_rows = [
            row for row in history_by_run.get((source, timestamp), ()) if row["available"]
        ]
        for row in snapshot_rows:
            bucket = daily_bucket(day, row.get("city"), row.get("neighborhood"))
            bucket["active"] += 1
            for field, output in (("rent_price", "rents"), ("price_m2", "prices_m2"), ("area_m2", "areas")):
                value = row.get(field)
                if value is not None:
                    bucket[output].append(float(value))
            if row.get("latitude") is not None:
                bucket["latitudes"].append(float(row["latitude"]))
            if row.get("longitude") is not None:
                bucket["longitudes"].append(float(row["longitude"]))
            first_seen = first_successful_seen.get(_listing_key(row))
            if first_seen is not None:
                bucket["days_active"].append(max(0, (day - _date(first_seen)).days))

    daily: list[dict[str, Any]] = []
    for bucket in daily_rows.values():
        rents = bucket.pop("rents")
        prices_m2 = bucket.pop("prices_m2")
        areas = bucket.pop("areas")
        days_active = bucket.pop("days_active")
        days_to_removal = list(bucket.pop("days_to_removal").values())
        latitudes = bucket.pop("latitudes")
        longitudes = bucket.pop("longitudes")
        row = {
            **bucket,
            "lat": _number(mean(latitudes), 7) if latitudes else None,
            "lon": _number(mean(longitudes), 7) if longitudes else None,
            "new": len(bucket["new"]),
            "removed": len(bucket["removed"]),
            "price_reduced": len(bucket["price_reduced"]),
            "price_increased": len(bucket["price_increased"]),
            "median_rent": _number(median(rents)) if rents else None,
            "median_price_m2": _number(median(prices_m2)) if prices_m2 else None,
            "p25_price_m2": _number(_percentile(prices_m2, 0.25)),
            "p75_price_m2": _number(_percentile(prices_m2, 0.75)),
            "median_area_m2": _number(median(areas)) if areas else None,
            "median_days_active": _number(median(days_active), 1) if days_active else None,
            "median_days_to_removal": _number(median(days_to_removal), 1) if days_to_removal else None,
            "variation_7d": None,
            "variation_30d": None,
        }
        daily.append(row)
    daily.sort(key=lambda row: (row["date"], row.get("city") or "", row.get("neighborhood") or ""))

    daily_lookup = {
        (date.fromisoformat(row["date"]), row.get("city"), row.get("neighborhood")): row
        for row in daily
    }
    for row in daily:
        current_day = date.fromisoformat(row["date"])
        for days, field in ((7, "variation_7d"), (30, "variation_30d")):
            previous = daily_lookup.get(
                (current_day - timedelta(days=days), row.get("city"), row.get("neighborhood"))
            )
            old_median = previous.get("median_price_m2") if previous else None
            current_median = row["median_price_m2"]
            if old_median and current_median is not None:
                row[field] = round((current_median / old_median) - 1, 6)

    latest_runs = list(latest_run_by_source.values())
    source_health = [
        {"source": run.source, **_public_source_health(run, latest_success_by_source.get(run.source))}
        for run in sorted(latest_runs, key=lambda item: item.source)
    ]
    health_counts = {
        state: sum(source["health"] == state for source in source_health)
        for state in ("healthy", "degraded", "failed", "running")
    }
    overall_health = (
        "failed" if health_counts["failed"] else
        "degraded" if health_counts["degraded"] else
        "running" if health_counts["running"] else
        "healthy" if health_counts["healthy"] else "no_data"
    )
    latest_success = max(
        (run for run in successful_runs), key=lambda run: (run.finished_at or run.started_at, run.id or 0),
        default=None,
    )
    generated = _datetime(generated_at or datetime.now(LOCAL_TIMEZONE)).astimezone(LOCAL_TIMEZONE)
    meta = {
        "schema_version": 1,
        "generated_at": generated.isoformat(timespec="seconds"),
        "last_successful_update": _iso(latest_success.finished_at if latest_success else None),
        "active_listings": len(current),
        "sources_ok": sum(run.status is CollectionStatus.SUCCESS for run in latest_runs),
        "sources_failed": sum(run.status is CollectionStatus.FAILED for run in latest_runs),
        "sources_running": sum(run.status is CollectionStatus.RUNNING for run in latest_runs),
        "sources_degraded": health_counts["degraded"],
        "health": {"status": overall_health, "sources": health_counts},
        "sources": source_health,
        "variation_definition": "Variação da mediana dos anúncios observados; a composição da oferta pode mudar.",
    }
    listing_events = sorted(
        events_by_key.values(),
        key=lambda event: (event["date"], event["city"] or "", event["neighborhood"] or "", event["id"], event["type"]),
    )
    return PublicDataset(current=current, neighborhood_daily=daily, listing_events=listing_events, meta=meta)
