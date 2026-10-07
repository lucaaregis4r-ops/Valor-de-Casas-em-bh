from __future__ import annotations

from collections.abc import Iterable, Iterator

from .models import Listing, Observation


def deduplicate_snapshots(
    snapshots: Iterable[tuple[Listing, Observation]],
) -> Iterator[tuple[Listing, Observation]]:
    """Keep the first normalized record for each source-scoped identity in a run."""
    seen: set[tuple[str, str]] = set()
    for listing, observation in snapshots:
        key = (listing.source, listing.identity_key)
        if key in seen:
            continue
        seen.add(key)
        yield listing, observation

