"""Org-scoped inventory routes (migrated from the old localStorage ledger).

Read access: any org member (including QA, read-only).
Write access: org_admin / sd / member (QA is read-only by design — GLP segregation).
Every change bumps `version` and writes an AuditLog entry with before/after snapshots.
"""
from __future__ import annotations

from flask import Blueprint, g, jsonify, request
from sqlalchemy import select

from audit import write_audit
from models import InventoryItem, Organization, utcnow
from security import login_required, org_role, can_use_org_data

bp = Blueprint("inventory", __name__, url_prefix="/api/orgs/<int:org_id>/inventory")

_MAXLEN = {
    "name": 200, "category": 40, "spec": 120, "qty": 40, "unit": 40,
    "location": 120, "expiry": 32, "low": 40, "vendor": 160, "batch": 120,
}


def _active_org(db, org_id: int) -> Organization | None:
    org = db.get(Organization, org_id)
    return None if (org is None or org.is_deleted) else org


def _clean_fields(data: dict) -> dict:
    out = {}
    for f in InventoryItem.FIELDS:
        if f in data:
            v = data[f]
            s = "" if v is None else str(v)
            if f != "note":
                s = s.strip()[: _MAXLEN.get(f, 255)]
            out[f] = s
    return out


def _read_guard(db, org_id: int):
    """Return (org, error_response). Member-or-above may read."""
    org = _active_org(db, org_id)
    if org is None:
        return None, (jsonify(ok=False, error="组织不存在"), 404)
    if org_role(db, g.user, org_id) is None:
        return None, (jsonify(ok=False, error="forbidden"), 403)
    return org, None


def _write_guard(db, org_id: int):
    org = _active_org(db, org_id)
    if org is None:
        return None, (jsonify(ok=False, error="组织不存在"), 404)
    if not can_use_org_data(db, g.user, org_id):
        return None, (jsonify(ok=False, error="forbidden"), 403)
    return org, None


@bp.get("")
@login_required
def list_items(org_id: int):
    db = g.db
    _, err = _read_guard(db, org_id)
    if err:
        return err
    rows = db.execute(
        select(InventoryItem).where(InventoryItem.org_id == org_id,
                                    InventoryItem.deleted_at.is_(None))
        .order_by(InventoryItem.created_at.desc(), InventoryItem.id.desc())
    ).scalars().all()
    return jsonify(ok=True, items=[r.to_dict() for r in rows],
                   canWrite=can_use_org_data(db, g.user, org_id))


@bp.post("")
@login_required
def create_item(org_id: int):
    db = g.db
    _, err = _write_guard(db, org_id)
    if err:
        return err
    data = request.get_json(silent=True) or {}
    fields = _clean_fields(data)
    if not fields.get("name"):
        return jsonify(ok=False, error="名称不能为空"), 400
    item = InventoryItem(org_id=org_id, created_by=g.user.id, version=1, **fields)
    db.add(item)
    db.flush()
    write_audit(db, actor=g.user, action="inventory.create", entity_type="inventory_item",
                entity_id=item.id, org_id=org_id, after=item.to_dict())
    db.commit()
    return jsonify(ok=True, item=item.to_dict()), 201


@bp.post("/bulk")
@login_required
def bulk_create(org_id: int):
    """Bulk import (one-time localStorage migration, or CSV/paste import)."""
    db = g.db
    _, err = _write_guard(db, org_id)
    if err:
        return err
    data = request.get_json(silent=True) or {}
    rows = data.get("items")
    if not isinstance(rows, list) or not rows:
        return jsonify(ok=False, error="没有可导入的数据"), 400
    created = []
    names = []
    for raw in rows[:5000]:
        if not isinstance(raw, dict):
            continue
        fields = _clean_fields(raw)
        if not fields.get("name"):
            continue
        item = InventoryItem(org_id=org_id, created_by=g.user.id, version=1, **fields)
        db.add(item)
        created.append(item)
        names.append(item.name)
    if not created:
        return jsonify(ok=False, error="没有有效数据行（每行需有名称）"), 400
    db.flush()
    write_audit(db, actor=g.user, action="inventory.bulk_import", entity_type="inventory_item",
                entity_id="", org_id=org_id,
                after={"count": len(created), "names": names[:200]})
    db.commit()
    return jsonify(ok=True, count=len(created), items=[c.to_dict() for c in created]), 201


