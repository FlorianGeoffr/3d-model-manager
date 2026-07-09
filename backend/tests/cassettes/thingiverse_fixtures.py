"""Recorded GET /things/{id} body for a real, stable Thingiverse thing
(763622 "Marvin"). Hand-built to match the real API's zip_data.files[]/
images[] shape (SPEC/FULL line 228). Drives the Thingiverse importer's
parse/normalize logic with no network (M5 EXCEPTION)."""

THING_ID = "763622"

THING_763622 = {
    "id": 763622,
    "name": "Marvin (keychain)",
    "description": "The MyMiniFactory mascot.",
    "creator": {"name": "makerbot"},
    "license": "Creative Commons - Attribution",
    "tags": [{"name": "keychain"}, {"name": "marvin"}],
    "zip_data": {
        # Real shape: each file carries only {name, url} (a public CDN asset
        # URL). There is NO download_url/size here -- an earlier hand-built
        # fixture fabricated those, which is exactly what hid the list_files
        # bug from the mock-based tests.
        "files": [
            {"name": "Marvin.stl", "url": "https://cdn.thingiverse.com/assets/aa/marvin.stl"},
            {"name": "Marvin_v2.stl", "url": "https://cdn.thingiverse.com/assets/bb/marvin_v2.stl"},
        ],
        "images": [
            {"name": "cover.jpg", "url": "https://cdn.thingiverse.com/renders/cover.jpg"},
        ],
    },
}

SEARCH_TERM = "marvin"

# Documented (developer.thingiverse.com "Search a term" -- GET /search/{term})
# shape, NOT captured live: no TDMM_THINGIVERSE_TOKEN is configured in this
# environment to verify against the real token-gated endpoint. Hand-built to
# the documented `{"total": int, "hits": [...]}` response, each hit a thing
# summary carrying only the lightweight fields search needs.
SEARCH_MARVIN = {
    "total": 2,
    "hits": [
        {
            "id": 763622,
            "name": "Marvin (keychain)",
            "creator": {"name": "makerbot"},
            "thumbnail": "https://cdn.thingiverse.com/renders/cover.jpg",
            "public_url": "https://www.thingiverse.com/thing:763622",
        },
        {
            "id": 12345,
            "name": "Marvin the Robot",
            "creator": {"name": "someone"},
            "thumbnail": "https://cdn.thingiverse.com/renders/marvin2.jpg",
            "public_url": "https://www.thingiverse.com/thing:12345",
        },
    ],
}
