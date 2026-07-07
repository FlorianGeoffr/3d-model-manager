"""Storage backend registry (SPEC "Storage layer").

Backends self-register under a scheme name (``local``, and ``smb``/``s3`` in
M3) so callers never import a concrete backend class directly.

M1 wires only ``local``, rooted at ``TDMM_LIBRARY_ROOT`` (env-only config).
M3 (see SPEC M3) adds ``smb``/``s3`` backends whose connection details come
from DB-backed settings (``app.services.storage_config``) rather than env
vars -- ``get_backend`` takes the validated per-backend ``StorageConfig`` the
caller resolved from the DB instead of a bare scheme name.
"""

from __future__ import annotations

from collections.abc import Callable

from app.config import Settings
from app.storage.base import StorageBackend
from app.storage.config import LocalConfig, StorageConfig
from app.storage.errors import StorageError
from app.storage.local import LocalStorageBackend

_BackendFactory = Callable[[Settings, StorageConfig], StorageBackend]

_REGISTRY: dict[str, _BackendFactory] = {}


def register(scheme: str) -> Callable[[_BackendFactory], _BackendFactory]:
    """Decorator registering a backend factory under ``scheme``."""

    def decorator(factory: _BackendFactory) -> _BackendFactory:
        _REGISTRY[scheme] = factory
        return factory

    return decorator


@register("local")
def _build_local_backend(settings: Settings, config: StorageConfig) -> StorageBackend:
    return LocalStorageBackend(settings.library_root)


def get_backend(settings: Settings, config: StorageConfig | None = None) -> StorageBackend:
    """Return the backend for ``config`` (defaults to ``LocalConfig()``)."""
    cfg = config if config is not None else LocalConfig()
    try:
        factory = _REGISTRY[cfg.backend]
    except KeyError as e:
        raise StorageError(f"no storage backend registered for scheme {cfg.backend!r}") from e
    return factory(settings, cfg)