@bp.patch("/<int:item_id>")
@login_required
def update_item(org_id: int, item_id: int):
    db = g.db
    _, err = _write_guard(db, org_id)
    if err:
        return err
    item = db.get(InventoryItem, item_id)
    if item is None or item.is_deleted or item.org_id != org_id:
        return jsonify(ok=False, error="条目不存在"), 404
    fields = _clean_fields(request.get_json(silent=True) or {})
    if not fields:
        return jsonify(ok=False, error="没有要更新的字段"), 400
    before = item.to_dict()
    for k, v in fields.items():
        setattr(item, k, v)
    item.version = (item.version or 1) + 1
    write_audit(db, actor=g.user, action="inventory.update", entity_type="inventory_item",
                entity_id=item.id, org_id=org_id, before=before, after=item.to_dict())
    db.commit()
    return jsonify(ok=True, item=item.to_dict())


@bp.delete("/<int:item_id>")
@login_required
def delete_item(org_id: int, item_id: int):
    db = g.db
    _, err = _write_guard(db, org_id)
    if err:
        return err
    item = db.get(InventoryItem, item_id)
    if item is None or item.is_deleted or item.org_id != org_id:
        return jsonify(ok=False, error="条目不存在"), 404
    reason = str((request.get_json(silent=True) or {}).get("reason", "")).strip()
    before = item.to_dict()
    item.deleted_at = utcnow()
    write_audit(db, actor=g.user, action="inventory.delete", entity_type="inventory_item",
                entity_id=item.id, org_id=org_id, before=before, reason=reason)
    db.commit()
    return jsonify(ok=True)


@bp.post("/bulk-update")
@login_required
def bulk_update(org_id: int):
    db = g.db
    _, err = _write_guard(db, org_id)
    if err:
        return err
    data = request.get_json(silent=True) or {}
    ids = data.get("ids") or []
    patch = _clean_fields(data.get("patch") or {})
    if not ids or not patch:
        return jsonify(ok=False, error="缺少 ids 或 patch"), 400
    updated = 0
    for item in db.execute(select(InventoryItem).where(
            InventoryItem.org_id == org_id, InventoryItem.id.in_(ids),
            InventoryItem.deleted_at.is_(None))).scalars().all():
        before = item.to_dict()
        for k, v in patch.items():
            setattr(item, k, v)
        item.version = (item.version or 1) + 1
        write_audit(db, actor=g.user, action="inventory.bulk_update", entity_type="inventory_item",
                    entity_id=item.id, org_id=org_id, before=before, after=item.to_dict())
        updated += 1
    db.commit()
    return jsonify(ok=True, count=updated)


@bp.post("/bulk-delete")
@login_required
def bulk_delete(org_id: int):
    db = g.db
    _, err = _write_guard(db, org_id)
    if err:
        return err
    data = request.get_json(silent=True) or {}
    ids = data.get("ids") or []
    reason = str(data.get("reason", "")).strip()
    if not ids:
        return jsonify(ok=False, error="缺少 ids"), 400
    now = utcnow()
    deleted = 0
    for item in db.execute(select(InventoryItem).where(
            InventoryItem.org_id == org_id, InventoryItem.id.in_(ids),
            InventoryItem.deleted_at.is_(None))).scalars().all():
        before = item.to_dict()
        item.deleted_at = now
        write_audit(db, actor=g.user, action="inventory.bulk_delete", entity_type="inventory_item",
                    entity_id=item.id, org_id=org_id, before=before, reason=reason)
        deleted += 1
    db.commit()
    return jsonify(ok=True, count=deleted)
