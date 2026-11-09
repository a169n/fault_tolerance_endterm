from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from enum import Enum
from typing import Dict, List, Optional

import httpx
from fastapi import Body, FastAPI, Header, Request
from fastapi.responses import JSONResponse

from ..core.context import HEADER as REQUEST_ID_HEADER
from ..core.context import REQUEST_ID, new_request_id
from ..core.errors import UpstreamError
from ..core.eventlog import endterm_enabled, ft_enabled, log, mode
from ..core.service import create_app
from ..fault_tolerance.infrastructure import load_balancer
from ..fault_tolerance.software import circuit_breaker, health_check, idempotency, outlier_ejection
from ..fault_tolerance.software.degradation import StaleCache
from ..fault_tolerance.software.retry import call


def _urls(value: Optional[str]) -> List[str]:
    return [u for u in (value or "").split(",") if u]


POOLS: Dict[str, List[str]] = {  # replicas, from docker-compose.yml
    "students": _urls(os.environ.get("STUDENT_URLS")),
    "payments": _urls(os.environ.get("PAYMENT_URLS")),
    "transcripts": _urls(os.environ.get("TRANSCRIPT_URLS")),
    "timetables": _urls(os.environ.get("TIMETABLE_URLS")),
}

_client = httpx.AsyncClient(timeout=None)
_last_good = StaleCache()


@asynccontextmanager
async def lifespan(app: FastAPI):
    instances = [i for pool in POOLS.values() for i in pool]
    tasks = [asyncio.create_task(health_check.loop(_client, instances))] if ft_enabled() else []
    if endterm_enabled():
        tasks.append(asyncio.create_task(outlier_ejection.loop(POOLS)))
    yield
    for task in tasks:
        task.cancel()
    await _client.aclose()


app = create_app(with_db=False, lifespan=lifespan)


@app.get("/health/ready")
@app.get("/health")  # alias of /health/ready: the harness reads the mode from here
async def health():
    return {"ok": True, "ft": ft_enabled(), "endterm": endterm_enabled(), "mode": mode(),
            "instances": health_check.snapshot()}


class Pool(str, Enum):
    students = "students"
    payments = "payments"
    transcripts = "transcripts"
    timetables = "timetables"


BODY = Body(None, examples=[{"studentId": "s7", "amount": 100}, {"term": "2026-fall"}])


@app.get("/api/{pool}")
async def get_all(pool: Pool, request: Request):
    return await proxy(pool.value, request, "")


@app.get("/api/{pool}/{path:path}")
async def get_one(pool: Pool, path: str, request: Request):
    return await proxy(pool.value, request, path)


@app.post("/api/{pool}")
async def create(pool: Pool, request: Request, body: Optional[dict] = BODY,
                 idempotency_key: Optional[str] = Header(None)):
    return await proxy(pool.value, request, "")


@app.post("/api/{pool}/{path:path}")
async def create_at(pool: Pool, path: str, request: Request, body: Optional[dict] = BODY,
                    idempotency_key: Optional[str] = Header(None)):
    return await proxy(pool.value, request, path)


def _ejection_outcome(outliers: Optional[outlier_ejection.OutlierDetector]):
    if outliers is None:  # baseline and midterm: no per-instance bookkeeping
        return None
    return lambda instance, outcome: outliers.record(instance, outcome == "ok")  # error|timeout count


def _has_idempotency_key(request: Request) -> bool:
    return bool((request.headers.get("idempotency-key") or "").strip())


async def proxy(pool: str, request: Request, path: str):
    if not POOLS.get(pool):
        return JSONResponse(status_code=404, content={"error": "unknown service"})

    method = request.method
    if pool == "payments" and method == "POST" and endterm_enabled() and not _has_idempotency_key(request):
        # nginx may re-send this POST to the other gateway (redundant.conf). A key made up here would
        # differ per gateway and charge twice, so in endterm only the client may supply it.
        log(kind="rejected", target=pool, reason="missing_idempotency_key")
        return JSONResponse(status_code=400, content={"error": "Idempotency-Key header required"})
    body = await request.body()
    target_path = f"/{path}" if path else "/"
    query = request.url.query

    outliers = outlier_ejection.for_pool(pool, POOLS[pool]) if endterm_enabled() else None
    ring = load_balancer.ring(pool, POOLS[pool], health_check.is_up,  # H1 + S4 (+ ejection in endterm)
                              is_ejected=outliers.is_ejected if outliers else lambda i: False)
    idem = idempotency.forward_key(request.headers)                    # S5
    rid = REQUEST_ID.get() or new_request_id()  # set by the middleware; every attempt reuses it
    chosen = {"instance": ring[0], "i": 0}

    async def attempt(timeout: Optional[float]):
        instance = ring[chosen["i"] % len(ring)]  # next replica per attempt
        chosen["i"] += 1
        chosen["instance"] = instance
        url = f"{instance}{target_path}" + (f"?{query}" if query else "")
        try:
            response = await _client.request(
                method, url, content=body or None,
                headers={"content-type": "application/json", "idempotency-key": idem,
                         REQUEST_ID_HEADER: rid},
                timeout=timeout,
            )
        except Exception as exc:
            raise UpstreamError(str(exc), 0) from exc
        if response.status_code >= 500:
            raise UpstreamError(f"upstream {response.status_code}", response.status_code)
        try:
            return response.status_code, response.json()
        except Exception:
            return response.status_code, None

    try:
        (status, payload), attempts = await call(pool, attempt, circuit_breaker.for_pool(pool),  # S1 S2 S3
                                                instance=lambda: chosen["instance"],
                                                on_outcome=_ejection_outcome(outliers))
        log(kind="route", target=pool, instance=chosen["instance"], ok=True, attempts=attempts)  # which replica answered
        if attempts > 1:
            log(kind="recovery", target=pool, action="retry_succeeded", attempts=attempts)
        if method == "GET":
            _last_good.remember(target_path, payload)
        return JSONResponse(status_code=status, content=payload)
    except Exception as exc:
        stale = _last_good.fallback(target_path, pool) if method == "GET" else None   # S7
        if stale is not None:
            return stale
        status = exc.status if isinstance(exc, UpstreamError) and exc.status >= 400 else 503
        return JSONResponse(status_code=status, content={"error": str(exc)})
