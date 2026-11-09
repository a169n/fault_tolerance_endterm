"""S5 idempotent payments: the client's Idempotency-Key is honoured only with FT on."""
from __future__ import annotations

import uuid

from app.fault_tolerance.software.idempotency import forward_key, payment_key

KEY = "client-key-123"


def test_payment_key_ignored_in_baseline() -> None:
    first = payment_key({"idempotency-key": KEY})
    second = payment_key({"idempotency-key": KEY})
    assert first != KEY
    assert first != second  # every retry is a new charge in baseline
    uuid.UUID(first)


def test_payment_key_from_header_in_ft(ft: None) -> None:
    assert payment_key({"idempotency-key": KEY}) == KEY


def test_payment_key_generated_when_missing_in_ft(ft: None) -> None:
    uuid.UUID(payment_key({}))


def test_forward_key_reuses_client_key() -> None:
    assert forward_key({"idempotency-key": KEY}) == KEY
    uuid.UUID(forward_key({}))
