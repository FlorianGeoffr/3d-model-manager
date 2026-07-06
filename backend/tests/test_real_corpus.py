"""Real-corpus hook (SPEC deviation #3, M2 Global Constraints deviation
(3)): the primary test corpus is synthetic (``tests/corpus.py``) for
deterministic, offline CI -- this module additionally auto-discovers any
real Bambu Studio ``.3mf``/``.gcode.3mf`` exports a human has committed to
``tests/corpus_real/`` (see that directory's README) and exercises the
pipeline's actual parsing against them.

Test functions are generated dynamically (one per discovered file) rather
than via ``@pytest.mark.parametrize`` with a possibly-empty list: pytest's
"empty parameter set" handling collects a placeholder test and marks it
``SKIPPED`` rather than collecting nothing, which would violate the M2
quality gates' pristine-output requirement whenever this directory is
empty (its checked-in default state, pending the user supplying real
exports). Building zero functions when the glob is empty makes this module
contribute exactly zero collected items instead.
"""

from __future__ import annotations

from pathlib import Path

import lib3mf

from app.pipeline import slicedmeta

CORPUS_REAL_DIR = Path(__file__).parent / "corpus_real"

# ``*.3mf`` also matches ``*.gcode.3mf`` (sliced exports keep only stub
# geometry -- RESEARCH §3 -- so they'd fail the ">0 triangles" assertion
# below), hence the explicit exclusion.
_PROJECT_3MF_FILES = sorted(
    p for p in CORPUS_REAL_DIR.glob("*.3mf") if not p.name.endswith(".gcode.3mf")
)
_SLICED_GCODE_3MF_FILES = sorted(CORPUS_REAL_DIR.glob("*.gcode.3mf"))


def _lib3mf_triangle_count(path: Path) -> int:
    wrapper = lib3mf.get_wrapper()
    model = wrapper.CreateModel()
    reader = model.QueryReader("3mf")
    reader.ReadFromFile(str(path))

    count = 0
    iterator = model.GetMeshObjects()
    while iterator.MoveNext():
        count += iterator.GetCurrentMeshObject().GetTriangleCount()
    return count


def _make_project_3mf_test(path: Path):
    def test(path: Path = path) -> None:
        assert _lib3mf_triangle_count(path) > 0

    test.__name__ = f"test_real_3mf_lib3mf_yields_triangles__{path.stem}"
    return test


def _make_sliced_gcode_3mf_test(path: Path):
    def test(path: Path = path) -> None:
        sliced = slicedmeta.parse_gcode_3mf(path)
        assert sliced.plate_count >= 1
        assert sliced.print_time_s is not None

    test.__name__ = f"test_real_gcode_3mf_parses_plates__{path.stem}"
    return test


for _path in _PROJECT_3MF_FILES:
    _fn = _make_project_3mf_test(_path)
    globals()[_fn.__name__] = _fn

for _path in _SLICED_GCODE_3MF_FILES:
    _fn = _make_sliced_gcode_3mf_test(_path)
    globals()[_fn.__name__] = _fn
