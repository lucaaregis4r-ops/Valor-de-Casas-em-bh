from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal, InvalidOperation
from enum import Enum
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


_TRACKING_QUERY_KEYS = {
    "fbclid",
    "gclid",
    "dclid",
    "mc_cid",
    "mc_eid",
    "ref",
    "referrer",
}
_STABLE_HASH_FIELDS = (
    "title",
    "address",
    "neighborhood",
    "city",
    "area_m2",
    "bedrooms",
    "bathrooms",
    "parking_spaces",
)
_PHYSICAL_FIELDS = ("area_m2", "bedrooms", "bathrooms", "parking_spaces")


def _clean_text(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = re.sub(r"\s+", " ", str(value)).strip()
    return cleaned or None


def _as_decimal(value: Decimal | int | float | str | None, field_name: str) -> Decimal | None:
    if value is None or value == "":
        return None
    try:
        result = value if isinstance(value, Decimal) else Decimal(str(value))
    except (InvalidOperation, ValueError) as error:
        raise ValueError(f"{field_name} precisa ser numérico") from error
    if not result.is_finite() or result < 0:
        raise ValueError(f"{field_name} precisa ser um número finito não negativo")
    return result


def _require_aware_datetime(value: datetime, field_name: str) -> None:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{field_name} precisa incluir fuso horário")


def normalize_url(url: str | None) -> str | None:
    """Normalize a listing URL, removing fragments and common tracking parameters."""
    cleaned = _clean_text(url)
    if cleaned is None:
        return None

    parts = urlsplit(cleaned)
    scheme = parts.scheme.lower()
    hostname = (parts.hostname or "").lower()
    if scheme not in {"http", "https"} or not hostname:
        raise ValueError("canonical_url precisa ser uma URL HTTP ou HTTPS absoluta")

    port = parts.port
    default_port = (scheme == "http" and port == 80) or (scheme == "https" and port == 443)
    host = f"[{hostname}]" if ":" in hostname else hostname
    netloc = host if port is None or default_port else f"{host}:{port}"

    path = re.sub(r"/{2,}", "/", parts.path or "/")
    if path != "/":
        path = path.rstrip("/")

    query_items = [
        (key, value)
        for key, value in parse_qsl(parts.query, keep_blank_values=True)
        if not key.lower().startswith("utm_") and key.lower() not in _TRACKING_QUERY_KEYS
    ]
    query = urlencode(sorted(query_items))
    return urlunsplit((scheme, netloc, path, query, ""))


@dataclass(frozen=True, slots=True)
class Listing:
    source: str
    source_listing_id: str | None = None
    canonical_url: str | None = None
    title: str | None = None
    property_type: str | None = None
    address: str | None = None
    neighborhood: str | None = None
    city: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    location_precision: str = "source"
    area_m2: Decimal | int | float | str | None = None
    bedrooms: Decimal | int | float | str | None = None
    bathrooms: Decimal | int | float | str | None = None
    parking_spaces: Decimal | int | float | str | None = None

    def __post_init__(self) -> None:
        source = _clean_text(self.source)
        if source is None:
            raise ValueError("source é obrigatório")
        object.__setattr__(self, "source", source)
        object.__setattr__(self, "source_listing_id", _clean_text(self.source_listing_id))
        object.__setattr__(self, "canonical_url", normalize_url(self.canonical_url))

        for field_name in ("title", "property_type", "address", "neighborhood", "city"):
            object.__setattr__(self, field_name, _clean_text(getattr(self, field_name)))
        for field_name in ("area_m2", "bedrooms", "bathrooms", "parking_spaces"):
            object.__setattr__(self, field_name, _as_decimal(getattr(self, field_name), field_name))

        for field_name, lower, upper in (("latitude", -90, 90), ("longitude", -180, 180)):
            value = getattr(self, field_name)
            if value is not None and not lower <= float(value) <= upper:
                raise ValueError(f"{field_name} fora do intervalo permitido")
            if value is not None:
                object.__setattr__(self, field_name, float(value))
        precision = _clean_text(self.location_precision) or "source"
        if precision not in {"source", "neighborhood"}:
            raise ValueError("location_precision precisa ser source ou neighborhood")
        object.__setattr__(self, "location_precision", precision)

    @property
    def identity_key(self) -> str:
        """Return the stable key used for source-scoped deduplication."""
        if self.source_listing_id:
            return f"source_id:{self.source_listing_id}"
        if self.canonical_url:
            return f"url:{self.canonical_url}"
        return f"stable_hash:{self._stable_hash()}"

    def _stable_hash(self) -> str:
        has_anchor = bool(self.title or self.address)
        has_physical_detail = any(getattr(self, field) is not None for field in _PHYSICAL_FIELDS)
        if not has_anchor or not has_physical_detail:
            raise ValueError(
                "sem ID de origem ou URL, a identidade precisa combinar título/endereço "
                "com ao menos uma característica física"
            )

        values: dict[str, str | None] = {}
        for field_name in _STABLE_HASH_FIELDS:
            value = getattr(self, field_name)
            if value is None:
                values[field_name] = None
            elif isinstance(value, Decimal):
                values[field_name] = format(value.normalize(), "f")
            else:
                values[field_name] = re.sub(r"\s+", " ", str(value)).casefold()
        serialized = json.dumps(values, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class Observation:
    observed_at: datetime
    rent_price: Decimal | int | float | str | None = None
    condo_fee: Decimal | int | float | str | None = None
    iptu: Decimal | int | float | str | None = None
    total_price: Decimal | int | float | str | None = None
    price_m2: Decimal | int | float | str | None = None
    available: bool = True
    listing_id: int | None = None
    id: int | None = None

    def __post_init__(self) -> None:
        _require_aware_datetime(self.observed_at, "observed_at")
        for field_name in ("rent_price", "condo_fee", "iptu", "total_price", "price_m2"):
            object.__setattr__(self, field_name, _as_decimal(getattr(self, field_name), field_name))
        if not isinstance(self.available, bool):
            raise ValueError("available precisa ser booleano")
        if not self.available and any(
            getattr(self, field_name) is not None
            for field_name in ("rent_price", "condo_fee", "iptu", "total_price", "price_m2")
        ):
            raise ValueError("observação indisponível não pode conter valores de preço")


class CollectionStatus(str, Enum):
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class CollectionRun:
    source: str
    started_at: datetime
    finished_at: datetime | None = None
    status: CollectionStatus = CollectionStatus.RUNNING
    records_found: int = 0
    records_new: int = 0
    records_updated: int = 0
    records_missing: int = 0
    error_message: str | None = None
    metrics: dict[str, Any] = field(default_factory=dict)
    id: int | None = None

    def __post_init__(self) -> None:
        source = _clean_text(self.source)
        if source is None:
            raise ValueError("source é obrigatório")
        object.__setattr__(self, "source", source)
        _require_aware_datetime(self.started_at, "started_at")
        if self.finished_at is not None:
            _require_aware_datetime(self.finished_at, "finished_at")
        if not isinstance(self.status, CollectionStatus):
            object.__setattr__(self, "status", CollectionStatus(self.status))
        for field_name in ("records_found", "records_new", "records_updated", "records_missing"):
            value = getattr(self, field_name)
            if not isinstance(value, int) or value < 0:
                raise ValueError(f"{field_name} precisa ser inteiro não negativo")
        object.__setattr__(self, "error_message", _clean_text(self.error_message))
        if not isinstance(self.metrics, dict):
            raise ValueError("metrics precisa ser um objeto")
        object.__setattr__(self, "metrics", dict(self.metrics))
