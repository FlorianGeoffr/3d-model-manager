"""``app.services.http_names.content_disposition_attachment`` (R11 review
finding 2): a `Content-Disposition` value that's safe to hand to
Starlette's latin-1 header encoder no matter what a remote-site title or
uploaded filename contains.
"""

from __future__ import annotations

from app.services.http_names import content_disposition_attachment


def test_plain_ascii_name_round_trips() -> None:
    header = content_disposition_attachment("model.zip")
    assert header == "attachment; filename=\"model.zip\"; filename*=UTF-8''model.zip"


def test_cjk_title_gets_ascii_fallback_and_percent_encoded_star() -> None:
    header = content_disposition_attachment("日本モデル.zip")
    # Must be latin-1 encodable (what Starlette actually enforces) and must
    # not raise -- the whole point of the fix.
    header.encode("latin-1")
    assert 'filename="' in header
    assert "filename*=UTF-8''%E6%97%A5%E6%9C%AC%E3%83%A2%E3%83%87%E3%83%AB.zip" in header


def test_emoji_title_has_no_control_or_non_ascii_in_fallback() -> None:
    header = content_disposition_attachment("🎉party.zip")
    fallback = header.split('filename="')[1].split('"')[0]
    assert fallback.isascii()
    header.encode("latin-1")


def test_quote_in_title_is_stripped_from_fallback_and_kept_safe_in_star() -> None:
    header = content_disposition_attachment('evil".zip')
    fallback = header.split('filename="')[1].split('"; filename*=')[0]
    assert '"' not in fallback
    header.encode("latin-1")
    assert "\r" not in header and "\n" not in header


def test_crlf_in_title_cannot_inject_headers() -> None:
    header = content_disposition_attachment("evil\r\nX-Injected: yes.zip")
    assert "\r" not in header
    assert "\n" not in header


def test_slash_in_title_does_not_look_like_a_path() -> None:
    header = content_disposition_attachment("a/b.zip")
    fallback = header.split('filename="')[1].split('"; filename*=')[0]
    assert "/" not in fallback
