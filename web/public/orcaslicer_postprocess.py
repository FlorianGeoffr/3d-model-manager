#!/usr/bin/env python3
"""OrcaSlicer post-processing script: uploads sliced files straight to 3D Model Manager.

Usage in OrcaSlicer:
  1. Go to: Process -> Others -> Special parameters -> Post-processing scripts
  2. Enter:
     python "C:\\path\\to\\orcaslicer_postprocess.py" --url "http://<TDMM-HOST>:8085" --token "<API-TOKEN>"
     
     (Or use the companion Windows batch script:
     "C:\\path\\to\\orcaslicer_upload.bat" --url "http://<TDMM-HOST>:8085" --token "<API-TOKEN>")

When OrcaSlicer finishes slicing or exporting, it automatically calls this script
with the file path as the final parameter, uploading it directly to your library!
"""

from __future__ import annotations

import argparse
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

_TIMEOUT_S = 180
_BODY_SNIPPET_LEN = 500


def main(argv: list[str]) -> int:
    if not argv:
        print("orcaslicer_postprocess: missing file argument", file=sys.stderr)
        return 1

    # OrcaSlicer always appends the sliced file path as the final argument
    file_path = argv[-1]

    # Parse optional CLI flags before the final file path
    flags = argv[:-1]
    parser = argparse.ArgumentParser(description="Upload sliced file to 3D Model Manager")
    parser.add_argument("--url", "-u", default=os.environ.get("INTAKE_URL"), help="3D Model Manager URL")
    parser.add_argument("--token", "-t", default=os.environ.get("INTAKE_TOKEN"), help="API token")

    args, _ = parser.parse_known_args(flags)

    url = args.url
    token = args.token

    if not url:
        print("orcaslicer_postprocess: error: TDMM URL is not set (use --url or INTAKE_URL)", file=sys.stderr)
        return 1
    if not token:
        print("orcaslicer_postprocess: error: API Token is not set (use --token or INTAKE_TOKEN)", file=sys.stderr)
        return 1

    if not os.path.isfile(file_path):
        print(f"orcaslicer_postprocess: file not found: {file_path!r}", file=sys.stderr)
        return 1

    # Normalize URL: if base URL provided, append /api/slicer/intake
    url = url.rstrip("/")
    if not url.endswith("/api/slicer/intake"):
        url = f"{url}/api/slicer/intake"

    file_size = os.path.getsize(file_path)
    filename = os.path.basename(file_path)
    query = urllib.parse.urlencode({"filename": filename})
    separator = "&" if "?" in url else "?"
    request_url = f"{url}{separator}{query}"

    print(f"orcaslicer_postprocess: uploading {filename} ({file_size / (1024*1024):.1f} MB) to {url}...")

    try:
        with open(file_path, "rb") as fh:
            request = urllib.request.Request(
                request_url,
                data=fh,
                method="POST",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/octet-stream",
                    "Content-Length": str(file_size),
                },
            )

            with urllib.request.urlopen(request, timeout=_TIMEOUT_S) as response:
                status = response.status
                response_body = response.read()

    except urllib.error.HTTPError as exc:
        err_msg = exc.read().decode("utf-8", errors="replace")[:_BODY_SNIPPET_LEN]
        print(f"orcaslicer_postprocess: intake failed (HTTP {exc.code}): {err_msg}", file=sys.stderr)
        return 1
    except urllib.error.URLError as exc:
        print(f"orcaslicer_postprocess: network error: {exc.reason}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"orcaslicer_postprocess: error: {exc}", file=sys.stderr)
        return 1

    if 200 <= status < 300:
        print(f"orcaslicer_postprocess: successfully uploaded {filename!r} to 3D Model Manager!")
        return 0
    else:
        snippet = response_body[:_BODY_SNIPPET_LEN].decode("utf-8", errors="replace")
        print(f"orcaslicer_postprocess: intake returned HTTP {status}: {snippet}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
