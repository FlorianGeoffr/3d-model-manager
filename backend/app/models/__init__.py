"""SQLAlchemy ORM models for tdmm.

Importing this package registers every mapped class on the shared
``Base.metadata`` so Alembic autogeneration and ``Base.metadata.create_all``
see the full schema (SPEC "Data model").
"""

from app.models.auth import ApiToken, Session, User
from app.models.base import Base
from app.models.collections import FollowedCollection, PendingImport
from app.models.library import Blob, File, Model, Note, PrintQueueEntry, Revision, Tag, model_tags
from app.models.printing import Printer, PrintJob
from app.models.processing import AssemblyThumb, BlobMeta, Derivative
from app.models.storage import FileLocation, StorageBackendRow
from app.models.system import Import, Job, ScanRun, Setting

__all__ = [
    "ApiToken",
    "AssemblyThumb",
    "Base",
    "Blob",
    "BlobMeta",
    "Derivative",
    "File",
    "FileLocation",
    "FollowedCollection",
    "Import",
    "Job",
    "Model",
    "Note",
    "PendingImport",
    "Printer",
    "PrintJob",
    "PrintQueueEntry",
    "Revision",
    "ScanRun",
    "Session",
    "Setting",
    "StorageBackendRow",
    "Tag",
    "User",
    "model_tags",
]
