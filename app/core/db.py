from __future__ import annotations

import asyncio
import datetime as _dt
import decimal
import os
from typing import Any, Dict, List, Optional, Sequence

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from ..fault_tolerance.infrastructure import db_failover
from ..fault_tolerance.software import timeouts
from .errors import UpstreamError
from .eventlog import log

Row = Dict[str, Any]

_primary = AsyncConnectionPool(
    os.environ["DATABASE_URL"], min_size=1, max_size=10, timeout=timeouts.DB_ACQUIRE_S, open=False
)
_replica = (
    AsyncConnectionPool(
        os.environ["DATABASE_REPLICA_URL"], min_size=1, max_size=5, timeout=timeouts.DB_ACQUIRE_S, open=False
    )
    if os.environ.get("DATABASE_REPLICA_URL")
    else None
)


async def open_pools() -> None:
    await _primary.open(wait=False)  # start even if the DB is down
    if _replica is not None:
        await _replica.open(wait=False)


async def close_pools() -> None:
    await _primary.close()
    if _replica is not None:
        await _replica.close()


def to_jsonable(value: Any) -> Any:
    if isinstance(value, decimal.Decimal):
        return float(value)
    if isinstance(value, (_dt.datetime, _dt.date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: to_jsonable(v) for k, v in value.items()}
    if isinstance(value, list):
        return [to_jsonable(v) for v in value]
    return value


async def _query(pool: AsyncConnectionPool, sql: str, params: Sequence[Any]) -> List[Row]:
    async with pool.connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(sql, params)
            if cur.description is None:
                return []
            return await cur.fetchall()


async def read(sql: str, params: Sequence[Any] = ()) -> List[Row]:
    return await db_failover.read(lambda pool: _query(pool, sql, params), _primary, _replica)  # H2


async def read_primary(sql: str, params: Sequence[Any] = ()) -> List[Row]:
    # Background probes only: primary or nothing. Going through db_failover.read would log a
    # "degraded" read_from_replica event per poll and inflate the request-level FT metrics.
    try:
        return await _query(_primary, sql, params)
    except Exception as exc:
        raise UpstreamError(str(exc), 503) from exc


async def write(sql: str, params: Sequence[Any] = ()) -> List[Row]:  # primary only
    try:
        return await _query(_primary, sql, params)
    except Exception as exc:
        raise UpstreamError(str(exc), 503) from exc


class transaction:

    def __init__(self) -> None:
        self._conn_ctx = None
        self._cur_ctx = None

    async def __aenter__(self):
        self._conn_ctx = _primary.connection()
        conn = await self._conn_ctx.__aenter__()
        self._cur_ctx = conn.cursor(row_factory=dict_row)
        return await self._cur_ctx.__aenter__()

    async def __aexit__(self, exc_type, exc, tb):
        await self._cur_ctx.__aexit__(exc_type, exc, tb)
        result = await self._conn_ctx.__aexit__(exc_type, exc, tb)
        if exc_type is not None:
            log(kind="recovery", target="tx", action="rollback", err=str(exc))
        return result


async def db_healthy() -> bool:
    try:
        await asyncio.wait_for(_query(_primary, "SELECT 1", ()), timeout=timeouts.HEALTH_DB_CHECK_S)
        return True
    except Exception:
        return False
