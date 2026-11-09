from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .. import fault_injection
from ..core import metrics
from ..core.db import close_pools, db_healthy, open_pools, read, to_jsonable, transaction
from ..core.eventlog import ft_enabled, log
from ..core.service import create_app
from ..fault_tolerance.software import checkpoint_rollback, idempotency

STALE_PENDING_REFRESH_S = 5
STALE_PENDING_SQL = (  # a pending row this old was lost or interrupted mid-payment (PaymentsStuckPending)
    "SELECT count(*) AS n FROM payments WHERE state = 'pending' AND created_at < now() - interval '15 seconds'"
)


async def refresh_stale_pending() -> None:
    try:
        rows = await read(STALE_PENDING_SQL)
    except Exception:
        return  # DB unreachable: keep the last value; DatabaseDown is the alert for that
    metrics.set_stale_pending(rows[0]["n"] if rows else 0)


async def stale_pending_loop() -> None:  # every mode: integrity is measured the same way in all three
    while True:
        await refresh_stale_pending()
        await asyncio.sleep(STALE_PENDING_REFRESH_S)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await open_pools()
    tasks = [asyncio.create_task(checkpoint_rollback.sweep_loop()),   # S6 recovery
             asyncio.create_task(stale_pending_loop())]
    yield
    for task in tasks:
        task.cancel()
    await close_pools()


app = create_app(lifespan=lifespan)
app.include_router(fault_injection.router)


@app.get("/health")
async def health():
    ok = await db_healthy()
    return JSONResponse(status_code=200 if ok else 503, content={"ok": ok, "ft": ft_enabled()})


@app.post("/")
async def create_payment(body: dict, request: Request):
    await fault_injection.chaos_gate()
    try:
        amount = float(body.get("amount", 0))
    except (TypeError, ValueError):
        amount = 0
    if not body.get("studentId") or amount <= 0:
        return JSONResponse(status_code=400, content={"error": "studentId and a positive amount are required"})

    key = idempotency.payment_key(request.headers)                                      # 1. S5
    payment_id = await checkpoint_rollback.write_checkpoint(key, body["studentId"], amount)  # 2. S6
    if payment_id is None:
        return await idempotency.original_response(key)                                 # duplicate: S5

    if fault_injection.config["crashAfterCheckpoint"]:  # txn-interrupt experiment
        log(kind="chaos", action="crash_after_checkpoint", paymentId=str(payment_id))
        os._exit(1)

    try:
        async with transaction() as cur:  # 3. atomic charge
            await cur.execute("SELECT balance FROM students WHERE id = %s FOR UPDATE", (body["studentId"],))
            if await cur.fetchone() is None:
                return JSONResponse(status_code=404, content={"error": "student not found"})
            await cur.execute(
                "UPDATE students SET balance = balance + %s WHERE id = %s", (amount, body["studentId"])
            )
            await cur.execute(
                "UPDATE payments SET state = 'completed', updated_at = now() WHERE id = %s RETURNING *",
                (payment_id,),
            )
            result = await cur.fetchone()
        return JSONResponse(status_code=201, content=to_jsonable(result))
    except Exception:
        await checkpoint_rollback.mark_failed(payment_id)
        raise


@app.get("/{key}")
async def get_payment(key: str):
    rows = await read("SELECT * FROM payments WHERE idempotency_key = %s", (key,))
    if not rows:
        return JSONResponse(status_code=404, content={"error": "payment not found"})
    return to_jsonable(rows[0])
