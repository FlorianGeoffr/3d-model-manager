import httpx
import pytest

from app.importers import makerworld
from app.importers.base import ImportFile
from app.importers.makerworld import MakerWorldImporter
from app.models.enums import ImportSite
from app.services.bambu_auth import BambuAuthError
from app.tasks.importing import ImportRejected
from tests.cassettes import makerworld_fixtures as fx


@pytest.fixture(autouse=True)
def _truncate_all_tables():
    """Local no-op override of the suite-wide autouse DB-truncate fixture
    (conftest.py) -- every test in this module is DB-free (pure HTTP-mock /
    string parsing), same override as test_thingiverse_importer.py (M6 C3c)."""
    yield


def _mock_design_client(body, status=200):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=body)

    return httpx.Client(
        base_url="https://makerworld.com/api/v1", transport=httpx.MockTransport(handler)
    )


def _mock_web_client(designs, *, build_id="TESTBUILD123", stale_id=None):
    """Mock the Next.js SSR search seam: `/en` yields a buildId, and
    `/_next/data/<buildId>/en/search/models.json` returns pageProps.designs.
    Passing `stale_id` makes the data route 404 for THAT id once (a deploy
    since the id was cached), exercising the refresh-and-retry path."""

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/en":
            return httpx.Response(200, text=f'<script>{{"buildId":"{build_id}"}}</script>')
        if path.startswith("/_next/data/") and path.endswith("/en/search/models.json"):
            used = path.split("/_next/data/", 1)[1].split("/", 1)[0]
            params = dict(request.url.params)
            assert params["keyword"] == fx.SEARCH_QUERY
            assert params["offset"] == "0" and params["limit"] == "20"
            if stale_id is not None and used == stale_id:
                return httpx.Response(404, json={"pageProps": {}})
            return httpx.Response(200, json={"pageProps": {"designs": designs, "total": 3545}})
        return httpx.Response(404, text="unexpected path")

    return httpx.Client(base_url="https://makerworld.com", transport=httpx.MockTransport(handler))


@pytest.fixture(autouse=True)
def _clear_build_id_cache():
    makerworld._BUILD_ID.clear()
    yield
    makerworld._BUILD_ID.clear()


def _raise_not_connected():
    raise BambuAuthError("no Bambu account is connected -- connect one in Settings.")


@pytest.mark.parametrize(
    "url,expected",
    [
        ("https://makerworld.com/en/models/3018898-nasa-fabric-pokeball", "3018898"),
        ("https://www.makerworld.com/en/models/3018898", "3018898"),
        ("https://makerworld.com/de/models/42", "42"),
        ("https://makerworld.com/models/42", "42"),
        ("https://www.thingiverse.com/thing:1", None),
        ("https://makerworld.com/en/collections/17685211-x", None),
    ],
)
def test_canonicalize(url, expected):
    assert MakerWorldImporter().canonicalize(url) == expected


def test_fetch_metadata_maps_verified_fields(monkeypatch):
    monkeypatch.setattr(makerworld, "_client", lambda: _mock_design_client(fx.DESIGN_3018898))
    meta = MakerWorldImporter().fetch_metadata(fx.DESIGN_ID)
    assert meta.site is ImportSite.MAKERWORLD and meta.external_id == fx.DESIGN_ID
    assert meta.title == "NASA Fabric: Pokeball (No AMS Needed)"
    assert meta.source_url == "https://www.makerworld.com/en/models/3018898"
    assert meta.author == "MeasureOnce"
    assert meta.license == "Standard Digital File License"
    assert meta.cover_url == fx.DESIGN_3018898["coverUrl"]
    assert meta.description == fx.DESIGN_3018898["summary"]
    assert set(meta.tags) == set(fx.DESIGN_3018898["tags"])
    # isExclusive is True on this fixture (live-verified: ~90% of MakerWorld
    # designs are, unrelated to payment -- see makerworld.py's docstring) and
    # paidSetting.isPaid is False -- must NOT be rejected.
    assert meta.reject_reason is None


def test_paid_model_is_rejected_with_clear_message(monkeypatch):
    monkeypatch.setattr(makerworld, "_client", lambda: _mock_design_client(fx.DESIGN_PAID))
    meta = MakerWorldImporter().fetch_metadata(str(fx.DESIGN_PAID["id"]))
    assert meta.reject_reason and "paid" in meta.reject_reason.lower()


def test_search_maps_designs_to_search_results(monkeypatch):
    # Anonymous (no Bambu account, no DB) -- the Next.js data route needs none.
    monkeypatch.setattr(
        makerworld, "_web_client", lambda: _mock_web_client(fx.SEARCH_DESIGNS_BENCHY)
    )
    results = MakerWorldImporter().search(fx.SEARCH_QUERY)
    assert [r.title for r in results] == [
        "NASA Fabric: Pokeball (No AMS Needed)",
        "12-in-1 Ultimate Multi Fidget Toy (Print in Place)",
    ]
    first = results[0]
    assert first.site is ImportSite.MAKERWORLD and first.external_id == "3018898"
    assert first.url == "https://www.makerworld.com/en/models/3018898"
    assert first.author == "MeasureOnce"
    assert first.thumbnail_url == fx.SEARCH_DESIGNS_BENCHY[0]["cover"]


