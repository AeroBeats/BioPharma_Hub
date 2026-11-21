"""End-to-end backend smoke test (runs against a throwaway SQLite DB).

Usage:  python smoke_test.py
Exercises the full GLP-aligned flow: auth, invite-code org creation, org-code join,
role permissions, org-scoped inventory CRUD/bulk, audit trail, e-signature gates,
and last-admin guards. Prints PASS/FAIL per check and exits non-zero on any failure.
"""
from __future__ import annotations

import os
import sys
import tempfile

# Fresh throwaway DB before importing the app.
_tmp = tempfile.mkdtemp(prefix="bph_smoke_")
os.environ["DB_BACKEND"] = "sqlite"
os.environ["SQLITE_PATH"] = os.path.join(_tmp, "smoke.db")
os.environ["JWT_SECRET"] = "smoke-test-secret"
os.environ["ALLOWED_ORIGINS"] = "http://localhost"

from app import app  # noqa: E402
from db import init_db, SessionLocal  # noqa: E402
from models import User  # noqa: E402
from security import hash_password  # noqa: E402

FAILURES = []


def check(name: str, cond: bool, extra=""):
    status = "PASS" if cond else "FAIL"
    if not cond:
        FAILURES.append(name)
    print(f"[{status}] {name}" + (f"  -> {extra}" if extra and not cond else ""))


def bootstrap_super_admin(username="root", password="rootpass123"):
    init_db()
    db = SessionLocal()
    try:
        u = User(username=username, password_hash=hash_password(password),
                 display_name="Root", is_super_admin=True)
        db.add(u)
        db.commit()
    finally:
        db.close()


client = app.test_client()


def call(method, path, token=None, json=None):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    fn = getattr(client, method)
    return fn(path, headers=headers, json=json)


def body(resp):
    try:
        return resp.get_json()
    except Exception:
        return {}


