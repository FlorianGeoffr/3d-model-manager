import json
import time

import pytest
import redis as redis_lib

from app.config import get_settings
from app.models import Blob, File, Model, Printer, PrintJob, Revision
from app.models.enums import BlobFormat, BlobKind, PrinterKind, PrintJobState
from app.printerd import PrinterWorker
from app.printers.base import PrinterConnection, state_key
from app.printers.fake import FakePrinterAdapter
from app.tasks import base
from tests.cassettes import bambu_snapshots as cass


def _seed_active_job(printer_id: int) -> int:
    with base.sync_session() as s:
        blob = Blob(hash="a" * 64, size=1, kind=BlobKind.SLICED, format=BlobFormat.GCODE_3MF)
        model = Model(slug="m1", name="M1")
        s.add_all([blob, model])
        s.flush()
        rev = Revision(model_id=model.id, number=1, dir_name="rev-001")
        s.add(rev)
        s.flush()
        f = File(
            revision_id=rev.id,
            blob_hash=blob.hash,
            rel_path="p.gcode.3mf",
            storage_path="m1/rev-001/p.gcode.3mf",
        )
        s.add(f)
        s.flush()
        job = PrintJob(
            printer_id=printer_id, file_id=f.id, state=PrintJobState.STARTING, subtask_name="w"
        )
        s.add(job)
        s.commit()
        s.refresh(job)
        return job.id


@pytest.fixture
def worker(redis_url, printer_enabled, migrated_db):
    settings = get_settings()
    with base.sync_session() as s:
        printer = Printer(
            name="p",
            kind=PrinterKind.BAMBU_LAN,
            host="h",
            serial="S",
            access_code_enc="x",
            enabled=True,
        )
        s.add(printer)
        s.commit()
        s.refresh(printer)
        pid = printer.id
    adapter = FakePrinterAdapter(PrinterConnection(host="h", serial="S", access_code="x"))
    client = redis_lib.Redis.from_url(settings.redis_url)
    return PrinterWorker(settings, pid, adapter, client), adapter, pid, client


def _next_event(pubsub, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        msg = pubsub.get_message(ignore_subscribe_messages=True, timeout=0.5)
        if msg and msg["type"] == "message":
            return json.loads(msg["data"])
    raise AssertionError("no event published")


def test_handle_report_writes_redis_state(worker):
    w, _adapter, pid, client = worker
    w.handle_report(cass.SNAPSHOT_IDLE)
    state = json.loads(client.get(state_key(pid)))
    assert state["gcode_state"] == "IDLE" and state["mc_percent"] == 0


def test_report_transitions_active_job_and_publishes(worker):
    w, _adapter, pid, client = worker
    job_id = _seed_active_job(pid)
    pubsub = client.pubsub()
    pubsub.subscribe("tdmm:events")
    while pubsub.get_message(timeout=0.1):
        pass
    w.handle_report(cass.SNAPSHOT_IDLE)  # IDLE -> job_state None -> no transition
    w.handle_report(cass.SNAPSHOT_PRINTING)  # RUNNING -> PRINTING
    with base.sync_session() as s:
        job = s.get(PrintJob, job_id)
        assert job.state == PrintJobState.PRINTING.value
        assert job.progress_pct == 55 and job.layer == 66 and job.total_layers == 120
        assert job.started_at is not None
    evt = _next_event(pubsub)
    assert evt == {
        "type": "print_job.updated",
        "print_job_id": job_id,
        "printer_id": pid,
        "state": "printing",
    }


def test_finish_sets_finished_at(worker):
    w, _adapter, pid, _client = worker
    job_id = _seed_active_job(pid)
    w.handle_report(cass.SNAPSHOT_PRINTING)
    w.handle_report(cass.SNAPSHOT_FINISH)
    with base.sync_session() as s:
        job = s.get(PrintJob, job_id)
        assert job.state == PrintJobState.FINISHED.value and job.finished_at is not None


def test_error_report_fails_job(worker):
    w, _adapter, pid, _client = worker
    job_id = _seed_active_job(pid)
    w.handle_report(cass.SNAPSHOT_ERROR)
    with base.sync_session() as s:
        job = s.get(PrintJob, job_id)
        assert job.state == PrintJobState.FAILED.value and job.printer_error == "83935248"


def test_command_dispatch(worker):
    w, adapter, _pid, _client = worker
    w.handle_command("pause")
    w.handle_command("resume")
    w.handle_command("stop")
    assert adapter.paused == 1 and adapter.resumed == 1 and adapter.stopped == 1
