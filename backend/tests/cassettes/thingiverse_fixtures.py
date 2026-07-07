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
        "files": [
            {
                "name": "Marvin.stl",
                "size": 204800,
                "download_url": "https://cdn.thingiverse.com/assets/aa/marvin.stl",
            },
            {
                "name": "Marvin_v2.stl",
                "size": 210000,
                "download_url": "https://cdn.thingiverse.com/assets/bb/marvin_v2.stl",
            },
        ],
        "images": [
            {"name": "cover.jpg", "url": "https://cdn.thingiverse.com/renders/cover.jpg"},
        ],
    },
}
