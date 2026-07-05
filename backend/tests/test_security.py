"""Argon2id hashing helpers (SPEC requirement 1: single admin login)."""

from app.security import DUMMY_HASH, hash_password, verify_password


def test_hash_password_round_trips() -> None:
    hashed = hash_password("correct horse battery staple")

    assert hashed != "correct horse battery staple"
    assert verify_password("correct horse battery staple", hashed) is True


def test_verify_password_rejects_wrong_password() -> None:
    hashed = hash_password("correct horse battery staple")

    assert verify_password("wrong password", hashed) is False


def test_verify_password_never_raises_on_garbage_hash() -> None:
    assert verify_password("anything", "not-a-real-argon2-hash") is False


def test_dummy_hash_is_a_real_verifiable_argon2_hash() -> None:
    """``DUMMY_HASH`` exists so a login for an unknown username can still
    pay the cost of a real argon2 verification (see app.api.auth.login) --
    it must actually be checkable, just never match anything real.
    """
    assert DUMMY_HASH.startswith("$argon2id$")
    assert verify_password("whatever", DUMMY_HASH) is False
