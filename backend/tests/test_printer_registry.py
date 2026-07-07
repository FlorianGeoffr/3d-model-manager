import pytest

from app.models.enums import PrinterKind
from app.printers.base import PrinterConnection, PrinterPublicState
from app.printers.fake import FakePrinterAdapter
from app.printers.registry import PRINTER_REGISTRY, build_adapter, register_adapter

CONN = PrinterConnection(host="h", serial="S", access_code="c")


@pytest.mark.skip(reason="bambu adapter lands in Task 3")
def test_bambu_lan_is_registered():
    assert PrinterKind.BAMBU_LAN in PRINTER_REGISTRY  # bambu import at registry bottom (Task 3)


def test_build_adapter_unknown_kind_raises():
    class _Bogus:
        value = "nope"

    with pytest.raises(ValueError):
        build_adapter(_Bogus(), CONN)  # type: ignore[arg-type]


def test_register_decorator_keys_on_kind():
    register_adapter(FakePrinterAdapter)  # over bambu_lan
    try:
        assert isinstance(build_adapter(PrinterKind.BAMBU_LAN, CONN), FakePrinterAdapter)
    finally:
        # from app.printers import bambu
        # PRINTER_REGISTRY[PrinterKind.BAMBU_LAN] = bambu.BambuLanAdapter
        del PRINTER_REGISTRY[PrinterKind.BAMBU_LAN]


def test_fake_merge_and_public_state():
    a = FakePrinterAdapter(CONN)
    merged = a.merge_report({"gcode_state": "IDLE"}, {"print": {"mc_percent": 42}})
    assert merged == {"gcode_state": "IDLE", "mc_percent": 42}
    assert a.public_state(merged) == PrinterPublicState(gcode_state="IDLE", mc_percent=42)


def test_fake_emit_drives_handler():
    a = FakePrinterAdapter(CONN)
    seen: list[dict] = []
    a.set_report_handler(seen.append)
    a.emit({"print": {"mc_percent": 7}})
    assert seen == [{"print": {"mc_percent": 7}}]
