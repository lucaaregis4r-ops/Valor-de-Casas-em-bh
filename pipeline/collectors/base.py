from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime
from typing import Any

from ..models import Listing, Observation


class Collector(ABC):
    """Interface shared by source collectors."""

    source: str

    @property
    def metrics(self) -> dict[str, Any]:
        """Optional run metrics that help validate source completeness."""
        return {}

    @abstractmethod
    def collect(self) -> list[dict[str, Any]]:
        """Fetch available raw records from the public source."""

    @abstractmethod
    def normalize(
        self, item: dict[str, Any], observed_at: datetime
    ) -> tuple[Listing, Observation]:
        """Map a raw source record to the canonical listing and price snapshot."""
