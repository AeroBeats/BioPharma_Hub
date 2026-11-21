"""Password hashing, JWT, and auth/role decorators."""
from __future__ import annotations

import datetime as dt
import functools

import bcrypt
import jwt
from flask import g, jsonify, request
from sqlalchemy import select

from config import Config
from models import (
    Membership, User, ROLE_ORG_ADMIN, ORG_MANAGE_ROLES, ORG_DATA_ROLES,
)


# --- passwords ---------------------------------------------------------------
def _pw_bytes(pw: str) -> bytes:
    # bcrypt only considers the first 72 bytes; newer bcrypt raises on longer input.
    return pw.encode("utf-8")[:72]


def hash_password(pw: str) -> str:
    return bcrypt.hashpw(_pw_bytes(pw), bcrypt.gensalt()).decode("utf-8")


def verify_password(pw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(_pw_bytes(pw), hashed.encode("utf-8"))
    except Exception:
        return False


# --- JWT ---------------------------------------------------------------------
def issue_token(user: User) -> str:
    now = dt.datetime.now(dt.timezone.utc)
    payload = {
        "sub": str(user.id),
        "username": user.username,
        "iat": now,
        "exp": now + dt.timedelta(days=Config.JWT_EXPIRES_DAYS),
    }
    return jwt.encode(payload, Config.JWT_SECRET, algorithm=Config.JWT_ALGORITHM)


def decode_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, Config.JWT_SECRET, algorithms=[Config.JWT_ALGORITHM])
    except jwt.PyJWTError:
        return None


def _bearer_token() -> str | None:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:].strip()
    return None


# --- org permission helpers --------------------------------------------------
def active_membership(db, user_id: int, org_id: int) -> Membership | None:
    stmt = select(Membership).where(
        Membership.user_id == user_id,
        Membership.org_id == org_id,
        Membership.deleted_at.is_(None),
    )
    return db.execute(stmt).scalars().first()


def org_role(db, user: User, org_id: int) -> str | None:
    """Effective role of `user` in `org_id`. Super admins act as org_admin everywhere."""
    if user.is_super_admin:
        return ROLE_ORG_ADMIN
    m = active_membership(db, user.id, org_id)
    return m.role if m else None


def can_manage_org(db, user: User, org_id: int) -> bool:
    return org_role(db, user, org_id) in ORG_MANAGE_ROLES


def can_use_org_data(db, user: User, org_id: int) -> bool:
    return org_role(db, user, org_id) in ORG_DATA_ROLES


# --- decorators --------------------------------------------------------------
def login_required(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        token = _bearer_token()
        if not token:
            return jsonify(ok=False, error="unauthorized"), 401
        payload = decode_token(token)
        if not payload:
            return jsonify(ok=False, error="invalid_token"), 401
        db = g.db
        user = db.get(User, int(payload["sub"]))
        if user is None or user.is_deleted or user.disabled:
            return jsonify(ok=False, error="invalid_token"), 401
        g.user = user
        return fn(*args, **kwargs)
    return wrapper


def super_admin_required(fn):
    @functools.wraps(fn)
    @login_required
    def wrapper(*args, **kwargs):
        if not g.user.is_super_admin:
            return jsonify(ok=False, error="forbidden"), 403
        return fn(*args, **kwargs)
    return wrapper
