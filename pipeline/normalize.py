from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any

from .models import Listing, Observation


def _decimal(value: Any, field: str, *, required: bool = False) -> Decimal | None:
    if value is None or value == "":
        if required:
            raise ValueError(f"campo obrigatório ausente: {field}")
        return None
    if isinstance(value, Decimal):
        result = value
    elif isinstance(value, (int, float)):
        result = Decimal(str(value))
    else:
        text = str(value).strip().replace("R$", "").replace(" ", "")
        if "," in text:
            text = text.replace(".", "").replace(",", ".")
        try:
            result = Decimal(text)
        except InvalidOperation as error:
            raise ValueError(f"campo {field} não é numérico: {value!r}") from error
    if not result.is_finite() or result < 0:
        raise ValueError(f"campo {field} precisa ser finito e não negativo")
    return result


def _measure(value: Any, field: str) -> Decimal | None:
    if value is None or value == "":
        return None
    if isinstance(value, str) and "-" in value:
        pieces = [piece.strip() for piece in value.split("-")]
        if len(pieces) == 2:
            first, second = (_decimal(piece, field) for piece in pieces)
            if first is not None and second is not None:
                return (first + second) / 2
    return _decimal(value, field)


def _coordinate(value: Any, field: str) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"campo {field} não é uma coordenada válida") from error


def _datetime(value: Any, fallback: datetime) -> datetime:
    if value is None or value == "":
        return fallback
    parsed = value if isinstance(value, datetime) else datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("collected_at precisa incluir fuso horário")
    return parsed


def normalize_quintoandar_item(
    item: dict[str, Any], observed_at: datetime | None = None
) -> tuple[Listing, Observation]:
    """Convert the legacy QuintoAndar row format to canonical pipeline models."""
    timestamp = _datetime(observed_at, datetime.now(timezone.utc))
    rent = _decimal(item.get("price"), "price", required=True)
    if rent <= 0:
        raise ValueError("price precisa ser maior que zero")
    condo = _decimal(item.get("adm-fees"), "adm-fees")
    iptu = _decimal(item.get("iptu"), "iptu")
    area = _measure(item.get("square-foot"), "square-foot")
    bedrooms = _measure(item.get("rooms"), "rooms")
    bathrooms = _measure(item.get("bathrooms"), "bathrooms")
    parking = _measure(item.get("garage-places"), "garage-places")
    total = rent + (condo or Decimal(0)) + (iptu or Decimal(0))
    price_m2 = rent / area if area and area > 0 else None

    listing = Listing(
        source=item.get("source") or "quintoandar",
        source_listing_id=item.get("listing_id") or None,
        canonical_url=item.get("url") or None,
        title=item.get("title") or None,
        property_type=item.get("property_type") or None,
        address=item.get("address") or None,
        neighborhood=item.get("neighborhood") or None,
        city=item.get("city") or None,
        latitude=_coordinate(item.get("latitude"), "latitude"),
        longitude=_coordinate(item.get("longitude"), "longitude"),
        area_m2=area,
        bedrooms=bedrooms,
        bathrooms=bathrooms,
        parking_spaces=parking,
    )
    observation = Observation(
        observed_at=timestamp,
        rent_price=rent,
        condo_fee=condo,
        iptu=iptu,
        total_price=total,
        price_m2=price_m2,
    )
    return listing, observation