def test_search_refreshes_a_stale_build_id(monkeypatch):
    # A deploy since the id was cached: the data route 404s on the stale id,
    # and search must re-read /en for the fresh one and retry (not just fail).
    makerworld._BUILD_ID["value"] = "STALEBUILD"
    monkeypatch.setattr(
        makerworld,
        "_web_client",
        lambda: _mock_web_client(
            fx.SEARCH_DESIGNS_BENCHY, build_id="FRESHBUILD", stale_id="STALEBUILD"
        ),
    )
    results = MakerWorldImporter().search(fx.SEARCH_QUERY)
    assert [r.external_id for r in results] == ["3018898", "3012887"]


def test_search_surfaces_a_cloudflare_challenge_clearly(monkeypatch):
    def _challenged():
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                403, headers={"cf-mitigated": "challenge"}, text="<title>Just a moment...</title>"
            )

        return httpx.Client(
            base_url="https://makerworld.com", transport=httpx.MockTransport(handler)
        )

    monkeypatch.setattr(makerworld, "_web_client", _challenged)
    with pytest.raises(RuntimeError, match="rate-limiting"):
        MakerWorldImporter().search(fx.SEARCH_QUERY)


def test_search_empty_query_returns_empty_list():
    assert MakerWorldImporter().search("") == []


def test_list_files_raises_bambu_auth_required_when_not_connected(monkeypatch):
    monkeypatch.setattr(makerworld, "_bambu_session", lambda: _raise_not_connected())
    with pytest.raises(ImportRejected, match="Bambu"):
        MakerWorldImporter().list_files(fx.DESIGN_ID)


def test_resolve_download_raises_bambu_auth_required_when_not_connected(monkeypatch):
    monkeypatch.setattr(makerworld, "_bambu_session", lambda: _raise_not_connected())
    with pytest.raises(ImportRejected, match="Bambu"):
        MakerWorldImporter().resolve_download(
            fx.DESIGN_ID, ImportFile(remote_id="x", filename="x.stl")
        )


def test_list_files_with_connected_account_maps_zip_stl_instances(monkeypatch):
    monkeypatch.setattr(makerworld, "_bambu_session", lambda: ("test-access-token", "global"))
    monkeypatch.setattr(makerworld, "_client", lambda: _mock_design_client(fx.DESIGN_3018898))
    files = MakerWorldImporter().list_files(fx.DESIGN_ID)
    assert len(files) == 1
    # profileId from the one hasZipStl instance in the fixture.
    assert files[0].remote_id == "12345"
    assert files[0].filename == "Default-3391581.zip"


def _mock_favorites_client(token, *, profile=None, hits_by_list=None):
    """Mock the cookie-authed `/api/v1` seam `_favorites_client` builds:
    handles `/user-service/my/profile` and `/design-service/favorites/
    designs/{listId}`, asserting the `token` cookie and `@{handle}` param
    both callers below are expected to send."""
    profile = profile or fx.PROFILE_TERMINALFOO
    hits_by_list = hits_by_list or {}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers.get("Cookie") == f"token={token}"
        path = request.url.path
        if path == "/api/v1/user-service/my/profile":
            return httpx.Response(200, json=profile)
        if path.startswith("/api/v1/design-service/favorites/designs/"):
            list_id = path.rsplit("/", 1)[-1]
            params = dict(request.url.params)
            assert params.get("handle") == f"@{profile['name']}"
            hits = hits_by_list.get(list_id, [])
            return httpx.Response(200, json={"hits": hits, "total": len(hits), "seed": 1})
        return httpx.Response(404, text="unexpected path")

    return httpx.Client(
        base_url="https://makerworld.com/api/v1",
        headers={"Cookie": f"token={token}"},
        transport=httpx.MockTransport(handler),
    )


def _mock_collections_client(
    favorites_list, *, build_id="TESTBUILD123", handle="Terminalfoo", token="test-token"
):
    """Mock the SSR `collections.json` seam `list_user_lists` reads via
    `_web_client`: `/en` yields a buildId, and `/_next/data/<buildId>/en/
    @<handle>/collections.json` returns `pageProps.favoritesList`."""

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/en":
            return httpx.Response(200, text=f'<script>{{"buildId":"{build_id}"}}</script>')
        if path == f"/_next/data/{build_id}/en/@{handle}/collections.json":
            assert dict(request.url.params) == {"handle": f"@{handle}"}
            assert request.headers.get("x-nextjs-data") == "1"
            assert request.headers.get("Cookie") == f"token={token}"
            return httpx.Response(200, json={"pageProps": {"favoritesList": favorites_list}})
        return httpx.Response(404, text="unexpected path")

    return httpx.Client(base_url="https://makerworld.com", transport=httpx.MockTransport(handler))


def _challenged_web_client():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            403, headers={"cf-mitigated": "challenge"}, text="<title>Just a moment...</title>"
        )

    return httpx.Client(base_url="https://makerworld.com", transport=httpx.MockTransport(handler))


