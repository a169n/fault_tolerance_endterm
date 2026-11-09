"""S7 graceful degradation: last good read served as 203 while it is fresh enough."""
from __future__ import annotations

import json

import pytest

from app.fault_tolerance.software import degradation
from app.fault_tolerance.software.degradation import StaleCache


class Clock:
    def __init__(self, t: float = 1_000_000.0) -> None:
        self.t = t

    def time(self) -> float:
        return self.t


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> Clock:
    fake = Clock()
    monkeypatch.setattr(degradation, "time", fake)
    return fake


def test_stale_cache_serves_203_within_max_age(ft: None, clock: Clock) -> None:
    cache = StaleCache()
    cache.remember("students/s1", {"id": "s1"})
    clock.t += 10  # 10 s later
    response = cache.fallback("students/s1", "student")
    assert response is not None
    assert response.status_code == 203
    body = json.loads(response.body)
    assert body == {"degraded": True, "staleAgeMs": 10_000, "data": {"id": "s1"}}


def test_stale_cache_disabled_in_baseline(clock: Clock) -> None:
    cache = StaleCache()
    cache.remember("students/s1", {"id": "s1"})
    assert cache.fallback("students/s1", "student") is None


def test_stale_cache_expires(ft: None, clock: Clock) -> None:
    cache = StaleCache()
    cache.remember("students/s1", {"id": "s1"})
    clock.t += degradation.STALE_MAX_MS / 1000
    assert cache.fallback("students/s1", "student") is None


def test_stale_cache_miss(ft: None, clock: Clock) -> None:
    assert StaleCache().fallback("students/nobody", "student") is None
