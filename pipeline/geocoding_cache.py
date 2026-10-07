from __future__ import annotations

import json
import math
import os
import re
import tempfile
import unicodedata
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from statistics import median
from typing import Any, Iterable


def _normalized_part(value: Any) -> str:
    text = unicodedata.normalize("NFKD", str(value or "").casefold())
    text = "".join(character for character in text if not unicodedata.combining(character))
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", text)).strip()


def _key(city: Any, neighborhood: Any) -> str | None:
    normalized_city = _normalized_part(city)
    normalized_neighborhood = _normalized_part(neighborhood)
    if not normalized_city or not normalized_neighborhood:
        return None
    return f"{normalized_city}|{normalized_neighborhood}"


def _valid_coordinates(latitude: Any, longitude: Any) -> bool:
    try:
        lat = float(latitude)
        lon = float(longitude)
    except (TypeError, ValueError):
        return False
    return math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180


class NeighborhoodGeocodingCache:
    """Persist source-supplied neighborhood centers for missing-coordinate fallback."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.entries: dict[str, dict[str, Any]] = {}
        self.load_warning: str | None = None
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(payload, dict) or payload.get("schema_version") != 1:
                raise ValueError("versão/formato incompatível")
            raw_entries = payload.get("entries", {})
            if not isinstance(raw_entries, dict):
                raise ValueError("entries precisa ser um objeto")
            for key, entry in raw_entries.items():
                if not isinstance(key, str) or not isinstance(entry, dict):
                    continue
                if not _valid_coordinates(entry.get("lat"), entry.get("lon")):
                    continue
                lat, lon = float(entry["lat"]), float(entry["lon"])
                normalized_key = _key(entry.get("city"), entry.get("neighborhood"))
                if normalized_key != key:
                    continue
                self.entries[key] = {
                    "city": str(entry["city"]),
                    "neighborhood": str(entry["neighborhood"]),
                    "lat": round(lat, 7),
                    "lon": round(lon, 7),
                    "samples": max(1, int(entry.get("samples", 1))),
                    "updated_at": str(entry.get("updated_at") or ""),
                    "precision": "neighborhood",
                }
        except (OSError, json.JSONDecodeError, TypeError, ValueError) as error:
            self.load_warning = f"{type(error).__name__}: {error}"
            self.entries = {}

    def lookup(self, city: str | None, neighborhood: str | None) -> tuple[float, float] | None:
        key = _key(city, neighborhood)
        entry = self.entries.get(key) if key else None
        if entry is None:
            return None
        return float(entry["lat"]), float(entry["lon"])

    def update_from(
        self,
        source_points: Iterable[dict[str, Any]],
        *,
        updated_at: datetime | None = None,
    ) -> int:
        grouped: dict[str, list[tuple[float, float]]] = defaultdict(list)
        labels: dict[str, tuple[str, str]] = {}
        for point in source_points:
            city, neighborhood = point.get("city"), point.get("neighborhood")
            key = _key(city, neighborhood)
            latitude, longitude = point.get("latitude"), point.get("longitude")
            if not key or not _valid_coordinates(latitude, longitude):
                continue
            grouped[key].append((float(latitude), float(longitude)))
            labels[key] = (str(city).strip(), str(neighborhood).strip())

        timestamp = (updated_at or datetime.now(timezone.utc)).isoformat(timespec="seconds")
        for key, coordinates in grouped.items():
            city, neighborhood = labels[key]
            self.entries[key] = {
                "city": city,
                "neighborhood": neighborhood,
                "lat": round(median([point[0] for point in coordinates]), 7),
                "lon": round(median([point[1] for point in coordinates]), 7),
                "samples": len(coordinates),
                "updated_at": timestamp,
                "precision": "neighborhood",
            }
        return len(grouped)

    def save(self) -> None:
        payload = {"schema_version": 1, "entries": dict(sorted(self.entries.items()))}
        serialized = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{self.path.name}.", suffix=".tmp", dir=self.path.parent
        )
        temporary = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(serialized)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
        finally:
            temporary.unlink(missing_ok=True)
