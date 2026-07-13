"""TLS certificate-based serial discovery for a Bambu printer on the LAN
(Round 8 T1). With LAN Mode + Developer Mode on, the printer's MQTT port
(:8883) serves a self-signed cert (issuer "BBL CA") whose subject Common
Name IS the printer's serial -- reading it needs nothing more than a raw TLS
handshake, no MQTT login. Powers both the "Detect" button
(``POST /printers/detect-serial``) and the probe's cert cross-match
(``app.printers.probe``).

Import-safety: stdlib ``socket``/``ssl`` + ``cryptography`` only --
``cryptography`` is already a direct, eagerly-imported dependency elsewhere
(``app.crypto``), so this module is safe to import at module level (no
``bambulabs_api``/``paho`` here; see ``tests/test_flag_off_imports.py``).
"""

from __future__ import annotations

import socket
import ssl

from cryptography import x509
from cryptography.x509.oid import NameOID


def _cn_from_der(der: bytes) -> str:
    """Pure parse: a DER-encoded X.509 certificate -> its subject Common
    Name, or ``""`` if the cert has none. Factored out of ``read_cert_cn``
    so tests can drive the parsing logic directly against an in-test
    self-signed cert, without a real socket/TLS handshake."""
    cert = x509.load_der_x509_certificate(der)
    names = cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME)
    return str(names[0].value) if names else ""


def read_cert_cn(host: str, port: int = 8883, *, timeout: float = 4.0) -> str:
    """Open a raw TLS connection to ``(host, port)`` and return the peer
    certificate's subject Common Name. Never verifies the cert (self-signed,
    issuer "BBL CA") -- this is a read-only discovery probe, not an auth
    step; ``check_hostname``/``verify_mode`` are deliberately relaxed the
    same way ``app.printers.probe`` relaxes them for the MQTT TLS session.
    """
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    with socket.create_connection((host, port), timeout=timeout) as sock:
        with ctx.wrap_socket(sock, server_hostname=host) as tls:
            der = tls.getpeercert(binary_form=True)
    return _cn_from_der(der or b"")
