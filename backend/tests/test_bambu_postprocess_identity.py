"""Round 8 fix-review M5: ``scripts/bambu_postprocess.py`` and
``web/public/bambu_postprocess.py`` are deliberately two copies of the
exact same file -- the ``web/public`` one is what the frontend serves as
the downloadable Bambu Studio post-processing script (see the README's
Bambu Studio setup section), and it can't simply import the ``scripts/``
one across the ``backend``/``web`` package boundary. Nothing on disk
enforces that a change landing in one copy also lands in the other, so
this is the durable drift guard: fails loudly the moment the two diverge.
"""

from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def test_bambu_postprocess_script_is_byte_identical_in_both_locations() -> None:
    scripts_copy = REPO_ROOT / "scripts" / "bambu_postprocess.py"
    web_copy = REPO_ROOT / "web" / "public" / "bambu_postprocess.py"

    assert scripts_copy.is_file(), scripts_copy
    assert web_copy.is_file(), web_copy
    assert scripts_copy.read_bytes() == web_copy.read_bytes(), (
        "scripts/bambu_postprocess.py and web/public/bambu_postprocess.py have "
        "drifted -- keep them byte-identical (copy one over the other)."
    )
