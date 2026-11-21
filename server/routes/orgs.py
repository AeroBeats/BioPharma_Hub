"""Organization routes: create (via invite code), join (via org code), members, settings."""
from __future__ import annotations

from flask import Blueprint, g, jsonify, request
from sqlalchemy import select

from audit import write_audit, verify_and_sign
from codes import generate_org_code
from models import (
    AuditLog, InventoryItem, InviteCode, Membership, Organization, User,
    ROLE_ORG_ADMIN, ROLE_MEMBER, ORG_ROLES, utcnow,
)
from security import login_required, active_membership, org_role, can_manage_org

bp = Blueprint("orgs", __name__, url_prefix="/api/orgs")


def _active_org(db, org_id: int) -> Organization | None:
    org = db.get(Organization, org_id)
    if org is None or org.is_deleted:
        return None
    return org


def _unique_org_code(db) -> str:
    for _ in range(20):
        code = generate_org_code()
        hit = db.execute(select(Organization).where(Organization.org_code == code)).scalars().first()
        if hit is None:
            return code
    raise RuntimeError("无法生成唯一组织码，请重试")


def _member_count(db, org_id: int) -> int:
    return len(db.execute(
        select(Membership).where(Membership.org_id == org_id, Membership.deleted_at.is_(None))
    ).scalars().all())


def _admin_count(db, org_id: int) -> int:
    return len(db.execute(
        select(Membership).where(Membership.org_id == org_id,
                                 Membership.role == ROLE_ORG_ADMIN,
                                 Membership.deleted_at.is_(None))
    ).scalars().all())


@bp.post("")
@login_required
def create_org():
    """Register (create) an organization using a super-admin issued invite code."""
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "")).strip()[:160]
    description = str(data.get("description", "")).strip()
    invite_code = str(data.get("inviteCode", "")).strip().upper()

    if len(name) < 2:
        return jsonify(ok=False, error="组织名称至少 2 个字符"), 400
    if not invite_code:
        return jsonify(ok=False, error="请填写组织邀请码"), 400

    db = g.db
    invite = db.execute(
        select(InviteCode).where(InviteCode.code == invite_code, InviteCode.deleted_at.is_(None))
    ).scalars().first()
    if invite is None:
        return jsonify(ok=False, error="邀请码不存在"), 404
    if not invite.is_active():
        return jsonify(ok=False, error="邀请码已失效或已用完"), 400

    org = Organization(name=name, description=description,
                       org_code=_unique_org_code(db), created_by=g.user.id)
    db.add(org)
    db.flush()

    invite.use_count += 1
    membership = Membership(user_id=g.user.id, org_id=org.id, role=ROLE_ORG_ADMIN)
    db.add(membership)

    write_audit(db, actor=g.user, action="org.create", entity_type="organization",
                entity_id=org.id, org_id=org.id, after=org.to_dict())
    write_audit(db, actor=g.user, action="invite_code.use", entity_type="invite_code",
                entity_id=invite.id, org_id=org.id,
                after={"code": invite.code, "useCount": invite.use_count})
    write_audit(db, actor=g.user, action="membership.create", entity_type="membership",
                entity_id=membership.id, org_id=org.id,
                after={"userId": g.user.id, "role": ROLE_ORG_ADMIN})
    db.commit()
    return jsonify(ok=True, org=org.to_dict(), role=ROLE_ORG_ADMIN), 201


@bp.post("/join")
@login_required
def join_org():
    """Join an existing organization using its org code."""
    data = request.get_json(silent=True) or {}
    org_code = str(data.get("orgCode", "")).strip().upper()
    title = str(data.get("title", "")).strip()[:120]
    if not org_code:
        return jsonify(ok=False, error="请填写组织码"), 400

    db = g.db
    org = db.execute(
        select(Organization).where(Organization.org_code == org_code,
                                   Organization.deleted_at.is_(None))
    ).scalars().first()
    if org is None:
        return jsonify(ok=False, error="组织码无效或组织不存在"), 404

    existing = active_membership(db, g.user.id, org.id)
    if existing:
        return jsonify(ok=False, error="你已是该组织成员"), 409

    membership = Membership(user_id=g.user.id, org_id=org.id, role=ROLE_MEMBER, title=title)
    db.add(membership)
    db.flush()
    write_audit(db, actor=g.user, action="org.join", entity_type="membership",
                entity_id=membership.id, org_id=org.id,
                after={"userId": g.user.id, "orgCode": org_code, "role": ROLE_MEMBER})
    db.commit()
    return jsonify(ok=True, org=org.to_dict(), role=ROLE_MEMBER)


