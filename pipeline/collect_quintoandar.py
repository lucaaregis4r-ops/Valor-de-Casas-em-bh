from __future__ import annotations

import argparse
import logging
import os
from decimal import Decimal
from pathlib import Path

from .collectors.source_01 import QuintoAndarCollector
from .database import PostgresDatabase
from .geocoding_cache import NeighborhoodGeocodingCache
from .run_collection import run_collection
from .validation import CollectionValidationPolicy


def main() -> None:
    parser = argparse.ArgumentParser(description="Coleta aluguéis públicos do QuintoAndar para BH e RMBH.")
    parser.add_argument("--max-pages", type=int, default=100)
    parser.add_argument("--delay-seconds", type=float, default=1.0)
    parser.add_argument("--limit-sitemaps", type=int)
    parser.add_argument("--min-records", type=int, default=1)
    parser.add_argument("--max-drop-percent", type=float, default=70.0)
    parser.add_argument("--max-invalid-fraction", type=float, default=0.05)
    parser.add_argument("--max-page-failure-fraction", type=float, default=0.0)
    parser.add_argument("--min-parse-success-fraction", type=float, default=0.8)
    parser.add_argument("--min-monthly-rent", type=Decimal, default=Decimal("100"))
    parser.add_argument("--max-monthly-rent", type=Decimal, default=Decimal("100000"))
    parser.add_argument("--max-duration-seconds", type=float, default=7200)
    parser.add_argument(
        "--geocoding-cache",
        type=Path,
        default=Path(os.environ.get("GEOCODING_CACHE_PATH", "data/geocoding_cache.json")),
    )
    args = parser.parse_args()

    geocoding_cache = NeighborhoodGeocodingCache(args.geocoding_cache)
    if geocoding_cache.load_warning:
        logging.warning("Cache de geocodificação ignorado: %s", geocoding_cache.load_warning)
    collector = QuintoAndarCollector(
        max_pages=args.max_pages,
        delay_seconds=args.delay_seconds,
        limit_sitemaps=args.limit_sitemaps,
        max_duration_seconds=args.max_duration_seconds,
        geocoding_cache=geocoding_cache,
    )
    with PostgresDatabase.from_env() as database:
        summary = run_collection(
            collector,
            database,
            policy=CollectionValidationPolicy(
                min_records=args.min_records,
                max_drop_percent=args.max_drop_percent,
                max_invalid_fraction=args.max_invalid_fraction,
                max_page_failure_fraction=args.max_page_failure_fraction,
                min_parse_success_fraction=args.min_parse_success_fraction,
                min_monthly_rent=args.min_monthly_rent,
                max_monthly_rent=args.max_monthly_rent,
                max_duration_seconds=args.max_duration_seconds,
            ),
        )
        cache_entries_updated = geocoding_cache.update_from(collector.source_coordinate_rows)
        if cache_entries_updated:
            try:
                geocoding_cache.save()
            except OSError as error:
                logging.warning("Coleta salva, mas o cache de geocodificação não foi atualizado: %s", error)
    print(
        f"Coleta QuintoAndar concluída: {summary.records_found} registros, "
        f"{summary.records_new} novos, {summary.records_updated} já conhecidos, "
        f"{summary.records_missing} retirados; "
        f"{collector.metrics.get('geocoding_cache_hits', 0)} coordenadas recuperadas do cache."
    )


if __name__ == "__main__":
    main()