def main():
    bootstrap_super_admin()

    # health
    r = call("get", "/health")
    check("health ok", r.status_code == 200 and body(r).get("ok") is True)

    # register two normal users
    r = call("post", "/api/auth/register", json={"username": "alice", "password": "alicepass1", "displayName": "Alice"})
    check("register alice", r.status_code == 201 and body(r).get("token"), str(body(r)))
    alice = body(r).get("token")
    r = call("post", "/api/auth/register", json={"username": "bob", "password": "bobpass123"})
    check("register bob", r.status_code == 201 and body(r).get("token"))
    bob = body(r).get("token")

    # duplicate + weak password
    r = call("post", "/api/auth/register", json={"username": "alice", "password": "anotherpass1"})
    check("duplicate username rejected", r.status_code == 409)
    r = call("post", "/api/auth/register", json={"username": "carol", "password": "short"})
    check("weak password rejected", r.status_code == 400)

    # login
    r = call("post", "/api/auth/login", json={"username": "alice", "password": "wrong"})
    check("login wrong password rejected", r.status_code == 401)
    r = call("post", "/api/auth/login", json={"username": "root", "password": "rootpass123"})
    check("login root", r.status_code == 200 and body(r).get("token"))
    root = body(r).get("token")

    # me
    r = call("get", "/api/auth/me", token=alice)
    check("me returns alice", body(r).get("user", {}).get("username") == "alice")
    r = call("get", "/api/auth/me")
    check("me without token 401", r.status_code == 401)

    # non-admin cannot access admin
    r = call("get", "/api/admin/users", token=alice)
    check("admin endpoint forbidden for user", r.status_code == 403)

    # root generates an invite code
    r = call("post", "/api/admin/invite-codes", token=root, json={"note": "for alice", "maxUses": 1, "expiresInDays": 7})
    check("create invite code", r.status_code == 201 and body(r).get("code", {}).get("code"), str(body(r)))
    invite_code = body(r).get("code", {}).get("code")

    # alice creates an org with the invite code
    r = call("post", "/api/orgs", token=alice, json={"name": "分子生物学实验室", "inviteCode": invite_code, "description": "PCR/克隆"})
    check("create org via invite", r.status_code == 201 and body(r).get("org", {}).get("orgCode"), str(body(r)))
    org = body(r).get("org", {})
    org_id = org.get("id")
    org_code = org.get("orgCode")
    check("creator is org_admin", body(r).get("role") == "org_admin")

    # invite code consumed -> reuse fails (maxUses=1)
    r = call("post", "/api/orgs", token=bob, json={"name": "Another Org", "inviteCode": invite_code})
    check("used invite code rejected", r.status_code == 400, str(body(r)))

    # bad invite code
    r = call("post", "/api/orgs", token=bob, json={"name": "X Org", "inviteCode": "INV-NOPE"})
    check("invalid invite code rejected", r.status_code == 404)

    # bob joins via org code
    r = call("post", "/api/orgs/join", token=bob, json={"orgCode": org_code})
    check("bob joins via org code", r.status_code == 200 and body(r).get("role") == "member", str(body(r)))
    r = call("post", "/api/orgs/join", token=bob, json={"orgCode": org_code})
    check("duplicate join rejected", r.status_code == 409)

    # members list
    r = call("get", f"/api/orgs/{org_id}/members", token=alice)
    members = body(r).get("members", [])
    check("members list has 2", len(members) == 2, str(members))
    bob_id = next((m["userId"] for m in members if m["username"] == "bob"), None)

    # bob (member) cannot manage org
    r = call("patch", f"/api/orgs/{org_id}", token=bob, json={"name": "Hacked"})
    check("member cannot edit org", r.status_code == 403)

    # alice (org_admin) edits org
    r = call("patch", f"/api/orgs/{org_id}", token=alice, json={"name": "分子生物学实验室(改名)"})
    check("org_admin edits org", r.status_code == 200 and body(r).get("org", {}).get("name", "").endswith("(改名)"))

    # inventory: alice creates an item
    r = call("post", f"/api/orgs/{org_id}/inventory", token=alice,
             json={"name": "Taq DNA 聚合酶", "category": "酶", "qty": "100", "unit": "U", "vendor": "Takara", "batch": "B001", "expiry": "2027-01-01", "low": "20"})
    check("create inventory item", r.status_code == 201 and body(r).get("item", {}).get("id"), str(body(r)))
    item_id = body(r).get("item", {}).get("id")

    # bob (member) can read and write inventory
    r = call("get", f"/api/orgs/{org_id}/inventory", token=bob)
    check("member reads inventory", r.status_code == 200 and len(body(r).get("items", [])) == 1)
    check("member canWrite true", body(r).get("canWrite") is True)
    r = call("post", f"/api/orgs/{org_id}/inventory", token=bob, json={"name": "dNTP Mix", "category": "试剂", "qty": "5", "unit": "mM"})
    check("member creates item", r.status_code == 201)
    dntp_id = body(r).get("item", {}).get("id")

    # update bumps version + audit
    r = call("patch", f"/api/orgs/{org_id}/inventory/{item_id}", token=alice, json={"qty": "80"})
    check("update item version=2", body(r).get("item", {}).get("version") == 2, str(body(r)))

    # bulk import
    r = call("post", f"/api/orgs/{org_id}/inventory/bulk", token=alice,
             json={"items": [{"name": "枪头 200uL", "category": "耗材", "qty": "10", "unit": "盒"},
                             {"name": "无水乙醇", "category": "试剂", "qty": "500", "unit": "mL"},
                             {"name": "", "category": "试剂"}]})
    check("bulk import skips empty name", body(r).get("count") == 2, str(body(r)))

    # bulk update + delete
    r = call("post", f"/api/orgs/{org_id}/inventory/bulk-update", token=alice,
             json={"ids": [dntp_id], "patch": {"location": "-20℃ 冰箱"}})
    check("bulk update", body(r).get("count") == 1)
    r = call("post", f"/api/orgs/{org_id}/inventory/bulk-delete", token=alice, json={"ids": [dntp_id], "reason": "用完"})
    check("bulk delete", body(r).get("count") == 1)
    r = call("get", f"/api/orgs/{org_id}/inventory", token=alice)
    check("deleted item hidden", all(i["id"] != dntp_id for i in body(r).get("items", [])))

    # promote bob to QA -> read-only
    r = call("patch", f"/api/orgs/{org_id}/members/{bob_id}", token=alice, json={"role": "qa"})
    check("promote bob to qa", r.status_code == 200, str(body(r)))
    r = call("post", f"/api/orgs/{org_id}/inventory", token=bob, json={"name": "QA 不应能写"})
    check("qa cannot write inventory", r.status_code == 403)
    r = call("get", f"/api/orgs/{org_id}/inventory", token=bob)
    check("qa can read inventory", r.status_code == 200)
    r = call("get", f"/api/orgs/{org_id}/audit", token=bob)
    check("qa can read audit trail", r.status_code == 200 and len(body(r).get("entries", [])) > 0)

    # audit trail visible to org_admin and has inventory.update
    r = call("get", f"/api/orgs/{org_id}/audit", token=alice)
    actions = [e["action"] for e in body(r).get("entries", [])]
    check("audit has org.create", "org.create" in actions)
    check("audit has inventory.update", "inventory.update" in actions)
    check("audit has membership.update", "membership.update" in actions)

    # member cannot read audit (bob is qa now; demote to member and check)
    r = call("patch", f"/api/orgs/{org_id}/members/{bob_id}", token=alice, json={"role": "member"})
    check("demote bob to member", r.status_code == 200)
    r = call("get", f"/api/orgs/{org_id}/audit", token=bob)
    check("member cannot read audit", r.status_code == 403)

    # last-admin guard: alice is the only org_admin; demote self should fail
    r = call("patch", f"/api/orgs/{org_id}/members/{next(m['userId'] for m in members if m['username']=='alice')}",
             token=alice, json={"role": "member"})
    check("cannot demote last org_admin", r.status_code == 400, str(body(r)))

    # e-signature gate: root disables alice without password -> 400
    alice_id = next(m["userId"] for m in members if m["username"] == "alice")
    r = call("patch", f"/api/admin/users/{alice_id}", token=root, json={"disabled": True})
    check("disable without e-sign rejected", r.status_code == 400, str(body(r)))
    r = call("patch", f"/api/admin/users/{alice_id}", token=root, json={"disabled": True, "password": "rootpass123"})
    check("disable with e-sign ok", r.status_code == 200 and body(r).get("user", {}).get("disabled") is True)
    # disabled user token now invalid
    r = call("get", "/api/auth/me", token=alice)
    check("disabled user blocked", r.status_code == 401)
    # re-enable
    r = call("patch", f"/api/admin/users/{alice_id}", token=root, json={"disabled": False, "password": "rootpass123"})
    check("re-enable alice", r.status_code == 200)

    # admin overview
    r = call("get", "/api/admin/users", token=root)
    check("admin lists users", r.status_code == 200 and len(body(r).get("users", [])) >= 3)
    r = call("get", "/api/admin/orgs", token=root)
    check("admin lists orgs", r.status_code == 200 and len(body(r).get("orgs", [])) >= 1)
    r = call("get", "/api/admin/stats", token=root)
    check("admin stats", r.status_code == 200 and body(r).get("orgs", 0) >= 1)

    # org delete requires e-sign
    r = call("delete", f"/api/orgs/{org_id}", token=alice, json={"reason": "测试"})
    check("org delete without e-sign rejected", r.status_code == 400)
    r = call("delete", f"/api/orgs/{org_id}", token=alice, json={"reason": "测试", "password": "alicepass1"})
    check("org delete with e-sign ok", r.status_code == 200)
    r = call("get", f"/api/orgs/{org_id}/inventory", token=alice)
    check("deleted org inaccessible", r.status_code == 404)

    print("\n" + "=" * 50)
    if FAILURES:
        print(f"FAILED {len(FAILURES)}: {FAILURES}")
        sys.exit(1)
    print("ALL CHECKS PASSED")


if __name__ == "__main__":
    main()