@bp.get("")
@login_required
def list_my_orgs():
    db = g.db
    stmt = (
        select(Membership, Organization)
        .join(Organization, Organization.id == Membership.org_id)
        .where(Membership.user_id == g.user.id,
               Membership.deleted_at.is_(None),
               Organization.deleted_at.is_(None))
        .order_by(Membership.created_at)
    )
    orgs = [{"org": o.to_dict(), "role": m.role, "title": m.title,
             "memberCount": _member_count(db, o.id)}
            for m, o in db.execute(stmt).all()]
    return jsonify(ok=True, orgs=orgs)


@bp.get("/<int:org_id>")
@login_required
def org_detail(org_id: int):
    db = g.db
    org = _active_org(db, org_id)
    if org is None:
        return jsonify(ok=False, error="组织不存在"), 404
    role = org_role(db, g.user, org_id)
    if role is None:
        return jsonify(ok=False, error="forbidden"), 403
    return jsonify(ok=True, org=org.to_dict(), role=role,
                   canManage=role in (ROLE_ORG_ADMIN,) or g.user.is_super_admin,
                   memberCount=_member_count(db, org_id))


@bp.patch("/<int:org_id>")
@login_required
def update_org(org_id: int):
    db = g.db
    org = _active_org(db, org_id)
    if org is None:
        return jsonify(ok=False, error="组织不存在"), 404
    if not can_manage_org(db, g.user, org_id):
        return jsonify(ok=False, error="forbidden"), 403
    data = request.get_json(silent=True) or {}
    before = org.to_dict()
    if "name" in data:
        name = str(data["name"]).strip()[:160]
        if len(name) < 2:
            return jsonify(ok=False, error="组织名称至少 2 个字符"), 400
        org.name = name
    if "description" in data:
        org.description = str(data["description"]).strip()
    write_audit(db, actor=g.user, action="org.update", entity_type="organization",
                entity_id=org.id, org_id=org.id, before=before, after=org.to_dict())
    db.commit()
    return jsonify(ok=True, org=org.to_dict())


@bp.post("/<int:org_id>/regenerate-code")
@login_required
def regenerate_code(org_id: int):
    db = g.db
    org = _active_org(db, org_id)
    if org is None:
        return jsonify(ok=False, error="组织不存在"), 404
    if not can_manage_org(db, g.user, org_id):
        return jsonify(ok=False, error="forbidden"), 403
    old = org.org_code
    org.org_code = _unique_org_code(db)
    write_audit(db, actor=g.user, action="org.regenerate_code", entity_type="organization",
                entity_id=org.id, org_id=org.id,
                before={"orgCode": old}, after={"orgCode": org.org_code})
    db.commit()
    return jsonify(ok=True, orgCode=org.org_code)


@bp.get("/<int:org_id>/members")
@login_required
def list_members(org_id: int):
    db = g.db
    org = _active_org(db, org_id)
    if org is None:
        return jsonify(ok=False, error="组织不存在"), 404
    role = org_role(db, g.user, org_id)
    if role is None:
        return jsonify(ok=False, error="forbidden"), 403
    stmt = (
        select(Membership, User)
        .join(User, User.id == Membership.user_id)
        .where(Membership.org_id == org_id, Membership.deleted_at.is_(None))
        .order_by(Membership.created_at)
    )
    members = []
    for m, u in db.execute(stmt).all():
        members.append({
            "membershipId": m.id, "userId": u.id, "username": u.username,
            "displayName": u.display_name, "role": m.role, "title": m.title,
            "isSuperAdmin": bool(u.is_super_admin),
            "joinedAt": m.created_at.isoformat() if m.created_at else None,
        })
    return jsonify(ok=True, members=members, canManage=can_manage_org(db, g.user, org_id))


@bp.patch("/<int:org_id>/members/<int:user_id>")
@login_required
def update_member(org_id: int, user_id: int):
    db = g.db
    org = _active_org(db, org_id)
    if org is None:
        return jsonify(ok=False, error="组织不存在"), 404
    if not can_manage_org(db, g.user, org_id):
        return jsonify(ok=False, error="forbidden"), 403
    m = active_membership(db, user_id, org_id)
    if m is None:
        return jsonify(ok=False, error="成员不存在"), 404
    data = request.get_json(silent=True) or {}
    before = m.to_dict()

    if "role" in data:
        new_role = str(data["role"]).strip()
        if new_role not in ORG_ROLES:
            return jsonify(ok=False, error="无效角色"), 400
        if new_role != ROLE_ORG_ADMIN and m.role == ROLE_ORG_ADMIN and _admin_count(db, org_id) <= 1:
            return jsonify(ok=False, error="不能降级最后一名组织管理员"), 400
        m.role = new_role
    if "title" in data:
        m.title = str(data["title"]).strip()[:120]

    write_audit(db, actor=g.user, action="membership.update", entity_type="membership",
                entity_id=m.id, org_id=org_id, before=before, after=m.to_dict())
    db.commit()
    return jsonify(ok=True, member=m.to_dict())


