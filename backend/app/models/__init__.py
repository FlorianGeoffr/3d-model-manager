"""SQLAlchemy ORM models for tdmm.

Importing this package registers every mapped class on the shared
``Base.metadata`` so Alembic autogeneration and ``Base.metadata.create_all``
see the full schema (SPEC "Data model").
"""

from app.models.auth import Session, User
from app.models.base import Base
from app.models.library import Blob, File, Model, Note, Revision, Tag, model_tags
from app.models.printing import Printer, PrintJob
from app.models.processing import AssemblyThumb, BlobMeta, Derivative
from app.models.storage import FileLocation, StorageBackendRow
from app.models.system import Import, Job, ScanRun, Setting

__all__ = [
    "AssemblyThumb",
    "Base",
    "Blob",
    "BlobMeta",
    "Derivative",
    "File",
    "FileLocation",
    "Import",
    "Job",
    "Model",
    "Note",
    "Printer",
    "PrintJob",
    "Revision",
    "ScanRun",
    "Session",
    "Setting",
    "StorageBackendRow",
    "Tag",
    "User",
    "model_tags",
]
