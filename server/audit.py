"""Audit trail and e-signature helpers (GLP / 21 CFR Part 11 scaffolding).

AuditLog rows are insert-only: nothing in the codebase updates or deletes them.
"""
from __future__ import annotations

import json

from models import AuditLog, Signature


def _dump(value) -> str:
    if value is None:
        return ""
    return json.dumps(value, ensure_ascii=False, default=str)


def write_audit(db, *, actor, action: str, entity_type: str = "", entity_id="",
                before=None, after=None, org_id=None, reason: str = "") -> AuditLog:
    """Append an audit entry. The caller is responsible for committing the session."""
    log = AuditLog(
        actor_id=getattr(actor, "id", None),
        actor_name=getattr(actor, "username", "") or "",
        org_id=org_id,
        action=action,
        entity_type=entity_type,
        entity_id="" if entity_id in ("", None) else str(entity_id),
        before=_dump(before),
        after=_dump(after),
        reason=reason or "",
    )
    db.add(log)
    return log


def record_signature(db, *, user, record_type: str, record_id, meaning: str) -> Signature:
    """Record an e-signature for a sensitive action (re-auth verified by the caller)."""
    sig = Signature(
        user_id=user.id,
        username=user.username,
        record_type=record_type,
        record_id="" if record_id in ("", None) else str(record_id),
        meaning=meaning,
    )
    db.add(sig)
    return sig


def verify_and_sign(db, *, user, password: str, record_type: str, record_id,
                    meaning: str) -> bool:
    """Re-authenticate with the user's password and, if valid, record an e-signature.

    Returns True when the password matches and the signature was recorded.
    Used to gate the most sensitive actions (21 CFR Part 11 style).
    """
    from security import verify_password  # local import avoids a circular dependency

    if not password or not verify_password(password, user.password_hash):
        return False
    record_signature(db, user=user, record_type=record_type, record_id=record_id,
                     meaning=meaning)
    return True
