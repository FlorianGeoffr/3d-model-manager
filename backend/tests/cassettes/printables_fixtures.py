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

DOWNLOAD_LINK_90001 = {
    "data": {
        "getDownloadLink": {
            "ok": True,
            "output": {"link": "https://files.printables.com/media/dl/3161/3DBenchy.stl?token=abc"},
        }
    }
}
