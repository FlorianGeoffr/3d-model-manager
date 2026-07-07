"""Testcontainer fixtures for the storage-contract suite (SPEC M3
"Verification"): a real MinIO container (S3) and a real ``dperson/samba``
container (SMB) -- never ``moto``, never a mock SMB server (M3 global
constraints).

Session-scoped container fixtures (``samba_container``/``minio_container``)
so the whole test session shares one container of each; function-scoped
factory fixtures (``smb_backend``/``s3_backend``) build a fresh, empty
backend rooted at a unique per-test namespace on top of that shared
container, so tests never collide.

Registered as a pytest plugin from ``tests/conftest.py`` so any test module
(this suite, and Task 3/4's backend-specific tests) can request
``smb_backend``/``s3_backend`` without an explicit import.

The concrete backend classes (``SmbStorageBackend`` from Task 3,
``S3StorageBackend`` from Task 4) don't exist yet. Importing them at module
level would break collection of this entire module -- and therefore every
test module that imports it -- before either backend lands. Both factory
fixtures import their backend class lazily, inside the fixture function body,
so collection succeeds today; ``tests/test_storage_contract.py``'s ``local``
param runs fine in the meantime and its ``smb``/``s3`` params skip *before*
ever requesting these fixtures, so neither container starts on a normal run.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator

import boto3
import pytest
import smbclient
from botocore.client import Config as BotoConfig
from testcontainers.core.container import DockerContainer
from testcontainers.core.wait_strategies import LogMessageWaitStrategy
from testcontainers.minio import MinioContainer

from app.storage.config import S3Config, SmbConfig

SMB_USER, SMB_PASS, SMB_SHARE = "tdmm", "tdmm-pass", "library"


@pytest.fixture(scope="session")
def samba_container() -> Iterator[DockerContainer]:
    """One real ``dperson/samba`` container for the whole test session.

    Only started when a test actually requests ``smb_backend`` (directly, or
    transitively once Task 3 wires ``storage_backend``'s ``smb`` param to
    it) -- a run where every ``smb`` param is skipped never reaches this
    fixture at all.
    """
    container = (
        DockerContainer("dperson/samba:latest")
        .with_command(f'-u "{SMB_USER};{SMB_PASS}" -s "{SMB_SHARE};/share;yes;no;no;{SMB_USER}" -p')
        .with_exposed_ports(445)
        .waiting_for(
            LogMessageWaitStrategy("daemon 'smbd' finished starting up").with_startup_timeout(60)
        )
    )
    container.start()
    try:
        yield container
    finally:
        smbclient.reset_connection_cache()
        container.stop()


@pytest.fixture(scope="session")
def minio_container() -> Iterator[MinioContainer]:
    """One real MinIO container for the whole test session.

    Only started when a test actually requests ``s3_backend`` (directly, or
    transitively once Task 4 wires ``storage_backend``'s ``s3`` param to
    it).
    """
    with MinioContainer() as container:
        yield container


@pytest.fixture
def smb_backend(samba_container: DockerContainer) -> Iterator[object]:
    """A fresh, empty ``SmbStorageBackend`` rooted at a unique per-test
    namespace on the shared ``samba_container`` (Task 3 consumes this).
    """
    from app.storage.smb import SmbStorageBackend

    host = samba_container.get_container_host_ip()
    port = int(samba_container.get_exposed_port(445))
    root = f"t-{uuid.uuid4().hex}"
    config = SmbConfig(
        host=host,
        share=SMB_SHARE,
        root=root,
        username=SMB_USER,
        password=SMB_PASS,
        port=port,
        encrypt=False,  # encrypt off for the throwaway container
    )
    backend = SmbStorageBackend(config)
    backend.mkdirs("")  # create the per-test root
    yield backend
    smbclient.reset_connection_cache()


@pytest.fixture
def s3_backend(minio_container: MinioContainer) -> Iterator[object]:
    """A fresh, empty ``S3StorageBackend`` against a freshly created bucket
    on the shared ``minio_container`` (Task 4 consumes this).
    """
    from app.storage.s3 import S3StorageBackend

    conn = minio_container.get_config()  # {"endpoint", "access_key", "secret_key"}
    endpoint = f"http://{conn['endpoint']}"
    bucket = f"tdmm-{uuid.uuid4().hex}"
    client = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=conn["access_key"],
        aws_secret_access_key=conn["secret_key"],
        config=BotoConfig(s3={"addressing_style": "path"}),
    )
    client.create_bucket(Bucket=bucket)
    config = S3Config(
        bucket=bucket,
        access_key=conn["access_key"],
        secret_key=conn["secret_key"],
        endpoint_url=endpoint,
        prefix="lib",
        addressing="path",
    )
    backend = S3StorageBackend(config)
    # Exposed (Task 6) so a test that needs the raw config -- e.g. to build a
    # `migrate_storage` target dict -- doesn't have to duplicate this
    # fixture's bucket-creation dance just to get it.
    backend.config = config
    yield backend
