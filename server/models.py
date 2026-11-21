"""SQLAlchemy models for BioPharma Hub.

GLP-aligned design principles baked in from day one:
- Server-side timestamps (created_at/updated_at use the backend clock, never the client).
- Soft delete: records are never physically removed; deleted_at marks retirement.
- Versioning: mutable business records carry an integer `version` bumped on each change,
  and every change is mirrored into the append-only AuditLog (before/after snapshots).
- AuditLog is insert-only (no update/delete anywhere in the codebase).
- Signature provides 21 CFR Part 11 style e-signature scaffolding for sensitive actions.
"""
from __future__ import annotations

import datetime as dt

from sqlalchemy import (
    Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, Index,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


# Org-level membership roles. Super admin is a global flag on User, not a membership role.
ROLE_ORG_ADMIN = "org_admin"   # manages the org, members, codes, data
ROLE_QA = "qa"                 # GLP quality assurance: read + audit, cannot edit data
ROLE_SD = "sd"                 # GLP study director
ROLE_MEMBER = "member"         # ordinary user: uses org data
ORG_ROLES = (ROLE_ORG_ADMIN, ROLE_QA, ROLE_SD, ROLE_MEMBER)
# Roles allowed to manage an org and its members.
ORG_MANAGE_ROLES = (ROLE_ORG_ADMIN,)
# Roles allowed to read/write org experiment data (inventory).
ORG_DATA_ROLES = (ROLE_ORG_ADMIN, ROLE_SD, ROLE_MEMBER)


class Base(DeclarativeBase):
    pass


class TimestampMixin:
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)


class SoftDeleteMixin:
    deleted_at: Mapped[dt.datetime | None] = mapped_column(
        DateTime(timezone=True), default=None, nullable=True)

    @property
    def is_deleted(self) -> bool:
        return self.deleted_at is not None


class User(Base, TimestampMixin, SoftDeleteMixin):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    display_name: Mapped[str] = mapped_column(String(120), default="", nullable=False)
    is_super_admin: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    disabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    def to_dict(self, include_admin: bool = True) -> dict:
        d = {
            "id": self.id,
            "username": self.username,
            "displayName": self.display_name,
        }
        if include_admin:
            d["isSuperAdmin"] = bool(self.is_super_admin)
            d["disabled"] = bool(self.disabled)
            d["createdAt"] = self.created_at.isoformat() if self.created_at else None
        return d


class Organization(Base, TimestampMixin, SoftDeleteMixin):
    __tablename__ = "organizations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    org_code: Mapped[str] = mapped_column(String(32), unique=True, nullable=False, index=True)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "orgCode": self.org_code,
            "createdBy": self.created_by,
            "createdAt": self.created_at.isoformat() if self.created_at else None,
        }


class Membership(Base, TimestampMixin, SoftDeleteMixin):
    __tablename__ = "memberships"
    __table_args__ = (
        UniqueConstraint("user_id", "org_id", name="uq_membership_user_org"),
        Index("ix_membership_org", "org_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), nullable=False)
    role: Mapped[str] = mapped_column(String(20), default=ROLE_MEMBER, nullable=False)
    title: Mapped[str] = mapped_column(String(120), default="", nullable=False)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "userId": self.user_id,
            "orgId": self.org_id,
            "role": self.role,
            "title": self.title,
            "joinedAt": self.created_at.isoformat() if self.created_at else None,
        }


class InviteCode(Base, TimestampMixin, SoftDeleteMixin):
    """Code issued by a super admin; consumed to register (create) an organization."""
    __tablename__ = "invite_codes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(32), unique=True, nullable=False, index=True)
    note: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    expires_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    max_uses: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    use_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    def is_active(self) -> bool:
        if self.is_deleted:
            return False
        if self.max_uses and self.use_count >= self.max_uses:
            return False
        if self.expires_at is not None:
            exp = self.expires_at
            if exp.tzinfo is None:
                exp = exp.replace(tzinfo=dt.timezone.utc)
            if exp < utcnow():
                return False
        return True

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "code": self.code,
            "note": self.note,
            "createdBy": self.created_by,
            "expiresAt": self.expires_at.isoformat() if self.expires_at else None,
            "maxUses": self.max_uses,
            "useCount": self.use_count,
            "active": self.is_active(),
            "createdAt": self.created_at.isoformat() if self.created_at else None,
        }


