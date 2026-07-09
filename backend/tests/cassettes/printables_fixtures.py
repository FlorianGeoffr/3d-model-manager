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
                    "image": {
                        "filePath": "media/prints/3161/images/20206_70fde6a0/benchy.jpg"
                    },
                    "user": {"publicUsername": "Prusa Research"},
                },
                {
                    "id": "1192178",
                    "name": "All Terrain Assault Benchy",
                    "image": {
                        "filePath": "media/prints/1192178/images/8960591_c320f4d9/img.jpeg"
                    },
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
