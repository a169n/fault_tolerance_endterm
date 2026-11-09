from __future__ import annotations

import asyncio
import json
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
from ..security import audit, policy, tokens
from ..security.tokens import Principal


def _urls(value: Optional[str]) -> List[str]:
    return [u for u in (value or "").split(",") if u]


POOLS: Dict[str, List[str]] = {  # replicas, from docker-compose.yml
    "students": _urls(os.environ.get("STUDENT_URLS")),
    "payments": _urls(os.environ.get("PAYMENT_URLS")),
    "transcripts": _urls(os.environ.get("TRANSCRIPT_URLS")),
    "timetables": _urls(os.environ.get("TIMETABLE_URLS")),
    "auth": _urls(os.environ.get("AUTH_URLS")),  # login only; not reachable under /api (not a Pool)
}

_client = httpx.AsyncClient(timeout=None)
_last_good = StaleCache()
audit.precreate()  # every deny reason exported as 0 from start-up, in every mode (ALERTS.md)


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


_LOGIN_DOC = {"requestBody": {"content": {"application/json": {"schema": {
    "type": "object", "required": ["username", "password"],
    "properties": {"username": {"type": "string"}, "password": {"type": "string"}}}}}}}


@app.post("/auth/token", openapi_extra=_LOGIN_DOC)
async def login(request: Request):
    # The raw body is relayed whatever its content type (`curl -d` sends a form type); the auth
    # service parses it. Same retry/breaker path as the API pools. Tokens are verified here at the
    # gateway (Task 9), so an auth-1 outage blocks only new logins, not existing sessions.
    return await proxy("auth", request, "token", public=True)


def _ejection_outcome(outliers: Optional[outlier_ejection.OutlierDetector]):
    if outliers is None:  # baseline and midterm: no per-instance bookkeeping
        return None
    return lambda instance, outcome: outliers.record(instance, outcome == "ok")  # error|timeout count


def _has_idempotency_key(request: Request) -> bool:
    return bool((request.headers.get("idempotency-key") or "").strip())


def _bearer_principal(request: Request) -> Optional[Principal]:
    """None without an Authorization header; raises TokenError for anything but a valid bearer token."""
    header = request.headers.get("authorization")
    if header is None:
        return None
    scheme, _, credential = header.partition(" ")
    credential = credential.strip()
    if scheme.lower() != "bearer" or not credential or " " in credential:
        raise tokens.TokenError("malformed")
    return tokens.verify(credential)


async def _json_body(request: Request) -> Optional[dict]:
    try:
        body = json.loads(await request.body() or b"null")
    except (ValueError, RecursionError):
        return None
    return body if isinstance(body, dict) else None


def _bounded(value: object) -> Optional[str]:
    return value if isinstance(value, str) and len(value) <= 128 else None


def _deny(action: str, principal: Optional[Principal], status: int, reason: str) -> JSONResponse:
    audit.record(action, "deny", principal, reason, status=status)
    if status == 401:
        challenge = 'Bearer realm="ftu-api"'
        if reason != "missing_token":
            challenge += ', error="invalid_token"'
        return JSONResponse(status_code=401, content={"error": "unauthorized"},
                            headers={"www-authenticate": challenge})
    return JSONResponse(status_code=403, content={"error": "forbidden"})


async def _enforce(pool: str, request: Request, path: str) -> Optional[JSONResponse]:
    """The policy enforcement point (endterm only): None to proceed, or the 401/403 to return.

    Fails closed: an exception while verifying the token is a 401, one while deciding a 403.
    The Authorization header is never forwarded upstream and never logged (``proxy`` sends
    only content-type, idempotency-key and x-request-id).
    """
    method = request.method
    action = policy.route_template(method, pool, path)
    try:
        principal = _bearer_principal(request)
    except tokens.TokenError as exc:
        return _deny(action, None, 401, exc.reason)
    except Exception:
        return _deny(action, None, 401, "malformed")

    body = await _json_body(request) if method == "POST" else None
    try:
        decision = policy.authorize(principal, method, pool, path, body)
        allowed, status, reason = bool(decision.allowed), int(decision.status), str(decision.reason)
    except Exception:
        allowed, status, reason = False, 401 if principal is None else 403, "policy_error"
    if not allowed or status != 200:
        return _deny(action, principal, status if status in (401, 403) else 403, reason)

    if pool == "payments" and method == "POST":  # who paid for whom, under which key (non-repudiation)
        audit.record(action, "allow", principal, reason, student=_bounded((body or {}).get("studentId")),
                     idempotency_key=_bounded(request.headers.get("idempotency-key")))
    elif principal is not None and principal.role == "admin":
        audit.record(action, "allow", principal, reason)
    return None


async def proxy(pool: str, request: Request, path: str, public: bool = False):
    if not public and endterm_enabled():  # baseline and midterm stay open, for the comparison
        denied = await _enforce(pool, request, path)
        if denied is not None:
            return denied
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
    # S7 key: the policy decides on (pool, path), so a stale payload may only answer the same pair.
    # A path-only key would let an allowed GET /api/timetables/s8 return s8's cached transcript.
    stale_key = f"{pool}{target_path}"

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
            _last_good.remember(stale_key, payload)
        return JSONResponse(status_code=status, content=payload)
    except Exception as exc:
        stale = _last_good.fallback(stale_key, pool) if method == "GET" else None   # S7
        if stale is not None:
            return stale
        status = exc.status if isinstance(exc, UpstreamError) and exc.status >= 400 else 503
        return JSONResponse(status_code=status, content={"error": str(exc)})
