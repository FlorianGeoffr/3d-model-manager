import subprocess
import sys
from pathlib import Path


def test_app_import_does_not_load_the_printer_lib():
    # app.api.printers doesn't exist until a later M4 task adds the printers
    # API router (see m4-surface-map.md); import it best-effort so this
    # guard starts covering it automatically once it lands, without needing
    # to fail on THIS task's narrower module set.
    code = (
        "import sys, importlib\n"
        "import app.main, app.printers.registry, app.printers.bambu\n"
        "try:\n"
        "    importlib.import_module('app.api.printers')\n"
        "except ModuleNotFoundError:\n"
        "    pass\n"
        "leaked = sorted(m for m in sys.modules if 'bambulabs_api' in m or m.startswith('paho'))\n"
        "assert not leaked, leaked\n"
        "print('ok')\n"
    )
    out = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        cwd=str(Path(__file__).resolve().parent.parent),
    )
    assert out.returncode == 0, out.stderr
    assert "ok" in out.stdout
