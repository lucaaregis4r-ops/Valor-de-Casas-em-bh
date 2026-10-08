from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from .ingest import PreparedCollection


class CollectionValidationError(RuntimeError):
    """Raised when a source batch is unsafe to add to the daily history."""


@dataclass(frozen=True, slots=True)
class CollectionValidationPolicy:
    min_records: int = 1
    max_drop_percent: float = 70.0
    max_invalid_fraction: float = 0.05
    max_page_failure_fraction: float = 0.0
    min_parse_success_fraction: float = 0.8
    min_monthly_rent: Decimal = Decimal("100")
    max_monthly_rent: Decimal = Decimal("100000")
    max_duration_seconds: float = 14400.0
    allow_truncated_initial: bool = False

    def __post_init__(self) -> None:
        if self.min_records < 0:
            raise ValueError("min_records não pode ser negativo")
        if not 0 <= self.max_drop_percent < 100:
            raise ValueError("max_drop_percent precisa estar entre 0 e 100")
        if not 0 <= self.max_invalid_fraction < 1:
            raise ValueError("max_invalid_fraction precisa estar entre 0 e 1")
        if not 0 <= self.max_page_failure_fraction < 1:
            raise ValueError("max_page_failure_fraction precisa estar entre 0 e 1")
        if not 0 <= self.min_parse_success_fraction <= 1:
            raise ValueError("min_parse_success_fraction precisa estar entre 0 e 1")
        if self.min_monthly_rent < 0 or self.max_monthly_rent <= self.min_monthly_rent:
            raise ValueError("faixa de aluguel mensal inválida")
        if self.max_duration_seconds <= 0:
            raise ValueError("max_duration_seconds precisa ser positivo")


def validate_prepared_collection(
    prepared: PreparedCollection,
    *,
    previous_success_count: int | None,
    elapsed_seconds: float,
    policy: CollectionValidationPolicy,
) -> None:
    """Reject incomplete or implausible snapshots before any listing is written."""
    count = len(prepared.snapshots)
    truncated_initial_allowed = policy.allow_truncated_initial and previous_success_count is None
    if prepared.metrics.get("truncated") and not truncated_initial_allowed:
        candidates = prepared.metrics.get("candidate_pages", "?")
        attempted = prepared.metrics.get("pages_attempted", "?")
        raise CollectionValidationError(
            f"coleta incompleta: existem {candidates} páginas candidatas e apenas {attempted} foram tentadas"
        )
    if elapsed_seconds > policy.max_duration_seconds:
        raise CollectionValidationError(
            f"duração excedeu o limite de {policy.max_duration_seconds:.0f}s"
        )
    if count < policy.min_records:
        raise CollectionValidationError(
            f"foram encontrados {count} anúncios; mínimo configurado: {policy.min_records}"
        )
    if prepared.records_received and (
        prepared.normalization_error_count / prepared.records_received > policy.max_invalid_fraction
    ):
        samples = "; ".join(prepared.normalization_errors)
        raise CollectionValidationError(
            f"{prepared.normalization_error_count}/{prepared.records_received} registros não normalizaram "
            f"(limite {policy.max_invalid_fraction:.0%}). Exemplos: {samples}"
        )

    attempted = int(prepared.metrics.get("pages_attempted", 0) or 0)
    not_found = int(prepared.metrics.get("pages_not_found", 0) or 0)
    page_failures = int(prepared.metrics.get("pages_failed", 0) or 0)
    fetchable_attempts = max(0, attempted - not_found)
    if fetchable_attempts:
        failure_fraction = page_failures / fetchable_attempts
        if failure_fraction > policy.max_page_failure_fraction:
            raise CollectionValidationError(
                f"falhas parciais em {failure_fraction:.1%} das páginas de anúncios "
                f"(limite: {policy.max_page_failure_fraction:.1%})"
            )
    parsed = prepared.metrics.get("records_parsed")
    successful_pages = max(0, fetchable_attempts - page_failures)
    if parsed is not None and successful_pages:
        parse_fraction = int(parsed) / successful_pages
        if parse_fraction < policy.min_parse_success_fraction:
            raise CollectionValidationError(
                f"apenas {parse_fraction:.1%} das páginas tentadas geraram anúncio normalizado; "
                f"mínimo: {policy.min_parse_success_fraction:.1%}"
            )

    missing_location = sum(
        not listing.city or not listing.neighborhood for listing, _ in prepared.snapshots
    )
    if count and missing_location / count > policy.max_invalid_fraction:
        raise CollectionValidationError(
            f"{missing_location}/{count} anúncios estão sem cidade ou bairro "
            f"(limite {policy.max_invalid_fraction:.0%})"
        )

    for listing, observation in prepared.snapshots:
        price = observation.rent_price
        if price is None or not policy.min_monthly_rent <= price <= policy.max_monthly_rent:
            identifier = listing.source_listing_id or listing.canonical_url or listing.identity_key
            raise CollectionValidationError(
                f"aluguel fora da faixa plausível para {identifier}: {price} "
                f"(esperado entre {policy.min_monthly_rent} e {policy.max_monthly_rent})"
            )

    if previous_success_count and previous_success_count > 0:
        minimum_after_drop = previous_success_count * (1 - policy.max_drop_percent / 100)
        if count < minimum_after_drop:
            actual_drop = (1 - count / previous_success_count) * 100
            raise CollectionValidationError(
                f"queda de {actual_drop:.1f}% frente à última coleta válida "
                f"({count} contra {previous_success_count}); limite: {policy.max_drop_percent:.1f}%"
            )
