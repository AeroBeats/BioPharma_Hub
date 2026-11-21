"""Invite / organization code generation.

Uses an unambiguous alphabet (no 0/O/1/I) because codes are typed by humans.
Uniqueness against the database is enforced by the caller in a retry loop.
"""
from __future__ import annotations

import secrets

_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def random_code(prefix: str, length: int = 10) -> str:
    body = "".join(secrets.choice(_ALPHABET) for _ in range(length))
    return f"{prefix}{body}"


def generate_invite_code() -> str:
    return random_code("INV-", 10)


def generate_org_code() -> str:
    return random_code("ORG-", 10)
