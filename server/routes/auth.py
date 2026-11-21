"""Auth routes: register, login, current user, change password."""
from __future__ import annotations

import re

from flask import Blueprint, g, jsonify, request
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from audit import write_audit
from models import Membership, Organization, User
from security import (
    hash_password, verify_password, issue_token, login_required, active_membership,
)

bp = Blueprint("auth", __name__, url_prefix="/api/auth")

_USERNAME_RE = re.compile(r"^[A-Za-z0-9_\u4e00-\u9fa5]{3,32}$")
MIN_PASSWORD = 8


def _my_orgs(db, user: User) -> list[dict]:
    stmt = (
        select(Membership, Organization)
        .join(Organization, Organization.id == Membership.org_id)
        .where(Membership.user_id == user.id,
               Membership.deleted_at.is_(None),
               Organization.deleted_at.is_(None))
        .order_by(Membership.created_at)
    )
    out = []
    for m, org in db.execute(stmt).all():
        out.append({"org": org.to_dict(), "role": m.role, "title": m.title,
                    "membershipId": m.id})
    return out


def _auth_payload(db, user: User) -> dict:
    return {"token": issue_token(user), "user": user.to_dict(), "orgs": _my_orgs(db, user)}


@bp.post("/register")
def register():
    data = request.get_json(silent=True) or {}
    username = str(data.get("username", "")).strip()
    password = str(data.get("password", ""))
    display_name = str(data.get("displayName", "")).strip()[:120]

    if not _USERNAME_RE.match(username):
        return jsonify(ok=False, error="用户名需为 3-32 位字母、数字、下划线或中文"), 400
    if len(password) < MIN_PASSWORD:
        return jsonify(ok=False, error=f"密码至少 {MIN_PASSWORD} 位"), 400

    db = g.db
    exists = db.execute(
        select(User).where(User.username == username, User.deleted_at.is_(None))
    ).scalars().first()
    if exists:
        return jsonify(ok=False, error="用户名已被占用"), 409

    user = User(username=username, password_hash=hash_password(password),
                display_name=display_name or username)
    db.add(user)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        return jsonify(ok=False, error="用户名已被占用"), 409
    write_audit(db, actor=user, action="user.register", entity_type="user", entity_id=user.id,
                after={"username": user.username})
    db.commit()
    return jsonify(ok=True, **_auth_payload(db, user)), 201


@bp.post("/login")
def login():
    data = request.get_json(silent=True) or {}
    username = str(data.get("username", "")).strip()
    password = str(data.get("password", ""))

    db = g.db
    user = db.execute(
        select(User).where(User.username == username, User.deleted_at.is_(None))
    ).scalars().first()
    if user is None or not verify_password(password, user.password_hash):
        return jsonify(ok=False, error="用户名或密码错误"), 401
    if user.disabled:
        return jsonify(ok=False, error="账号已被禁用，请联系管理员"), 403

    write_audit(db, actor=user, action="user.login", entity_type="user", entity_id=user.id)
    db.commit()
    return jsonify(ok=True, **_auth_payload(db, user))


@bp.get("/me")
@login_required
def me():
    db = g.db
    return jsonify(ok=True, user=g.user.to_dict(), orgs=_my_orgs(db, g.user))


@bp.post("/password")
@login_required
def change_password():
    data = request.get_json(silent=True) or {}
    old = str(data.get("oldPassword", ""))
    new = str(data.get("newPassword", ""))
    if not verify_password(old, g.user.password_hash):
        return jsonify(ok=False, error="原密码不正确"), 400
    if len(new) < MIN_PASSWORD:
        return jsonify(ok=False, error=f"新密码至少 {MIN_PASSWORD} 位"), 400
    db = g.db
    g.user.password_hash = hash_password(new)
    write_audit(db, actor=g.user, action="user.change_password", entity_type="user",
                entity_id=g.user.id)
    db.commit()
    return jsonify(ok=True)
