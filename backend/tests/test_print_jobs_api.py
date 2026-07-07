"""Print-jobs history API (SPEC "API surface": print-jobs; M4 Task 7):
read-only listing (most-recent-first, optional ``printer_id`` filter) and
single-job lookup, both behind the printer-feature 503 gate.
"""

from __future__ import annotations

from datetime import UTC, datetime

from app.models import Blob, File, Model, Printer, PrintJob, Revision
from app.models.enums import BlobFormat, BlobKind, PrinterKind, PrintJobState


async def _seed_two_jobs(db_session) -> tuple[int, list[int]]:
    printer = Printer(
        name="p",
        kind=PrinterKind.BAMBU_LAN,
        host="h",
        serial="S",
        access_code_enc="x",
        enabled=True,
    )
    blob = Blob(hash="b" * 64, size=1, kind=BlobKind.SLICED, format=BlobFormat.GCODE_3MF)
    model = Model(slug="pj", name="PJ")
    db_session.add_all([printer, blob, model])
    await db_session.flush()
    rev = Revision(model_id=model.id, number=1, dir_name="rev-001")
    db_session.add(rev)
    await db_session.flush()
    f = File(
        revision_id=rev.id,
        blob_hash=blob.hash,
        rel_path="p.gcode.3mf",
        storage_path="pj/rev-001/p.gcode.3mf",
        verified_at=datetime.now(UTC),
    )
    db_session.add(f)
    await db_session.flush()
    j1 = PrintJob(
        printer_id=printer.id, file_id=f.id, state=PrintJobState.FINISHED, subtask_name="a"
    )
    j2 = PrintJob(
        printer_id=printer.id, file_id=f.id, state=PrintJobState.PRINTING, subtask_name="b"
    )
    db_session.add_all([j1, j2])
    await db_session.commit()
    await db_session.refresh(j1)
    await db_session.refresh(j2)
    return printer.id, [j1.id, j2.id]


async def test_print_jobs_503_when_disabled(authenticated_client):
    assert (await authenticated_client.get("/api/print-jobs")).status_code == 503


async def test_list_and_get_and_filter(authenticated_client, printer_enabled, db_session):
    pid, [j1, j2] = await _seed_two_jobs(db_session)
    rows = (await authenticated_client.get("/api/print-jobs")).json()
    assert [r["id"] for r in rows] == [j2, j1]  # most-recent-first
    assert (await authenticated_client.get(f"/api/print-jobs/{j1}")).json()["state"] == "finished"
    filtered = (await authenticated_client.get(f"/api/print-jobs?printer_id={pid}")).json()
    assert {r["id"] for r in filtered} == {j1, j2}
    assert (await authenticated_client.get("/api/print-jobs/999999")).status_code == 404


async def test_list_limit(authenticated_client, printer_enabled, db_session):
    _pid, [j1, j2] = await _seed_two_jobs(db_session)
    rows = (await authenticated_client.get("/api/print-jobs?limit=1")).json()
    assert [r["id"] for r in rows] == [j2]
