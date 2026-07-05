"""Shared declarative base, naming convention, and enum-column helper."""

from datetime import datetime
from enum import StrEnum

from sqlalchemy import DateTime, MetaData
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import DeclarativeBase

# Explicit naming convention so every constraint/index gets a deterministic
# name, independent of driver/version behavior. Alembic autogenerate relies
# on this to produce stable, diffable migrations.
NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    """Declarative base shared by all ORM models."""

    metadata = MetaData(naming_convention=NAMING_CONVENTION)

    # Every ``Mapped[datetime]`` column maps to ``TIMESTAMPTZ`` by default,
    # matching the SPEC's "timestamps" columns without repeating
    # ``DateTime(timezone=True)`` on every column.
    type_annotation_map = {  # noqa: RUF012 - SQLAlchemy-mandated mutable class attr
        datetime: DateTime(timezone=True),
    }


def str_enum[E: StrEnum](enum_cls: type[E], name: str) -> SAEnum:
    """Build a ``sa.Enum`` column type backed by a Python ``StrEnum``.

    Per project convention this is always ``native_enum=False`` (a VARCHAR
    column plus a CHECK constraint, portable and easy to alter later without
    ``ALTER TYPE``). ``values_callable`` makes SQLAlchemy persist each
    member's *value* (e.g. ``"3mf"``) instead of its Python identifier name
    (SQLAlchemy's default) -- important because some spec values (like
    ``"3mf"``) can't themselves be Python identifiers. ``create_constraint``
    must be passed explicitly: SQLAlchemy 2.0 defaults it to ``False``, which
    would otherwise leave ``native_enum=False`` columns as a plain VARCHAR
    with no DB-level enforcement at all.

    ``name`` becomes the CHECK constraint's name and must be unique per
    column even when the same ``StrEnum`` backs more than one column.
    """
    return SAEnum(
        enum_cls,
        name=name,
        native_enum=False,
        create_constraint=True,
        values_callable=lambda obj: [member.value for member in obj],
    )
