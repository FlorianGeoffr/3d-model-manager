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

# -- saved collections / likes (M9 A3) ---------------------------------
# Trimmed from REAL response bodies live-captured 2026-07-10 against the
# official api.thingiverse.com developer API, app-token account
# @terminalfoo (user id 9772422). Kept to only the fields
# list_user_lists()/list_list_items() actually read -- the real bodies also
# carry description_html, is_editable, is_liked, tags[], comment_count,
# rank, moderation, ... which the importer never touches.

USERNAME = "terminalfoo"

# GET /users/me/ -> {"name": "<username>"} (there is no per-user OAuth on a
# static app token, but this "who am I" resource still resolves off it).
ME_TERMINALFOO = {"name": USERNAME}

# GET /users/terminalfoo/collections -- the live account's one real
# collection ("Things to Make", id 44156217, count 1).
COLLECTIONS_TERMINALFOO = [
    {"id": 44156217, "name": "Things to Make", "count": 1},
]

# GET /collections/44156217/things -- the one real thing inside it.
COLLECTION_THINGS = [
    {
        "id": 7378379,
        "name": "Flight radar (no soldering)",
        "public_url": "https://www.thingiverse.com/thing:7378379",
        "thumbnail": "https://cdn.thingiverse.com/assets/bf/19/54/a7/4b/IMG_7467.jpeg",
        "creator": {"name": "Adamow"},
    },
]

# GET /users/terminalfoo/likes -- same real thing, liked. The likes
# endpoint's `thumbnail` is a resize.thingiverse.com-wrapped URL (distinct
# from the collection-things one above) -- preserved as captured rather than
# normalized, since that's a real shape difference between the two
# endpoints, not an inconsistency in this fixture.
LIKES_TERMINALFOO = [
    {
        "id": 7378379,
        "name": "Flight radar (no soldering)",
        "public_url": "https://www.thingiverse.com/thing:7378379",
        "thumbnail": (
            "https://resize.thingiverse.com/?url=https://cdn.thingiverse.com/assets/"
            "bf/19/54/a7/4b/IMG_7467.jpeg&w=1024&h=1024&fit=contain&cbg=white&n=-1"
        ),
        "creator": {"name": "Adamow"},
    },
]

# Not a real capture -- two things exercising list_list_items' public_url
# handling (review fix): one carries a public_url that differs from the
# bare canonical form (proving it's used verbatim, not recomputed), the
# other lacks public_url entirely (proving the fallback kicks in instead of
# emitting url="", which silently fails canonicalize() on POST /imports
# round-trip).
COLLECTION_THINGS_MIXED_PUBLIC_URL = [
    {
        "id": 7378379,
        "name": "Flight radar (no soldering)",
        "public_url": "https://www.thingiverse.com/thing:7378379?ref=collection",
        "thumbnail": "https://cdn.thingiverse.com/assets/bf/19/54/a7/4b/IMG_7467.jpeg",
        "creator": {"name": "Adamow"},
    },
    {
        "id": 9988776,
        "name": "No Public URL Thing",
        "thumbnail": "https://cdn.thingiverse.com/assets/aa/bb/no-url.jpeg",
        "creator": {"name": "Adamow"},
    },
]