@bp.delete("/<int:org_id>/members/<int:user_id>")
@login_required
def remove_member(org_id: int, user_id: int):
    db = g.db
    org = _active_org(db, org_id)
    if org is None:
        return jsonify(ok=False, error="组织不存在"), 404
    if not can_manage_org(db, g.user, org_id):
        return jsonify(ok=False, error="forbidden"), 403
    m = active_membership(db, user_id, org_id)
    if m is None:
        return jsonify(ok=False, error="成员不存在"), 404
    if m.role == ROLE_ORG_ADMIN and _admin_count(db, org_id) <= 1:
        return jsonify(ok=False, error="不能移除最后一名组织管理员"), 400
    reason = str((request.get_json(silent=True) or {}).get("reason", "")).strip()
    before = m.to_dict()
    m.deleted_at = utcnow()
    write_audit(db, actor=g.user, action="membership.remove", entity_type="membership",
                entity_id=m.id, org_id=org_id, before=before, reason=reason)
    db.commit()
    return jsonify(ok=True)


@bp.post("/<int:org_id>/leave")
@login_required
def leave_org(org_id: int):
    db = g.db
    m = active_membership(db, g.user.id, org_id)
    if m is None:
        return jsonify(ok=False, error="你不在该组织中"), 404
    if m.role == ROLE_ORG_ADMIN and _admin_count(db, org_id) <= 1:
        return jsonify(ok=False, error="组织需保留至少一名管理员，请先移交或联系超级管理员"), 400
    before = m.to_dict()
    m.deleted_at = utcnow()
    write_audit(db, actor=g.user, action="org.leave", entity_type="membership",
                entity_id=m.id, org_id=org_id, before=before)
    db.commit()
    return jsonify(ok=True)


@bp.delete("/<int:org_id>")
@login_required
def delete_org(org_id: int):
    """Soft-delete an organization (org_admin with e-signature, or super admin)."""
    db = g.db
    org = _active_org(db, org_id)
    if org is None:
        return jsonify(ok=False, error="组织不存在"), 404
    is_super = g.user.is_super_admin
    if not (is_super or can_manage_org(db, g.user, org_id)):
        return jsonify(ok=False, error="forbidden"), 403

    data = request.get_json(silent=True) or {}
    reason = str(data.get("reason", "")).strip()
    password = str(data.get("password", ""))
    # E-signature gate: deleting an org is destructive and requires password re-auth.
    if not verify_and_sign(db, user=g.user, password=password, record_type="organization",
                           record_id=org.id, meaning="approve_organization_deletion"):
        return jsonify(ok=False, error="删除组织需输入你的登录密码以电子签名确认"), 400

    now = utcnow()
    before = org.to_dict()
    org.deleted_at = now
    for m in db.execute(select(Membership).where(
            Membership.org_id == org_id, Membership.deleted_at.is_(None))).scalars().all():
        m.deleted_at = now
    for it in db.execute(select(InventoryItem).where(
            InventoryItem.org_id == org_id, InventoryItem.deleted_at.is_(None))).scalars().all():
        it.deleted_at = now
    write_audit(db, actor=g.user, action="org.delete", entity_type="organization",
                entity_id=org.id, org_id=org_id, before=before, reason=reason)
    db.commit()
    return jsonify(ok=True)


@bp.get("/<int:org_id>/audit")
@login_required
def org_audit(org_id: int):
    """Audit trail for an org — visible to org_admin and QA (GLP transparency)."""
    db = g.db
    org = _active_org(db, org_id)
    if org is None:
        return jsonify(ok=False, error="组织不存在"), 404
    role = org_role(db, g.user, org_id)
    if role not in (ROLE_ORG_ADMIN, "qa") and not g.user.is_super_admin:
        return jsonify(ok=False, error="forbidden"), 403
    limit = min(int(request.args.get("limit", 200)), 1000)
    rows = db.execute(
        select(AuditLog).where(AuditLog.org_id == org_id)
        .order_by(AuditLog.created_at.desc(), AuditLog.id.desc()).limit(limit)
    ).scalars().all()
    return jsonify(ok=True, entries=[r.to_dict() for r in rows])
