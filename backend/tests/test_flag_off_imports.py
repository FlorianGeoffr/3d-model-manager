import subprocess
import sys
from pathlib import Path


def test_app_import_does_not_load_the_printer_lib():
    # app.api.printers now exists (M4 Task 4 adds the printers API router);
    # import it for real so this guard actually covers it, rather than the
    # earlier best-effort try/except for a module that didn't exist yet.
    code = (
        "import sys\n"
        "import app.main, app.printers.registry, app.printers.bambu, app.api.printers\n"
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