class InventoryItem(Base, TimestampMixin, SoftDeleteMixin):
    """Org-scoped reagent/consumable ledger row (migrated from the old localStorage store)."""
    __tablename__ = "inventory_items"
    __table_args__ = (Index("ix_inventory_org", "org_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(200), default="", nullable=False)
    category: Mapped[str] = mapped_column(String(40), default="", nullable=False)
    spec: Mapped[str] = mapped_column(String(120), default="", nullable=False)
    qty: Mapped[str] = mapped_column(String(40), default="", nullable=False)
    unit: Mapped[str] = mapped_column(String(40), default="", nullable=False)
    location: Mapped[str] = mapped_column(String(120), default="", nullable=False)
    expiry: Mapped[str] = mapped_column(String(32), default="", nullable=False)
    low: Mapped[str] = mapped_column(String(40), default="", nullable=False)
    note: Mapped[str] = mapped_column(Text, default="", nullable=False)
    vendor: Mapped[str] = mapped_column(String(160), default="", nullable=False)
    batch: Mapped[str] = mapped_column(String(120), default="", nullable=False)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)

    # Field names accepted from the API / CSV, mapped to columns.
    FIELDS = ("name", "category", "spec", "qty", "unit", "location",
              "expiry", "low", "note", "vendor", "batch")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "orgId": self.org_id,
            "name": self.name,
            "category": self.category,
            "spec": self.spec,
            "qty": self.qty,
            "unit": self.unit,
            "location": self.location,
            "expiry": self.expiry,
            "low": self.low,
            "note": self.note,
            "vendor": self.vendor,
            "batch": self.batch,
            "version": self.version,
            "createdBy": self.created_by,
            "createdAt": self.created_at.isoformat() if self.created_at else None,
            "updatedAt": self.updated_at.isoformat() if self.updated_at else None,
        }


class AuditLog(Base):
    """Append-only audit trail. NEVER updated or deleted (GLP / ALCOA+)."""
    __tablename__ = "audit_log"
    __table_args__ = (
        Index("ix_audit_org", "org_id"),
        Index("ix_audit_entity", "entity_type", "entity_id"),
        Index("ix_audit_actor", "actor_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False)
    actor_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    actor_name: Mapped[str] = mapped_column(String(64), default="", nullable=False)
    org_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(40), default="", nullable=False)
    entity_id: Mapped[str] = mapped_column(String(64), default="", nullable=False)
    before: Mapped[str] = mapped_column(Text, default="", nullable=False)
    after: Mapped[str] = mapped_column(Text, default="", nullable=False)
    reason: Mapped[str] = mapped_column(Text, default="", nullable=False)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "createdAt": self.created_at.isoformat() if self.created_at else None,
            "actorId": self.actor_id,
            "actorName": self.actor_name,
            "orgId": self.org_id,
            "action": self.action,
            "entityType": self.entity_type,
            "entityId": self.entity_id,
            "before": self.before,
            "after": self.after,
            "reason": self.reason,
        }


class Signature(Base):
    """21 CFR Part 11 style e-signature record for a sensitive action."""
    __tablename__ = "signatures"
    __table_args__ = (Index("ix_signature_record", "record_type", "record_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    username: Mapped[str] = mapped_column(String(64), default="", nullable=False)
    record_type: Mapped[str] = mapped_column(String(40), nullable=False)
    record_id: Mapped[str] = mapped_column(String(64), default="", nullable=False)
    meaning: Mapped[str] = mapped_column(String(120), default="", nullable=False)
    signed_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "userId": self.user_id,
            "username": self.username,
            "recordType": self.record_type,
            "recordId": self.record_id,
            "meaning": self.meaning,
            "signedAt": self.signed_at.isoformat() if self.signed_at else None,
        }
