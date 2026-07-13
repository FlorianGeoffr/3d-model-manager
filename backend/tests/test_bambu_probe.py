"""Table-driven tests for the staged Developer-Mode probe (Round 8 T1/T2:
``app.printers.probe``), plus ``BambuLanAdapter.test_connection``'s
delegation to it and the access-code redaction wrapper kept around it.
"""

from __future__ import annotations

import json
import time

from app.printers import probe
from app.printers.base import PrinterConnection, ProbeResult
from app.printers.bambu import BambuLanAdapter

CONN = PrinterConnection(host="1.2.3.4", serial="SERIAL123", access_code="12345678")


# ---------------------------------------------------------------------------
# Stage 1: TCP reachability
# ---------------------------------------------------------------------------


def test_tcp_check_refused_names_lan_and_developer_mode(monkeypatch):
    def _boom(addr, timeout=None):
        raise ConnectionRefusedError

    monkeypatch.setattr(probe.socket, "create_connection", _boom)
    result = probe._tcp_check("10.0.0.5")
    assert result is not None and result.ok is False
    assert "10.0.0.5" in result.detail
    assert "LAN Mode" in result.detail and "Developer Mode" in result.detail


def test_tcp_check_timeout_gives_generic_unreachable_detail(monkeypatch):
    def _boom(addr, timeout=None):
        raise TimeoutError

    monkeypatch.setattr(probe.socket, "create_connection", _boom)
    result = probe._tcp_check("10.0.0.5")
    assert result is not None and result.ok is False
    assert "Can't reach 10.0.0.5:8883" in result.detail


def test_tcp_check_ok_returns_none_to_continue(monkeypatch):
    class _Sock:
        def close(self):
            pass

    monkeypatch.setattr(probe.socket, "create_connection", lambda addr, timeout=None: _Sock())
    assert probe._tcp_check("10.0.0.5") is None


def test_tcp_check_bounded_against_a_real_unreachable_host():
    """Sanity against a real (non-routable, RFC 5737 TEST-NET-1) host: the
    stage's own explicit timeout bounds it -- not the OS TCP retry ceiling."""
    t0 = time.monotonic()
    result = probe._tcp_check("192.0.2.1", timeout=0.5)
    elapsed = time.monotonic() - t0
    assert result is not None and result.ok is False
    assert elapsed < 5, f"tcp check took {elapsed:.1f}s -- should be bounded by its own timeout"


# ---------------------------------------------------------------------------
# Stage 2: TLS cert serial cross-match
# ---------------------------------------------------------------------------


def test_cert_check_unreadable_cert(monkeypatch):
    def _boom(host, port, *, timeout=4.0):
        raise OSError("boom")

    monkeypatch.setattr(probe, "read_cert_cn", _boom)
    result = probe._cert_check("10.0.0.5", "SERIAL123")
    assert result is not None and result.ok is False
    assert "couldn't read its TLS certificate" in result.detail


def test_cert_check_mismatch_names_both_serials(monkeypatch):
    monkeypatch.setattr(probe, "read_cert_cn", lambda host, port, *, timeout=4.0: "OTHERSERIAL")
    result = probe._cert_check("10.0.0.5", "SERIAL123")
    assert result is not None and result.ok is False
    assert "OTHERSERIAL" in result.detail and "SERIAL123" in result.detail
    assert "Use Detect" in result.detail


def test_cert_check_match_returns_none(monkeypatch):
    monkeypatch.setattr(probe, "read_cert_cn", lambda host, port, *, timeout=4.0: "SERIAL123")
    assert probe._cert_check("10.0.0.5", "SERIAL123") is None


def test_cert_check_empty_cn_returns_none(monkeypatch):
    """An empty CN (the cert had no subject CN at all) isn't treated as a
    mismatch -- there's nothing to cross-match against, so fall through to
    the MQTT stage instead of blocking on it."""
    monkeypatch.setattr(probe, "read_cert_cn", lambda host, port, *, timeout=4.0: "")
    assert probe._cert_check("10.0.0.5", "SERIAL123") is None


# ---------------------------------------------------------------------------
# Stages 3+4: raw MQTT auth + status report
# ---------------------------------------------------------------------------


class _FakeMsg:
    def __init__(self, payload: bytes) -> None:
        self.payload = payload


