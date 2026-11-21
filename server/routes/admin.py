"""Super-admin routes: user management, invite codes, organization overview."""
from __future__ import annotations

import datetime as dt

from flask import Blueprint, g, jsonify, request
from sqlalchemy import select, func

from audit import write_audit, verify_and_sign
from codes import generate_invite_code
from models import (
    InventoryItem, InviteCode, Membership, Organization, User, utcnow,
)
from security import hash_password, super_admin_required

bp = Blueprint("admin", __name__, url_prefix="/api/admin")


def _unique_invite_code(db) -> str:
    for _ in range(20):
        code = generate_invite_code()
        hit = db.execute(select(InviteCode).where(InviteCode.code == code)).scalars().first()
        if hit is None:
            return code
    raise RuntimeError("无法生成唯一邀请码，请重试")


def _super_admin_count(db) -> int:
    return db.execute(
        select(func.count()).select_from(User).where(
            User.is_super_admin.is_(True), User.deleted_at.is_(None))
    ).scalar_one()


# --- users -------------------------------------------------------------------
@bp.get("/users")
@super_admin_required
def list_users():
    db = g.db
    q = str(request.args.get("q", "")).strip()
    stmt = select(User).where(User.deleted_at.is_(None)).order_by(User.created_at.desc())
    if q:
        like = f"%{q}%"
        stmt = stmt.where(User.username.ilike(like) | User.display_name.ilike(like))
    users = db.execute(stmt).scalars().all()
    org_counts = dict(
        db.execute(
            select(Membership.user_id, func.count())
            .where(Membership.deleted_at.is_(None))
            .group_by(Membership.user_id)
        ).all()
    )
    out = []
    for u in users:
        d = u.to_dict()
        d["orgCount"] = org_counts.get(u.id, 0)
        out.append(d)
    return jsonify(ok=True, users=out)


@bp.patch("/users/<int:user_id>")
@super_admin_required
def update_user(user_id: int):
    db = g.db
    user = db.get(User, user_id)
    if user is None or user.is_deleted:
        return jsonify(ok=False, error="用户不存在"), 404
    data = request.get_json(silent=True) or {}
    before = user.to_dict()
    sensitive = False

    if "displayName" in data:
        user.display_name = str(data["displayName"]).strip()[:120]
    if "isSuperAdmin" in data:
        want = bool(data["isSuperAdmin"])
        if want is False and user.is_super_admin and _super_admin_count(db) <= 1:
            return jsonify(ok=False, error="不能撤销最后一名超级管理员"), 400
        if user.id == g.user.id and want is False:
            return jsonify(ok=False, error="不能撤销自己的超级管理员权限"), 400
        user.is_super_admin = want
        sensitive = True
    if "disabled" in data:
        want = bool(data["disabled"])
        if user.id == g.user.id and want:
            return jsonify(ok=False, error="不能禁用自己"), 400
        user.disabled = want
        sensitive = True

    if sensitive:
        password = str(data.get("password", ""))
        if not verify_and_sign(db, user=g.user, password=password, record_type="user",
                               record_id=user.id, meaning="approve_user_privilege_change"):
            return jsonify(ok=False, error="此操作需输入你的登录密码以电子签名确认"), 400

    write_audit(db, actor=g.user, action="admin.user.update", entity_type="user",
                entity_id=user.id, before=before, after=user.to_dict())
    db.commit()
    return jsonify(ok=True, user=user.to_dict())


@bp.post("/users/<int:user_id>/reset-password")
@super_admin_required
def reset_password(user_id: int):
    db = g.db
    user = db.get(User, user_id)
    if user is None or user.is_deleted:
        return jsonify(ok=False, error="用户不存在"), 404
    data = request.get_json(silent=True) or {}
    new_pw = str(data.get("newPassword", ""))
    if len(new_pw) < 8:
        return jsonify(ok=False, error="新密码至少 8 位"), 400
    user.password_hash = hash_password(new_pw)
    write_audit(db, actor=g.user, action="admin.user.reset_password", entity_type="user",
                entity_id=user.id)
    db.commit()
    return jsonify(ok=True)


