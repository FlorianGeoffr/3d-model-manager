import httpx
import pytest

from app.config import get_settings
from app.importers import download


def _mock_client(body: bytes, *, status: int = 200):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, content=body)

    return httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True)


def test_stream_remote_to_spool_hashes_and_sizes(monkeypatch, data_dir):
    import blake3 as _b3

    body = b"solid cube\nendsolid cube\n"
    monkeypatch.setattr(download, "_download_client", lambda: _mock_client(body))
    get_settings.cache_clear()
    staged = download.stream_remote_to_spool(
        get_settings(), url="https://files.test/cube.stl", rel_path="cube.stl"
    )
    assert staged.size == len(body)
    assert staged.blob_hash == _b3.blake3(body).hexdigest()
    assert staged.rel_path == "cube.stl" and staged.spool_path.read_bytes() == body


def test_stream_remote_to_spool_http_error_leaves_no_spool(monkeypatch, data_dir):
    monkeypatch.setattr(download, "_download_client", lambda: _mock_client(b"nope", status=404))
    get_settings.cache_clear()
    with pytest.raises(httpx.HTTPStatusError):
        download.stream_remote_to_spool(
            get_settings(), url="https://files.test/missing.stl", rel_path="missing.stl"
        )
    # spool dir exists but holds no leftover file
    spooled = list((get_settings().data_dir / "spool").glob("*"))
    assert spooled == []
