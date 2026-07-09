"""``StrEnum`` types backing the ``sa.Enum(..., native_enum=False)`` columns.

Values (not member names) are what SPEC lists and what gets persisted to the
DB (see ``app.models.base.str_enum``). Where SPEC marks a column ``enum``
without spelling out a value list (``imports.site``, ``imports.state``),
values below are a judgment call grounded in the "Gallery importers" and
"Data model" SPEC sections.
"""

from enum import StrEnum


class BlobKind(StrEnum):
    """Coarse content category of a blob (SPEC ``blobs.kind``)."""

    MESH = "mesh"
    CAD = "cad"
    SLICED = "sliced"
    GCODE = "gcode"
    IMAGE = "image"
    OTHER = "other"


class BlobFormat(StrEnum):
    """File format of a blob (SPEC ``blobs.format``)."""

    STL = "stl"
    THREEMF = "3mf"
    OBJ = "obj"
    STEP = "step"
    IGES = "iges"
    GCODE_3MF = "gcode_3mf"
    GCODE = "gcode"
    PNG = "png"
    JPG = "jpg"
    OTHER = "other"


class DerivativeKind(StrEnum):
    """Kind of generated derivative (SPEC ``derivatives.kind``)."""

    THUMB_256 = "thumb_256"
    THUMB_1024 = "thumb_1024"
    GLB = "glb"
    GLB_PREVIEW = "glb_preview"


class DerivativeStatus(StrEnum):
    """Pipeline status shared by ``derivatives.status`` and
    ``assembly_thumbs.status`` (SPEC states the latter tersely as bare
    ``status`` right after defining this same status vocabulary for
    ``derivatives`` -- reusing one enum for both is the natural reading).
    """

    PENDING = "pending"
    OK = "ok"
    FAILED = "failed"
    UNSUPPORTED = "unsupported"


class PrinterKind(StrEnum):
    """Discriminates ``PrinterAdapter`` implementations (SPEC ``printers.kind``).

    Only ``bambu_lan`` ships in v1; future adapters (Moonraker/Klipper,
    OctoPrint, PrusaLink) add members here without core changes.
    """

    BAMBU_LAN = "bambu_lan"


class PrintJobState(StrEnum):
    """Lifecycle of a print job (SPEC ``print_jobs.state``)."""

    QUEUED = "queued"
    UPLOADING = "uploading"
    STARTING = "starting"
    PRINTING = "printing"
    PAUSED = "paused"
    FINISHED = "finished"
    FAILED = "failed"
    CANCELED = "canceled"


class ImportSite(StrEnum):
    """Gallery site an import came from (SPEC ``imports.site``, values not
    enumerated in SPEC -- taken from the "Gallery importers" table).
    """

    THINGIVERSE = "thingiverse"
    PRINTABLES = "printables"
    MAKERWORLD = "makerworld"


class ImportState(StrEnum):
    """Lifecycle of a gallery import (SPEC ``imports.state``, values not
    enumerated in SPEC -- inferred from the importer flow: canonicalize ->
    fetch_metadata -> resolve_download -> ingest, atomic on success).
    """

    PENDING = "pending"
    FETCHING = "fetching"
    DOWNLOADING = "downloading"
    DONE = "done"
    FAILED = "failed"


class CollectionSyncMode(StrEnum):
    """What a periodic collection sync does with a NEWLY discovered item
    (M8 H). Chosen per followed list, so a trusted collection can auto-import
    while a noisy one only queues items for approval."""

    AUTO = "auto"  # import it straight into the library
    REVIEW = "review"  # queue it in `pending_imports` for one-click approval
