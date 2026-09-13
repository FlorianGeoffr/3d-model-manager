"""Safe ``Content-Disposition`` header construction (R11 review finding 2).

Names sourced from user/remote-site data (collection titles, model slugs,
uploaded filenames) can contain characters that are illegal or dangerous in
an HTTP header: non-Latin-1 codepoints (Starlette encodes headers as
latin-1 and raises ``UnicodeEncodeError``), quotes that would break out of
the quoted-string, and CR/LF that would inject additional headers. RFC 6266
solves this with a plain ASCII fallback ``filename`` plus a
percent-encoded, UTF-8 ``filename*`` that modern browsers prefer.
"""

from __future__ import annotations

import re
import unicodedata
from urllib.parse import quote

_CONTROL_OR_INJECTION = re.compile(r"[\x00-\x1f\x7f\"\\/]")


def _ascii_fallback(name: str) -> str:
    """Best-effort ASCII-only rendering of ``name`` for the legacy
    ``filename`` parameter: strip accents where possible, drop anything
    left that isn't plain ASCII, and remove quotes, backslashes, path
    separators, and control/CR/LF characters that could break or inject
    into the header. Falls back to ``download`` if nothing usable remains.
    """
    normalized = unicodedata.normalize("NFKD", name)
    ascii_only = normalized.encode("ascii", "ignore").decode("ascii")
    cleaned = _CONTROL_OR_INJECTION.sub("", ascii_only).strip()
    return cleaned or "download"


def _content_disposition(disposition: str, name: str) -> str:
    fallback = _ascii_fallback(name)
    # `quote`'s default safe set already excludes CR/LF and quotes; also
    # exclude "/" so a title containing one can't look like a path segment.
    encoded = quote(name, safe="")
    return f"{disposition}; filename=\"{fallback}\"; filename*=UTF-8''{encoded}"


def content_disposition_attachment(name: str) -> str:
    """Build a ``Content-Disposition: attachment`` header value that's safe
    regardless of what ``name`` contains, per RFC 6266: an ASCII-only
    ``filename`` fallback for clients that don't understand ``filename*``,
    plus a percent-encoded UTF-8 ``filename*`` for clients that do.
    """
    return _content_disposition("attachment", name)


def content_disposition_inline(name: str) -> str:
    """Same as :func:`content_disposition_attachment`, but ``inline`` (R13c
    doc preview: pdf/txt/md render in the browser via ``?inline=1`` instead
    of downloading)."""
    return _content_disposition("inline", name)
