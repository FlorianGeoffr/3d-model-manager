"""Kind-keyed registry resolving a ``PrinterKind`` to its ``PrinterAdapter``
implementation (SPEC "Printer integration"). ``build_adapter`` is the single
construction seam printerd/API/tests use -- tests monkeypatch or
``register_adapter`` over it to swap in ``FakePrinterAdapter``.

Import-safety: no third-party import here. Task 3 registers the real
``bambu_lan`` adapter by importing ``app.printers.bambu`` at the bottom of
this module; that module's own top level stays free of ``bambulabs_api`` /
``paho`` (lazy-imported inside its build function) so importing the registry
remains startup-safe with the printer feature OFF.
"""

from __future__ import annotations

from app.models.enums import PrinterKind
from app.printers.base import PrinterAdapter, PrinterConnection

PRINTER_REGISTRY: dict[PrinterKind, type[PrinterAdapter]] = {}


def register_adapter(cls: type[PrinterAdapter]) -> type[PrinterAdapter]:
    PRINTER_REGISTRY[cls.kind] = cls
    return cls


def build_adapter(kind: PrinterKind, conn: PrinterConnection) -> PrinterAdapter:
    try:
        cls = PRINTER_REGISTRY[kind]
    except KeyError as e:
        raise ValueError(f"no printer adapter registered for kind {kind!r}") from e
    return cls(conn)


from app.printers import bambu as _bambu  # noqa: F401,E402  (registers bambu_lan)
