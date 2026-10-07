from __future__ import annotations

import argparse
import json
import os
import tempfile
from pathlib import Path
from typing import Any

from .aggregate import PublicDataset, build_public_dataset
from .database import PostgresDatabase


PUBLIC_FILENAMES = {
    "current": "current.json",
    "neighborhood_daily": "neighborhood_daily.json",
    "listing_events": "listing_events.json",
    "meta": "meta.json",
}


def _serialize(payload: Any) -> str:
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n"
    json.loads(text)
    return text


def export_dataset(dataset: PublicDataset, output_dir: str | Path) -> dict[str, Path]:
    """Validate all payloads, stage them, then atomically replace each public file."""
    if (not isinstance(dataset.current, list) or not isinstance(dataset.neighborhood_daily, list)
            or not isinstance(dataset.listing_events, list)):
        raise ValueError("current, neighborhood_daily e listing_events precisam ser listas JSON")
    if not isinstance(dataset.meta, dict):
        raise ValueError("meta precisa ser um objeto JSON")

    payloads = {
        PUBLIC_FILENAMES["current"]: _serialize(dataset.current),
        PUBLIC_FILENAMES["neighborhood_daily"]: _serialize(dataset.neighborhood_daily),
        PUBLIC_FILENAMES["listing_events"]: _serialize(dataset.listing_events),
        PUBLIC_FILENAMES["meta"]: _serialize(dataset.meta),
    }
    directory = Path(output_dir)
    directory.mkdir(parents=True, exist_ok=True)
    staged: dict[Path, Path] = {}
    try:
        for filename, contents in payloads.items():
            descriptor, temporary_name = tempfile.mkstemp(
                prefix=f".{filename}.", suffix=".tmp", dir=directory
            )
            temporary = Path(temporary_name)
            staged[directory / filename] = temporary
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(contents)
                handle.flush()
                os.fsync(handle.fileno())
        for destination, temporary in staged.items():
            os.replace(temporary, destination)
    finally:
        for temporary in staged.values():
            temporary.unlink(missing_ok=True)
    return {key: directory / filename for key, filename in PUBLIC_FILENAMES.items()}


def export_from_database(database: PostgresDatabase, output_dir: str | Path) -> PublicDataset:
    dataset = build_public_dataset(database.list_public_history(), database.list_collection_runs())
    export_dataset(dataset, output_dir)
    return dataset


def main() -> None:
    parser = argparse.ArgumentParser(description="Gera os arquivos JSON públicos do observatório.")
    parser.add_argument("--output-dir", type=Path, default=Path("data/public"))
    args = parser.parse_args()

    with PostgresDatabase.from_env() as database:
        dataset = export_from_database(database, args.output_dir)
    print(
        f"Arquivos públicos atualizados em {args.output_dir}: "
        f"{len(dataset.current)} anúncios ativos, "
        f"{len(dataset.neighborhood_daily)} linhas de bairro/dia e "
        f"{len(dataset.listing_events)} eventos."
    )


if __name__ == "__main__":
    main()
