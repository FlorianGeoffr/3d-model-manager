"""M1 end-to-end flow (Task 9): drives the full upload -> revision ->
diff -> download -> restart story against a REAL, running docker compose
stack over plain HTTP. Not part of the normal `uv run pytest` suite -- see
the `e2e` marker + `-m 'not e2e'` in backend/pyproject.toml's addopts.

Run via `scripts/e2e.sh`, which builds/starts the compose stack, waits
for health, runs this file with `-m e2e`, then tears the stack down.

Deliberately dependency-light: plain sync `httpx.Client` + stdlib +
`blake3` (a backend runtime dependency anyway) -- no imports from `app.*`,
so this genuinely exercises the built Docker image over the network rather
than the source tree in-process.
"""

from __future__ import annotations

import os
import struct
import subprocess
import time
from pathlib import Path

import httpx
import pytest
from blake3 import blake3

pytestmark = pytest.mark.e2e

REPO_ROOT = Path(__file__).resolve().parents[2]
LIBRARY_ROOT = Path(os.environ.get("E2E_LIBRARY_ROOT", str(REPO_ROOT / "library")))
BASE_URL = os.environ.get("E2E_BASE_URL", "http://localhost:8080")
ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "admin")

JOB_POLL_TIMEOUT_S = 60.0
HEALTH_POLL_TIMEOUT_S = 90.0
POLL_INTERVAL_S = 0.5

STL_HEADER = b"tdmm-e2e-generated-binary-stl".ljust(80, b"\0")

# 12 triangles per unit cube: (normal, (vertex indices into the 8-vertex
# list built per-cube in `generate_binary_stl`)). Winding/normals aren't
# exact -- nothing in M1 parses mesh geometry (that arrives in M2); this
# only needs to be a plausible, deterministic binary STL blob to exercise a
# large-ish streamed upload end to end.
_CUBE_FACES = [
    ((0, 0, -1), (0, 1, 2)),
    ((0, 0, -1), (0, 2, 3)),
    ((0, 0, 1), (4, 6, 5)),
    ((0, 0, 1), (4, 7, 6)),
    ((0, -1, 0), (0, 5, 1)),
    ((0, -1, 0), (0, 4, 5)),
    ((0, 1, 0), (3, 2, 6)),
    ((0, 1, 0), (3, 6, 7)),
    ((-1, 0, 0), (0, 3, 7)),
    ((-1, 0, 0), (0, 7, 4)),
    ((1, 0, 0), (1, 6, 2)),
    ((1, 0, 0), (1, 5, 6)),
]
_CUBE_OFFSETS = [
    (0, 0, 0),
    (1, 0, 0),
    (1, 1, 0),
    (0, 1, 0),
    (0, 0, 1),
    (1, 0, 1),
    (1, 1, 1),
    (0, 1, 1),
]


def _admin_password() -> str:
    password = os.environ.get("ADMIN_PASSWORD")
    if not password:
        pytest.fail(
            "ADMIN_PASSWORD must be set for the e2e run (scripts/e2e.sh sets a "
            "fixed one in .env so this test can log in with a known password)"
        )
    return password


def _pack_triangle(
    normal: tuple[float, float, float],
    v1: tuple[float, float, float],
    v2: tuple[float, float, float],
    v3: tuple[float, float, float],
) -> bytes:
    return struct.pack("<12fH", *normal, *v1, *v2, *v3, 0)


