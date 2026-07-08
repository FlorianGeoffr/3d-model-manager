"""Storage backend registry (SPEC "Storage layer"; M1 wires only ``local``)."""

from pathlib import Path

import pytest

from app.config import Settings, get_settings
from app.storage.config import LocalConfig, S3Config, SmbConfig
from app.storage.errors import StorageError
from app.storage.local import LocalStorageBackend
from app.storage.registry import get_backend, register


def test_get_backend_returns_local_backend_rooted_at_library_root(tmp_path: Path) -> None:
    settings = Settings(library_root=tmp_path / "library")

    backend = get_backend(settings)

    assert isinstance(backend, LocalStorageBackend)
    assert backend.root == (tmp_path / "library").resolve()


def test_get_backend_unknown_scheme_raises(tmp_path: Path) -> None:
    settings = Settings(library_root=tmp_path / "library")

    class _Bogus(LocalConfig):
        backend: str = "nope"  # type: ignore[assignment]

    with pytest.raises(StorageError):
        get_backend(settings, _Bogus())


def test_register_decorator_adds_a_new_scheme(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import app.storage.registry as registry_module

    # Snapshot/restore the module-level registry so this doesn't leak a
    # test-only scheme into other tests.
    monkeypatch.setattr(registry_module, "_REGISTRY", dict(registry_module._REGISTRY))
    sentinel = object()

    @register("unit-test-scheme")
    def _factory(settings, config):
        return sentinel

    class _UnitTestConfig(LocalConfig):
        backend: str = "unit-test-scheme"  # type: ignore[assignment]

    settings = Settings(library_root=tmp_path / "library")

    assert get_backend(settings, _UnitTestConfig()) is sentinel


# The smb/s3 factory paths (`_build_smb_backend`/`_build_s3`) were never
# executed by any test -- the contract suite constructs the backends
# directly (M3 carried gap, M6 C3a). Both constructors are I/O-free (smb
# registers sessions lazily per call; the boto3 client connects on first
# use), so these stay fast and deterministic with no container.
def test_get_backend_returns_smb_backend_for_smb_config() -> None:
    from app.storage.smb import SmbStorageBackend

    cfg = SmbConfig(host="h", share="sh", username="u", password="p")

    assert isinstance(get_backend(get_settings(), cfg), SmbStorageBackend)


def test_get_backend_returns_s3_backend_for_s3_config() -> None:
    from app.storage.s3 import S3StorageBackend

    cfg = S3Config(bucket="b", access_key="a", secret_key="s")

    assert isinstance(get_backend(get_settings(), cfg), S3StorageBackend)
