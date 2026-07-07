import pytest

from app.printers.gcode3mf import NotSendableError, assert_plate_available, plates_in_gcode_3mf
from tests import corpus


def test_sliced_gcode_3mf_reports_present_plate():
    assert plates_in_gcode_3mf(corpus.sliced_gcode_3mf()) == [1]  # only plate_1.gcode ships


def test_bare_gcode_rejected():
    with pytest.raises(NotSendableError):
        plates_in_gcode_3mf(corpus.bambu_gcode())


def test_assert_plate_available_rejects_missing_plate():
    data = corpus.sliced_gcode_3mf()
    assert_plate_available(data, 1)
    with pytest.raises(NotSendableError):
        assert_plate_available(data, 2)  # metadata lists plate 2 but its gcode isn't present