class _FakeMqttClient:
    """Stand-in for ``paho.mqtt.client.Client``: synchronously invokes
    ``on_connect``/``on_message`` from ``loop_start()``/``publish()`` so
    tests run in microseconds -- no real socket/thread involved."""

    def __init__(self, *, rc: int, report: object | None) -> None:
        self._rc = rc
        self._report = report
        self.on_connect = None
        self.on_message = None
        self.subscribed: list[str] = []
        self.published: list[tuple[str, str]] = []
        self.disconnected = False

    def username_pw_set(self, *_a, **_k) -> None:
        pass

    def tls_set(self, *_a, **_k) -> None:
        pass

    def tls_insecure_set(self, *_a, **_k) -> None:
        pass

    def connect(self, host, port, keepalive=60) -> None:
        pass  # real CONNACK arrives once the loop is pumped -- see loop_start()

    def loop_start(self) -> None:
        if self.on_connect:
            self.on_connect(self, None, {}, self._rc)

    def loop_stop(self) -> None:
        pass

    def disconnect(self) -> None:
        self.disconnected = True

    def subscribe(self, topic) -> None:
        self.subscribed.append(topic)

    def publish(self, topic, payload) -> None:
        self.published.append((topic, payload))
        if self._report is not None and self.on_message:
            self.on_message(self, None, _FakeMsg(json.dumps(self._report).encode()))


def _install_fake_client(monkeypatch, *, rc: int, report: object | None = None) -> None:
    import paho.mqtt.client as mqtt

    monkeypatch.setattr(mqtt, "Client", lambda **_kw: _FakeMqttClient(rc=rc, report=report))


def test_mqtt_probe_rc5_names_access_code_rejected(monkeypatch):
    _install_fake_client(monkeypatch, rc=5)
    result = probe._mqtt_probe(CONN, timeout=1.0)
    assert result.ok is False
    assert "Access code rejected" in result.detail and CONN.host in result.detail


def test_mqtt_probe_other_nonzero_rc_names_the_code(monkeypatch):
    _install_fake_client(monkeypatch, rc=3)
    result = probe._mqtt_probe(CONN, timeout=1.0)
    assert result.ok is False
    assert "refused the MQTT connection (code 3)" in result.detail


def test_mqtt_probe_rc0_no_report_within_timeout(monkeypatch):
    _install_fake_client(monkeypatch, rc=0, report=None)
    result = probe._mqtt_probe(CONN, timeout=0.05)
    assert result.ok is False
    assert "sent no status" in result.detail
    assert "Developer Mode" in result.detail


def test_mqtt_probe_success_subscribes_serial_scoped_topic_and_reports_state(monkeypatch):
    _install_fake_client(monkeypatch, rc=0, report={"print": {"gcode_state": "IDLE"}})
    result = probe._mqtt_probe(CONN, timeout=1.0)
    assert result.ok is True
    assert result.gcode_state == "IDLE"
    assert "IDLE" in result.detail


def test_on_message_non_object_json_payload_is_ignored_not_raised(monkeypatch):
    """M4 fix-review: `_on_message` must not let `AttributeError` escape
    when the broker sends valid JSON that isn't an object (e.g. a bare
    array/number) -- `.get(...)` on a non-dict would otherwise blow up.
    `_FakeMqttClient.publish()` invokes `on_message` SYNCHRONOUSLY on this
    thread (unlike the real paho network-loop thread, which would just
    silently swallow the exception), so an unguarded `_on_message` would
    make THIS raise out of `_mqtt_probe` instead of timing out cleanly.
    """
    _install_fake_client(monkeypatch, rc=0, report=[1, 2, 3])
    result = probe._mqtt_probe(CONN, timeout=0.05)
    assert result.ok is False
    assert "sent no status" in result.detail


def test_mqtt_probe_never_subscribes_a_wildcard_topic(monkeypatch):
    import paho.mqtt.client as mqtt

    captured: dict[str, _FakeMqttClient] = {}

    def _make(**_kw):
        client = _FakeMqttClient(rc=0, report={"print": {"gcode_state": "IDLE"}})
        captured["client"] = client
        return client

    monkeypatch.setattr(mqtt, "Client", _make)
    probe._mqtt_probe(CONN, timeout=1.0)
    assert captured["client"].subscribed == [f"device/{CONN.serial}/report"]