def test_list_user_lists_none_when_no_bambu_account(monkeypatch):
    monkeypatch.setattr(makerworld, "_makerworld_web_token", lambda: None)
    assert MakerWorldImporter().list_user_lists() == []


def test_list_list_items_none_when_no_bambu_account(monkeypatch):
    monkeypatch.setattr(makerworld, "_makerworld_web_token", lambda: None)
    assert MakerWorldImporter().list_list_items("3054026541") == []


def test_list_user_lists_returns_aggregate_and_named_collections(monkeypatch):
    monkeypatch.setattr(makerworld, "_makerworld_web_token", lambda: "test-token")
    monkeypatch.setattr(
        makerworld, "_favorites_client", lambda token: _mock_favorites_client(token)
    )
    monkeypatch.setattr(
        makerworld, "_web_client", lambda: _mock_collections_client(fx.FAVORITES_LIST)
    )
    lists = MakerWorldImporter().list_user_lists()
    # Aggregate first, keyed by uid from the (consulted) profile.
    aggregate = lists[0]
    assert aggregate.list_id == str(fx.PROFILE_TERMINALFOO["uid"])
    assert aggregate.kind == "collection"
    assert aggregate.title == "All collected models"
    assert aggregate.count is None
    # Named collections: title/count mapped, `status: 2` ("Trays") skipped.
    named = {entry.list_id: entry for entry in lists[1:]}
    assert set(named) == {"2155987", "18925823"}
    assert named["2155987"].title == "Default Collection"
    assert named["2155987"].count == 7
    assert named["18925823"].title == "ESP32"
    assert named["18925823"].count == 9


def test_list_user_lists_still_returns_aggregate_when_collections_route_fails(monkeypatch):
    # The SSR collections.json route Cloudflare-challenges from a server IP
    # (intermittent, live-verified) -- must not take down the aggregate.
    monkeypatch.setattr(makerworld, "_makerworld_web_token", lambda: "test-token")
    monkeypatch.setattr(
        makerworld, "_favorites_client", lambda token: _mock_favorites_client(token)
    )
    monkeypatch.setattr(makerworld, "_web_client", _challenged_web_client)
    lists = MakerWorldImporter().list_user_lists()
    assert len(lists) == 1
    assert lists[0].list_id == str(fx.PROFILE_TERMINALFOO["uid"])
    assert lists[0].title == "All collected models"


def test_list_list_items_maps_hits_to_search_results(monkeypatch):
    monkeypatch.setattr(makerworld, "_makerworld_web_token", lambda: "test-token")
    list_id = str(fx.PROFILE_TERMINALFOO["uid"])
    monkeypatch.setattr(
        makerworld,
        "_favorites_client",
        lambda token: _mock_favorites_client(token, hits_by_list={list_id: fx.FAVORITE_DESIGNS}),
    )
    results = MakerWorldImporter().list_list_items(list_id)
    assert [r.external_id for r in results] == ["2188414", "2603954"]
    first = results[0]
    assert first.site is ImportSite.MAKERWORLD
    assert first.title == "ESP32-C6-Zigbee Gehäuse"
    assert first.url == "https://www.makerworld.com/en/models/2188414"
    assert first.author == "Jackstyle"
    assert first.thumbnail_url == fx.FAVORITE_DESIGNS[0]["cover"]


def test_resolve_download_hits_authed_endpoint_and_returns_presigned_url(monkeypatch):
    # NOTE: this authenticated download response shape is DOCUMENTED-NOT-
    # LIVE-CAPTURED (see MakerWorldImporter._fetch_authed_download_url's
    # docstring) -- the fixture body below is a best guess, not a recorded
    # real response, and must be reconciled against a real Bambu account at
    # acceptance.
    monkeypatch.setattr(makerworld, "_bambu_session", lambda: ("test-access-token", "global"))
    monkeypatch.setattr(makerworld, "_client", lambda: _mock_design_client(fx.DESIGN_3018898))

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/iot-service/api/user/profile/12345"
        assert dict(request.url.params) == {"model_id": fx.DESIGN_3018898["modelId"]}
        assert request.headers.get("Authorization") == "Bearer test-access-token"
        return httpx.Response(200, json={"url": "https://makerworld.bblmw.com/signed/file.zip"})

    monkeypatch.setattr(
        makerworld,
        "_authed_client",
        lambda token, region="global": httpx.Client(
            base_url="https://api.bambulab.com/v1",
            headers={"Authorization": f"Bearer {token}"},
            transport=httpx.MockTransport(handler),
        ),
    )
    out = MakerWorldImporter().resolve_download(
        fx.DESIGN_ID, ImportFile(remote_id="12345", filename="Default-3391581.zip")
    )
    assert out.url == "https://makerworld.bblmw.com/signed/file.zip"
    assert out.filename == "Default-3391581.zip"
    # No Bearer forwarded to the presigned CDN URL itself (Thingiverse
    # posture: never leak the app/account token to a public/signed asset URL).
    assert out.headers == {}
