"""Recorded `design-service/design/{id}` and `search-service/select/design`
bodies for MakerWorld (Workstream B task B1). The free-model fixture trims
the REAL live response captured for design 3018898 (grounding probe) down to
the fields ``fetch_metadata``/``search`` actually read; the paid fixture is
hand-built (``paidSetting.isPaid`` was ``false`` on every one of 200
live-sampled designs during grounding, so a genuinely paid example wasn't
observed) with a minimal, structurally faithful ``paidSetting`` shape."""

DESIGN_ID = "3018898"

DESIGN_3018898 = {
    "id": 3018898,
    "title": "NASA Fabric: Pokeball (No AMS Needed)",
    "slug": "nasa-fabric-pokeball-no-ams-needed",
    "summary": "<p>Boost if you like my model!</p>",
    "designCreator": {
        "uid": 2225712507,
        "name": "MeasureOnce",
        "avatar": "https://public-cdn.bblmw.com/avatar/2225712507/2024-11-12_5bd28d.jpg",
    },
    "license": "Standard Digital File License",
    "coverUrl": "https://makerworld.bblmw.com/makerworld/model/US1efdb154b59848/design/746db.gif",
    "tags": ["nasa fabric", "ball", "pokeball", "fidget"],
    # Live-verified (grounding, 200-design sample): true on ~90% of ALL
    # designs regardless of price -- a creator-rewards program badge, not a
    # paywall. NOT importable-gating (see app/importers/makerworld.py).
    "isExclusive": True,
    "paidSetting": {"isPaid": False, "crowdfunding": 0},
    "isPrintable": True,
    "modelId": "US1efdb154b59848",
    "defaultInstanceId": 3391581,
    "instances": [
        {
            "id": 3391581,
            "title": "Default",
            "hasZipStl": True,
            "profileId": 12345,
            "downloadCount": 351,
            "pictures": [{"url": "https://makerworld.bblmw.com/pic1.jpg"}],
        }
    ],
}

DESIGN_PAID = {
    **DESIGN_3018898,
    "id": 9999999,
    "title": "Paid Exclusive Design",
    "paidSetting": {"isPaid": True, "crowdfunding": 0},
}

SEARCH_QUERY = "benchy"

# LIVE-CAPTURED shape of MakerWorld's real keyword search: the Next.js SSR data
# route `/_next/data/<buildId>/en/search/models.json?keyword=<q>`, whose JSON is
# `{"pageProps": {"designs": [<item>...], "total": int, ...}, "__N_SSP": true}`.
# Each item: {id, title, slug, cover, designCreator: {uid, name, ...}, ...}.
# Reached ANONYMOUSLY -- keyword filtering was confirmed working against the
# live account (real "benchy" designs returned). The earlier
# `search-service/select/design` endpoint was a trending handler that ignored
# the keyword; see app/importers/makerworld.py's module docstring.
SEARCH_DESIGNS_BENCHY = [
    {
        "id": 3018898,
        "title": "NASA Fabric: Pokeball (No AMS Needed)",
        "slug": "nasa-fabric-pokeball-no-ams-needed",
        "cover": "https://makerworld.bblmw.com/makerworld/model/US1efdb154b59848/746db.gif",
        "designCreator": {"uid": 2225712507, "name": "MeasureOnce"},
        "likeCount": 664,
        "downloadCount": 351,
    },
    {
        "id": 3012887,
        "title": "12-in-1 Ultimate Multi Fidget Toy (Print in Place)",
        "slug": "12-in-1-ultimate-multi-fidget-toy",
        "cover": "https://makerworld.bblmw.com/cover2.gif",
        "designCreator": {"uid": 111, "name": "someone"},
        "likeCount": 10,
        "downloadCount": 5,
    },
]
