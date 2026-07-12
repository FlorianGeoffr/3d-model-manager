"""Recorded GraphQL bodies for Printables model 3161 (the SPEC-named contract
model) matching api.printables.com/graphql/'s print(id:)/getDownloadLink
shapes. Hand-built (M5 EXCEPTION -- no network in the default gate)."""

MODEL_ID = "3161"

PRINT_3161 = {
    "data": {
        "print": {
            "id": 3161,
            "name": "Benchy",
            "description": "The jolly 3D printing torture test.",
            "user": {"publicUsername": "printables_user"},
            "license": {"name": "CC-BY-4.0"},
            "tags": [{"name": "boat"}, {"name": "calibration"}],
            "image": {"filePath": "media/prints/3161/cover.png"},
            # UNVERIFIED (feat/import-fidelity T2): a gallery `images` list
            # hand-built to exercise the importer's image_urls parsing --
            # NOT captured against the live schema (see printables.py's
            # PRINT_QUERY comment). Includes a filePath equal to the cover's
            # own (exercises dedup) and one without a filePath at all
            # (exercises tolerant parsing of a malformed entry).
            "images": [
                {"filePath": "media/prints/3161/cover.png"},
                {"filePath": "media/prints/3161/images/side.jpg"},
                {"filePath": None},
            ],
            "premium": False,
            "stls": [
                {"id": 90001, "name": "3DBenchy.stl", "fileSize": 2400000},
                {"id": 90002, "name": "3DBenchy_hollow.stl", "fileSize": 1800000},
            ],
        }
    }
}

PRINT_3161_PREMIUM = {
    "data": {
        "print": {
            "id": 3161,
            "name": "Paid Model",
            "description": "",
            "user": {"publicUsername": "seller"},
            "license": {"name": "Standard Digital"},
            "tags": [],
            "image": None,
            "premium": True,
            "stls": [],
        }
    }
}

SEARCH_QUERY = "benchy"

# Recorded shape for searchPrints2 (Workstream B task B1), discovered live via
# GraphQL introspection + a real query on the anonymous endpoint (query=
# "benchy" against api.printables.com/graphql/, confirmed to actually
# text-filter -- a nonsense query returns zero hits).
SEARCH_PRINTS_BENCHY = {
    "data": {
        "searchPrints2": {
            "totalCount": 3658,
            "items": [
                {
                    "id": "3161",
                    "name": "3D BENCHY",
                    "image": {"filePath": "media/prints/3161/images/20206_70fde6a0/benchy.jpg"},
                    "user": {"publicUsername": "Prusa Research"},
                },
                {
                    "id": "1192178",
                    "name": "All Terrain Assault Benchy",
                    "image": {"filePath": "media/prints/1192178/images/8960591_c320f4d9/img.jpeg"},
                    "user": {"publicUsername": "soozafone"},
                },
            ],
        }
    }
}

DOWNLOAD_LINK_90001 = {
    "data": {
        "getDownloadLink": {
            "ok": True,
            "output": {"link": "https://files.printables.com/media/dl/3161/3DBenchy.stl?token=abc"},
        }
    }
}

# -- saved collections / likes (Workstream A task A4) -------------------------
# Trimmed real bodies, live-captured 2026-07-10 against the user's own
# Printables account (Bearer-authenticated `userCollections`/
# `moreCollectionModels`/`moreLikedPrints2` queries -- see printables.py's
# A4 comment block for the full contract).

USER_ID = "5092991"

USER_COLLECTIONS = {
    "data": {
        "collections": [
            {
                "id": "3585865",
                "name": "Stuff",
                "private": True,
                "likesCount": 0,
                "modelsCount": 1,
            }
        ]
    }
}

COLLECTION_MODELS = {
    "data": {
        "models": {
            "cursor": "",
            "items": [
                {
                    "id": "605259",
                    "model": {
                        "id": "605259",
                        "name": "Dual Color Poker Chips With Numbers",
                        "slug": "dual-color-poker-chips-with-numbers",
                        "user": {"publicUsername": "agepbiz"},
                        "image": {"filePath": "media/prints/605259/images/abc123/poker_chips.jpg"},
                    },
                }
            ],
        }
    }
}

LIKED_MODELS = {
    "data": {
        "models": {
            "cursor": "",
            "items": [
                {
                    "id": "605259",
                    "model": {
                        "id": "605259",
                        "name": "Dual Color Poker Chips With Numbers",
                        "slug": "dual-color-poker-chips-with-numbers",
                        "user": {"publicUsername": "agepbiz"},
                        "image": {"filePath": "media/prints/605259/images/abc123/poker_chips.jpg"},
                    },
                }
            ],
        }
    }
}