def test_mqtt_probe_always_stops_and_disconnects(monkeypatch):
    import paho.mqtt.client as mqtt

    captured: dict[str, _FakeMqttClient] = {}

    def _make(**_kw):
        client = _FakeMqttClient(rc=5, report=None)
        captured["client"] = client
        return client

    monkeypatch.setattr(mqtt, "Client", _make)
    probe._mqtt_probe(CONN, timeout=1.0)
    assert captured["client"].disconnected is True


# ---------------------------------------------------------------------------
# staged_probe: stage sequencing (earlier stages stubbed per brief)
# ---------------------------------------------------------------------------


def test_staged_probe_stops_at_tcp_failure(monkeypatch):
    monkeypatch.setattr(
        probe, "_tcp_check", lambda host, **_kw: ProbeResult(ok=False, detail="tcp failed")
    )
    called = {"cert": False}
    monkeypatch.setattr(probe, "_cert_check", lambda *a, **kw: called.__setitem__("cert", True))
    result = probe.staged_probe(CONN, timeout=1.0)
    assert result.detail == "tcp failed"
    assert called["cert"] is False


def test_staged_probe_stops_at_cert_mismatch(monkeypatch):
    monkeypatch.setattr(probe, "_tcp_check", lambda host, **_kw: None)
    monkeypatch.setattr(
        probe, "_cert_check", lambda *a, **kw: ProbeResult(ok=False, detail="serial mismatch")
    )
    result = probe.staged_probe(CONN, timeout=1.0)
    assert result.detail == "serial mismatch"


def test_staged_probe_full_success(monkeypatch):
    monkeypatch.setattr(probe, "_tcp_check", lambda host, **_kw: None)
    monkeypatch.setattr(probe, "_cert_check", lambda *a, **kw: None)
    _install_fake_client(monkeypatch, rc=0, report={"print": {"gcode_state": "RUNNING"}})
    result = probe.staged_probe(CONN, timeout=1.0)
    assert result.ok is True and result.gcode_state == "RUNNING"


# ---------------------------------------------------------------------------
# BambuLanAdapter.test_connection: delegation + redaction wrapper
# ---------------------------------------------------------------------------


def test_test_connection_delegates_to_staged_probe(monkeypatch):
    captured = {}

    def _fake_staged_probe(conn, *, timeout):
        captured["conn"] = conn
        captured["timeout"] = timeout
        return ProbeResult(ok=True, detail="connected", gcode_state="IDLE")

    monkeypatch.setattr(probe, "staged_probe", _fake_staged_probe)
    result = BambuLanAdapter(CONN).test_connection(timeout=7.5)
    assert result.ok is True and result.gcode_state == "IDLE"
    assert captured["conn"] is CONN and captured["timeout"] == 7.5


def test_test_connection_close_is_a_safe_noop_after_probing(monkeypatch):
    """``staged_probe`` opens/closes its own sockets and never touches
    ``self._client()`` -- ``self._printer`` stays ``None``, so the
    ``finally: self.close()`` after it is a no-op, not a second (redundant)
    lib client teardown."""
    monkeypatch.setattr(
        probe, "staged_probe", lambda conn, *, timeout: ProbeResult(ok=True, detail="ok")
    )
    adapter = BambuLanAdapter(CONN)
    adapter.test_connection(timeout=1.0)
    assert adapter._printer is None


def test_test_connection_scrubs_access_code_from_exception_detail(monkeypatch):
    """A ``staged_probe`` failure could still raise (e.g. a lower-level
    socket/paho exception the stage helpers don't catch) whose text echoes
    the plaintext access code -- this ``detail`` flows verbatim into
    ``POST /api/printers/{id}/test``'s response, so it must never contain
    the code CONN was built with ("12345678"); it should show up as ``***``
    instead.
    """

    def _boom(conn, *, timeout):
        raise RuntimeError("auth rejected for access code 12345678")

    monkeypatch.setattr(probe, "staged_probe", _boom)
    result = BambuLanAdapter(CONN).test_connection(timeout=1.0)
    assert result.ok is False
    assert CONN.access_code not in result.detail
    assert "***" in result.detail