@bp.delete("/users/<int:user_id>")
@super_admin_required
def delete_user(user_id: int):
    db = g.db
    user = db.get(User, user_id)
    if user is None or user.is_deleted:
        return jsonify(ok=False, error="用户不存在"), 404
    if user.id == g.user.id:
        return jsonify(ok=False, error="不能删除自己"), 400
    if user.is_super_admin and _super_admin_count(db) <= 1:
        return jsonify(ok=False, error="不能删除最后一名超级管理员"), 400
    data = request.get_json(silent=True) or {}
    if not verify_and_sign(db, user=g.user, password=str(data.get("password", "")),
                           record_type="user", record_id=user.id,
                           meaning="approve_user_deletion"):
        return jsonify(ok=False, error="删除用户需输入你的登录密码以电子签名确认"), 400
    before = user.to_dict()
    user.deleted_at = utcnow()
    for m in db.execute(select(Membership).where(
            Membership.user_id == user.id, Membership.deleted_at.is_(None))).scalars().all():
        m.deleted_at = utcnow()
    write_audit(db, actor=g.user, action="admin.user.delete", entity_type="user",
                entity_id=user.id, before=before, reason=str(data.get("reason", "")).strip())
    db.commit()
    return jsonify(ok=True)


# --- organizations -----------------------------------------------------------
@bp.get("/orgs")
@super_admin_required
def list_orgs():
    db = g.db
    orgs = db.execute(
        select(Organization).where(Organization.deleted_at.is_(None)).order_by(Organization.created_at.desc())
    ).scalars().all()
    counts = dict(
        db.execute(
            select(Membership.org_id, func.count())
            .where(Membership.deleted_at.is_(None))
            .group_by(Membership.org_id)
        ).all()
    )
    out = []
    for o in orgs:
        d = o.to_dict()
        d["memberCount"] = counts.get(o.id, 0)
        out.append(d)
    return jsonify(ok=True, orgs=out)


# --- invite codes ------------------------------------------------------------
@bp.get("/invite-codes")
@super_admin_required
def list_invite_codes():
    db = g.db
    rows = db.execute(
        select(InviteCode).where(InviteCode.deleted_at.is_(None))
        .order_by(InviteCode.created_at.desc())
    ).scalars().all()
    return jsonify(ok=True, codes=[r.to_dict() for r in rows])


@bp.post("/invite-codes")
@super_admin_required
def create_invite_code():
    db = g.db
    data = request.get_json(silent=True) or {}
    note = str(data.get("note", "")).strip()[:255]
    max_uses = max(1, min(int(data.get("maxUses", 1) or 1), 1000))
    expires_in = data.get("expiresInDays")
    expires_at = None
    if expires_in not in (None, "", 0):
        try:
            days = int(expires_in)
            if days > 0:
                expires_at = utcnow() + dt.timedelta(days=days)
        except (TypeError, ValueError):
            pass
    code = InviteCode(code=_unique_invite_code(db), note=note, created_by=g.user.id,
                      max_uses=max_uses, expires_at=expires_at)
    db.add(code)
    db.flush()
    write_audit(db, actor=g.user, action="admin.invite_code.create", entity_type="invite_code",
                entity_id=code.id, after=code.to_dict())
    db.commit()
    return jsonify(ok=True, code=code.to_dict()), 201


@bp.delete("/invite-codes/<int:code_id>")
@super_admin_required
def revoke_invite_code(code_id: int):
    db = g.db
    code = db.get(InviteCode, code_id)
    if code is None or code.is_deleted:
        return jsonify(ok=False, error="邀请码不存在"), 404
    before = code.to_dict()
    code.deleted_at = utcnow()
    write_audit(db, actor=g.user, action="admin.invite_code.revoke", entity_type="invite_code",
                entity_id=code.id, before=before)
    db.commit()
    return jsonify(ok=True)


@bp.get("/stats")
@super_admin_required
def stats():
    db = g.db
    users = db.execute(select(func.count()).select_from(User).where(User.deleted_at.is_(None))).scalar_one()
    orgs = db.execute(select(func.count()).select_from(Organization).where(Organization.deleted_at.is_(None))).scalar_one()
    items = db.execute(select(func.count()).select_from(InventoryItem)
                       .where(InventoryItem.deleted_at.is_(None))).scalar_one()
    return jsonify(ok=True, users=int(users), orgs=int(orgs), inventoryItems=int(items))
