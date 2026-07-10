"""数据库初始化脚本.

创建用户表并预设管理员账号 Glaive.
"""

from __future__ import annotations

import os

from auth.database import Base, SessionLocal, engine
from auth.models import User
from auth.security import get_password_hash


def init_database() -> None:
    """初始化数据库并创建默认管理员账号.

    管理员密码可通过环境变量 ADMIN_PASSWORD 设置，
    未设置时保留默认密码 19866179818。
    """
    Base.metadata.create_all(bind=engine)

    db = SessionLocal()
    try:
        admin_username = os.environ.get("ADMIN_USERNAME", "Glaive")
        admin_password = os.environ.get("ADMIN_PASSWORD", "19866179818")

        existing_admin = (
            db.query(User).filter(User.username == admin_username).first()
        )
        if existing_admin:
            print(f"管理员账号 {admin_username} 已存在，跳过创建。")
            return

        admin = User(
            username=admin_username,
            hashed_password=get_password_hash(admin_password),
            role="admin",
        )
        db.add(admin)
        db.commit()
        print(f"管理员账号 {admin_username} 创建成功。")
    finally:
        db.close()


if __name__ == "__main__":
    init_database()
