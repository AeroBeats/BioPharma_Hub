"""Create (or promote) the first super-admin account.

On the server run interactively so the password is never stored in shell history:

    python init_admin.py --username admin

It will prompt for the password securely. For automation you may pass --password,
but prefer the prompt.
"""
from __future__ import annotations

import argparse
import getpass
import sys

from sqlalchemy import select

from audit import write_audit
from db import SessionLocal, init_db
from models import User
from security import hash_password


def main() -> None:
    parser = argparse.ArgumentParser(description="创建/提升超级管理员")
    parser.add_argument("--username", default="admin")
    parser.add_argument("--password", default=None,
                        help="不推荐：会进入 shell 历史。留空则安全提示输入")
    parser.add_argument("--display-name", default="")
    args = parser.parse_args()

    username = args.username.strip()
    if not username:
        print("用户名不能为空")
        sys.exit(1)

    password = args.password
    if not password:
        password = getpass.getpass(f"为 {username} 设置密码（至少 8 位，输入不回显）: ")
        confirm = getpass.getpass("再次输入密码: ")
        if password != confirm:
            print("两次输入的密码不一致")
            sys.exit(1)
    if len(password) < 8:
        print("密码至少 8 位")
        sys.exit(1)

    init_db()
    db = SessionLocal()
    try:
        existing = db.execute(
            select(User).where(User.username == username, User.deleted_at.is_(None))
        ).scalars().first()

        if existing:
            existing.is_super_admin = True
            existing.disabled = False
            existing.password_hash = hash_password(password)
            if args.display_name:
                existing.display_name = args.display_name.strip()[:120]
            user = existing
            db.flush()
            print(f"已将现有用户 {username} 提升为超级管理员并重置密码")
        else:
            user = User(username=username, password_hash=hash_password(password),
                        display_name=(args.display_name.strip()[:120] or username),
                        is_super_admin=True)
            db.add(user)
            db.flush()
            print(f"已创建超级管理员 {username}")

        write_audit(db, actor=user, action="system.init_admin", entity_type="user",
                    entity_id=user.id, after={"username": user.username, "isSuperAdmin": True})
        db.commit()
    finally:
        db.close()


if __name__ == "__main__":
    main()
