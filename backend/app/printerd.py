"""printerd: long-lived Bambu MQTT supervisor (SPEC "Architecture"). Holds one
bambulabs_api client session per enabled printer (the lib owns the MQTT
stream + incremental merge); POLLS the adapter's normalized snapshot on a
short interval into Redis printer:{id}:state; transitions the active
print_jobs row + publishes a coarse print_job.updated SSE event; subscribes
a Redis command channel for pause/resume/stop. NOT a Celery task -- a plain
long-lived process (compose service mirroring `beat`) reusing
app.tasks.base.sync_session()."""

from __future__ import annotations

import contextlib
import dataclasses
import json
import logging
import signal
import threading
from datetime import UTC, datetime

import redis
from sqlalchemy import select

from app.config import Settings, get_settings
from app.models import Printer, PrintJob
from app.models.enums import PrintJobState
from app.printers.base import PrinterAdapter, PrinterPublicState, command_channel, state_key
from app.printers.connection import connection_from_printer
from app.printers.registry import build_adapter
from app.services.events import publish_print_job_event_sync
from app.tasks import base

log = logging.getLogger("printerd")
_TERMINAL = {PrintJobState.FINISHED, PrintJobState.FAILED, PrintJobState.CANCELED}
# The lib keeps its own state fresh from the MQTT stream; request_full_status()
# is a cheap LOCAL read of the lib's accessors, so poll it every few seconds.
_POLL_INTERVAL_S = 2.5


class PrinterWorker:
    def __init__(
        self,
        settings: Settings,
        printer_id: int,
        adapter: PrinterAdapter,
        redis_client: redis.Redis,
    ) -> None:
        self.settings = settings
        self.printer_id = printer_id
        self.adapter = adapter
        self.redis = redis_client
        self._merged: dict | None = None

    def handle_report(self, report: dict) -> None:
        self._merged = self.adapter.merge_report(self._merged, report)
        public = self.adapter.public_state(self._merged)
        self.redis.set(state_key(self.printer_id), json.dumps(dataclasses.asdict(public)))
        self._transition_active_job(public)

    def _active_job(self, session) -> PrintJob | None:
        return (
            session.execute(
                select(PrintJob)
                .where(
                    PrintJob.printer_id == self.printer_id,
                    PrintJob.state.notin_([s.value for s in _TERMINAL]),
                )
                .order_by(PrintJob.id.desc())
            )
            .scalars()
            .first()
        )

    def _transition_active_job(self, public: PrinterPublicState) -> None:
        new_state = self.adapter.job_state(public)
        if new_state is None:
            return
        with base.sync_session() as session:
            job = self._active_job(session)
            if job is None or job.state == new_state.value:
                return
            job.state = new_state.value
            job.progress_pct = public.mc_percent
            job.remaining_min = public.mc_remaining_time
            job.layer = public.layer_num
            job.total_layers = public.total_layer_num
            job.printer_error = str(public.print_error) if public.print_error else None
            job.raw_status = self._merged
            now = datetime.now(UTC)
            if new_state == PrintJobState.PRINTING and job.started_at is None:
                job.started_at = now
            if new_state in _TERMINAL:
                job.finished_at = now
            job_id = job.id
            session.commit()
        publish_print_job_event_sync(
            self.settings.redis_url,
            print_job_id=job_id,
            printer_id=self.printer_id,
            state=new_state.value,
        )

    def handle_command(self, command: str) -> None:
        if command == "pause":
            self.adapter.pause()
        elif command == "resume":
            self.adapter.resume()
        elif command == "stop":
            self.adapter.stop()
        else:
            log.warning("printerd: unknown command %r for printer %s", command, self.printer_id)


class PrinterDaemon:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.redis = redis.Redis.from_url(settings.redis_url)
        self._workers: dict[int, PrinterWorker] = {}
        self._stop = threading.Event()

    def enabled_printers(self) -> list[Printer]:
        with base.sync_session() as session:
            return list(session.execute(select(Printer).where(Printer.enabled.is_(True))).scalars())

    def start_printer(self, printer: Printer) -> PrinterWorker:
        conn = connection_from_printer(self.settings, printer)
        adapter = build_adapter(printer.kind, conn)
        worker = PrinterWorker(self.settings, printer.id, adapter, self.redis)
        adapter.set_report_handler(worker.handle_report)
        adapter.connect()
        adapter.request_full_status()
        self._workers[printer.id] = worker
        self._subscribe_commands(printer.id, worker)
        return worker

    def _subscribe_commands(self, printer_id: int, worker: PrinterWorker) -> None:
        pubsub = self.redis.pubsub()
        pubsub.subscribe(command_channel(printer_id))

        def _loop() -> None:
            for msg in pubsub.listen():
                if self._stop.is_set():
                    break
                if msg["type"] != "message":
                    continue
                try:
                    command = json.loads(msg["data"]).get("command")
                except (ValueError, TypeError):
                    continue
                if command:
                    try:
                        worker.handle_command(command)
                    except Exception:
                        log.exception("printerd: command %r failed", command)

        threading.Thread(target=_loop, daemon=True, name=f"cmd-{printer_id}").start()

    def run(self) -> None:
        for printer in self.enabled_printers():
            try:
                self.start_printer(printer)
            except Exception as exc:
                # Exception TEXT could echo the plaintext access code (e.g. an
                # MQTT/FTPS auth-failure string) -- log only the type, never
                # the full exception body.
                log.error(
                    "printerd: failed to start printer %s: %s", printer.id, type(exc).__name__
                )
        while not self._stop.wait(_POLL_INTERVAL_S):
            for worker in self._workers.values():
                try:
                    # emit a fresh lib snapshot -> Redis + transitions
                    worker.adapter.request_full_status()
                except Exception as exc:
                    # Same access-code leak concern as the start-failure log
                    # above -- type only, never the full exception body.
                    log.error("printerd: status poll failed: %s", type(exc).__name__)

    def stop(self) -> None:
        self._stop.set()
        for worker in self._workers.values():
            with contextlib.suppress(Exception):
                worker.adapter.close()


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    settings = get_settings()
    if not settings.printer_enabled:
        log.info("printerd: TDMM_PRINTER_ENABLED is off; idling.")
        signal.pause()  # idle instead of crash-looping under restart:unless-stopped
        return
    daemon = PrinterDaemon(settings)
    signal.signal(signal.SIGTERM, lambda *_: daemon.stop())
    signal.signal(signal.SIGINT, lambda *_: daemon.stop())
    daemon.run()


if __name__ == "__main__":
    main()