def generate_binary_stl(min_size_bytes: int = 1_000_000, *, salt: int = 0) -> bytes:
    """A deterministic, procedurally-generated binary STL of a grid of unit
    cubes, sized to at least `min_size_bytes` (task brief: "~1 MB
    procedurally-generated binary STL"). `salt` shifts the grid so two
    calls with different salts produce different bytes -- used to exercise
    a "replace" upload that actually changes the blob hash.
    """
    triangle_size = 50  # bytes: 12 f32 (normal + 3 vertices) + uint16 attr
    triangles_needed = max(12, -(-(min_size_bytes - 84) // triangle_size))
    cubes_needed = -(-triangles_needed // 12)

    body = bytearray()
    count = 0
    for i in range(cubes_needed):
        ox = float(i + salt * cubes_needed)
        base = [(ox + dx, float(dy), float(dz)) for dx, dy, dz in _CUBE_OFFSETS]
        for normal, (a, b, c) in _CUBE_FACES:
            body += _pack_triangle(normal, base[a], base[b], base[c])
            count += 1

    return STL_HEADER + struct.pack("<I", count) + bytes(body)


def _wait_for_health(timeout_s: float) -> None:
    deadline = time.monotonic() + timeout_s
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            response = httpx.get(f"{BASE_URL}/api/health", timeout=5.0)
            if response.status_code == 200:
                return
        except httpx.HTTPError as exc:
            last_error = exc
        time.sleep(POLL_INTERVAL_S)
    raise TimeoutError(f"api did not become healthy within {timeout_s}s: {last_error}")


def _login(client: httpx.Client) -> None:
    response = client.post(
        "/api/auth/login",
        json={"username": ADMIN_USERNAME, "password": _admin_password()},
    )
    assert response.status_code == 204, response.text


def _poll_job_done(client: httpx.Client, job_id: str) -> None:
    deadline = time.monotonic() + JOB_POLL_TIMEOUT_S
    last_state = None
    while time.monotonic() < deadline:
        response = client.get("/api/jobs")
        assert response.status_code == 200, response.text
        jobs = {j["id"]: j for j in response.json()}
        job = jobs.get(job_id)
        if job is not None:
            last_state = job
            if job["state"] == "done":
                return
            if job["state"] == "failed":
                pytest.fail(f"job {job_id} failed: {job['error']}")
        time.sleep(POLL_INTERVAL_S)
    pytest.fail(
        f"job {job_id} did not reach 'done' within {JOB_POLL_TIMEOUT_S}s; last seen: {last_state}"
    )


def _upload(
    client: httpx.Client,
    *,
    model_id: int,
    revision_id: int,
    rel_path: str,
    content: bytes,
    replace: bool = False,
) -> dict:
    params: dict[str, object] = {
        "model_id": model_id,
        "revision_id": revision_id,
        "rel_path": rel_path,
    }
    if replace:
        params["replace"] = "true"
    response = client.put("/api/uploads", params=params, content=content)
    assert response.status_code == 201, response.text
    return response.json()


def test_m1_full_flow() -> None:
    with httpx.Client(base_url=BASE_URL, timeout=30.0) as client:
        _login(client)

        # -- create model (-> revision 1, "rev-001_initial") -----------------
        create_response = client.post("/api/models", json={"name": "E2E Test Model"})
        assert create_response.status_code == 201, create_response.text
        model = create_response.json()
        model_id = model["id"]
        slug = model["slug"]
        revision_1 = model["current_revision"]
        assert revision_1["dir_name"] == "rev-001_initial"

        # -- upload a ~1MB procedurally-generated binary STL -----------------
        stl_bytes = generate_binary_stl()
        assert len(stl_bytes) >= 900_000
        upload_1 = _upload(
            client,
            model_id=model_id,
            revision_id=revision_1["id"],
            rel_path="part.stl",
            content=stl_bytes,
        )
        _poll_job_done(client, upload_1["job_id"])

        on_disk_1 = LIBRARY_ROOT / slug / revision_1["dir_name"] / "part.stl"
        assert on_disk_1.is_file(), f"expected uploaded file at {on_disk_1}"
        assert blake3(on_disk_1.read_bytes()).hexdigest() == upload_1["blob_hash"]

        # -- create revision 2: full snapshot copy ---------------------------
        revision_2_response = client.post(
            f"/api/models/{model_id}/revisions", json={"name": "second"}
        )
        assert revision_2_response.status_code == 201, revision_2_response.text
        revision_2 = revision_2_response.json()
        assert revision_2["dir_name"] == "rev-002_second"

        on_disk_2 = LIBRARY_ROOT / slug / revision_2["dir_name"] / "part.stl"
        assert on_disk_2.is_file(), f"expected snapshot-copied file at {on_disk_2}"
        assert blake3(on_disk_2.read_bytes()).hexdigest() == upload_1["blob_hash"]

        # -- diff rev1/rev2: everything unchanged -----------------------------
        diff_response = client.get(f"/api/revisions/{revision_1['id']}/diff/{revision_2['id']}")
        assert diff_response.status_code == 200, diff_response.text
        diff = diff_response.json()
        assert diff["added"] == []
        assert diff["removed"] == []
        assert diff["changed"] == []
        assert [entry["rel_path"] for entry in diff["unchanged"]] == ["part.stl"]

        # -- replace the file on rev2 with different content -------------------
        stl_bytes_v2 = generate_binary_stl(salt=1)
        assert stl_bytes_v2 != stl_bytes
        upload_2 = _upload(
            client,
            model_id=model_id,
            revision_id=revision_2["id"],
            rel_path="part.stl",
            content=stl_bytes_v2,
            replace=True,
        )
        _poll_job_done(client, upload_2["job_id"])

        # -- diff now shows exactly 1 changed, nothing unchanged ----------------
        diff_response_2 = client.get(f"/api/revisions/{revision_1['id']}/diff/{revision_2['id']}")
        assert diff_response_2.status_code == 200, diff_response_2.text
        diff_2 = diff_response_2.json()
        assert diff_2["added"] == []
        assert diff_2["removed"] == []
        assert diff_2["unchanged"] == []
        assert [entry["rel_path"] for entry in diff_2["changed"]] == ["part.stl"]

        # -- download + blake3-verify -------------------------------------------
        download_response = client.get(f"/api/files/{upload_2['file_id']}/download")
        assert download_response.status_code == 200, download_response.text
        assert blake3(download_response.content).hexdigest() == upload_2["blob_hash"]

    # -- restart-safety: docker compose restart api, then relogin -------------
    subprocess.run(["docker", "compose", "restart", "api"], check=True, cwd=REPO_ROOT, timeout=120)
    _wait_for_health(HEALTH_POLL_TIMEOUT_S)

    with httpx.Client(base_url=BASE_URL, timeout=30.0) as fresh_client:
        _login(fresh_client)
        models_response = fresh_client.get("/api/models")
        assert models_response.status_code == 200, models_response.text
        slugs = [item["slug"] for item in models_response.json()["items"]]
        assert slug in slugs
