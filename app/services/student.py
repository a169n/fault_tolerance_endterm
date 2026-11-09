from __future__ import annotations

from fastapi.responses import JSONResponse

from .. import fault_injection
from ..core.db import db_healthy, read, to_jsonable, write
from ..core.eventlog import ft_enabled
from ..core.service import create_app

app = create_app()
app.include_router(fault_injection.router)


@app.get("/health/ready")
@app.get("/health")  # alias of /health/ready: the midterm harness probes /health
async def health():
    ok = await db_healthy()
    return JSONResponse(status_code=200 if ok else 503, content={"ok": ok, "ft": ft_enabled()})


@app.get("/")
async def list_students():
    await fault_injection.chaos_gate()
    rows = await read("SELECT id, name, credits, balance FROM students ORDER BY id LIMIT 100")
    return to_jsonable(rows)


@app.post("/")
async def create_student(body: dict):
    await fault_injection.chaos_gate()
    if not body.get("id") or not body.get("name"):
        return JSONResponse(status_code=400, content={"error": "id and name are required"})
    rows = await write(
        """INSERT INTO students (id, name, credits) VALUES (%s, %s, %s)
           ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
           RETURNING id, name, credits, balance""",
        (body["id"], body["name"], body.get("credits", 0)),
    )
    return JSONResponse(status_code=201, content=to_jsonable(rows[0]))


@app.get("/{student_id}")
async def get_student(student_id: str):
    await fault_injection.chaos_gate()
    rows = await read("SELECT id, name, credits, balance FROM students WHERE id = %s", (student_id,))
    if not rows:
        return JSONResponse(status_code=404, content={"error": "student not found"})
    return to_jsonable(rows[0])
