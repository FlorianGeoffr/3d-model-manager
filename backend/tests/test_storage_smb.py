"""SMB-specific behavior the generic contract suite can't see (SPEC M3 "SMB:
lazy per-process sessions ... scandir with smb_info ... IP/DNS addressing").

The shared behavioral contract lives in ``test_storage_contract.py``
(parameterized over every backend, including ``smb``); this module covers
implementation details unique to the SMB backend: that ``walk()`` reads
size/mtime off ``SMBDirEntry.smb_info`` without an extra per-entry ``stat``
call (the whole point of using ``scandir`` over a naive listdir+stat loop),
UNC path construction, and that ``write()``'s UUID-temp staging file is
never left behind after a successful publish.
"""

import pytest
import smbclient

from app.storage.smb import _UNC, SmbStorageBackend


def test_scandir_uses_smb_info_not_per_entry_stat(
    smb_backend: SmbStorageBackend, monkeypatch: pytest.MonkeyPatch
) -> None:
    smb_backend.write("d/a.bin", [b"1"])
    smb_backend.write("d/b.bin", [b"22"])
    calls = {"stat": 0}
    real_stat = smbclient.stat

    def _counting_stat(*args: object, **kwargs: object) -> object:
        calls["stat"] += 1
        return real_stat(*args, **kwargs)

    monkeypatch.setattr(smbclient, "stat", _counting_stat)

    list(smb_backend.walk(""))

    assert calls["stat"] == 0  # sizes/mtimes come from SMBDirEntry.smb_info, no N+1 stat


def test_unc_path_construction() -> None:
    assert _UNC("host", "share", "a/b.bin") == r"\\host\share\a\b.bin"


def test_unc_path_construction_empty_key_is_share_root() -> None:
    assert _UNC("host", "share", "") == r"\\host\share"


def test_write_leaves_no_temp_artifact(smb_backend: SmbStorageBackend) -> None:
    smb_backend.write("clean.bin", [b"x"])

    names = [e.key for e in smb_backend.walk("")]

    assert names == ["clean.bin"]  # UUID temp was renamed away, not left behind


def test_copy_leaves_no_temp_artifact(smb_backend: SmbStorageBackend) -> None:
    smb_backend.write("src.bin", [b"payload"])

    smb_backend.copy("src.bin", "dst.bin")

    names = sorted(e.key for e in smb_backend.walk(""))
    assert names == ["dst.bin", "src.bin"]


def test_ensure_session_survives_external_connection_reset(smb_backend: SmbStorageBackend) -> None:
    """Regression: a naive "register the session once per process" memo goes
    stale the moment something external calls
    ``smbclient.reset_connection_cache()`` (worker shutdown; also what the
    ``smb_backend``/``samba_container`` fixtures do between tests) -- the
    next bare smbclient call would then try, and fail, to open a fresh
    credential-less session. The backend must re-assert its session on every
    call instead of trusting a one-time memo.
    """
    smb_backend.write("before-reset.bin", [b"1"])

    smbclient.reset_connection_cache()

    smb_backend.write("after-reset.bin", [b"2"])
    assert b"".join(smb_backend.read("after-reset.bin")) == b"2"
