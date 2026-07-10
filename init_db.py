"""数据库初始化脚本.

启动时调用:
1. 创建所有表（Base.metadata.create_all）
2. 确保预设管理员账号存在
3. 如果环境变量 RESET_ADMIN_PASSWORD=1，则用 ADMIN_PASSWORD 重置密码
"""

from __future__ import annotations

import logging
import os
import sys
import traceback

from auth.database import Base, SessionLocal, engine
from auth.models import User
from auth.security import get_password_hash

logger = logging.getLogger("init_db")
if not logger.handlers:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"),
    )
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False


def init_database() -> None:
    """初始化数据库并管理管理员账号.

    - 若管理员不存在: 创建管理员（密码来自 ADMIN_PASSWORD 环境变量，默认 19866179818）
    - 若管理员已存在: 跳过创建
    - 若 RESET_ADMIN_PASSWORD=1: 重置管理员密码为 ADMIN_PASSWORD 的当前值
    """
    try:
        Base.metadata.create_all(bind=engine)
    except Exception:
        logger.error("创建数据表失败:\n%s", traceback.format_exc())
        raise

    admin_username = os.environ.get("ADMIN_USERNAME", "Glaive").strip() or "Glaive"
    admin_password = os.environ.get("ADMIN_PASSWORD", "19866179818")
    reset_requested = os.environ.get("RESET_ADMIN_PASSWORD", "0").strip().lower() in {
        "1", "true", "yes", "on",
    }

    db = SessionLocal()
    try:
        existing_admin = (
            db.query(User).filter(User.username == admin_username).first()
        )

        if existing_admin is None:
            admin = User(
                username=admin_username,
                hashed_password=get_password_hash(admin_password),
                role="admin",
            )
            db.add(admin)
            db.commit()
            logger.info(
                "✓ 管理员账号 %s 创建成功（密码长度=%d）",
                admin_username, len(admin_password),
            )
        elif reset_requested:
            existing_admin.hashed_password = get_password_hash(admin_password)
            db.commit()
            logger.warning(
                "✓ 管理员账号 %s 的密码已被 RESET_ADMIN_PASSWORD 重置（密码长度=%d）",
                admin_username, len(admin_password),
            )
        else:
            logger.info("管理员账号 %s 已存在，跳过创建。", admin_username)

        # 打印当前数据目录与数据库文件路径，便于在 Render Logs 中排错
        from auth.database import DB_PATH  # noqa: WPS433
        logger.info("SQLite DB path: %s (存在=%s)", DB_PATH, DB_PATH.exists())
    except Exception:
        logger.error("初始化管理员账号失败:\n%s", traceback.format_exc())
        raise
    finally:
        db.close()


if __name__ == "__main__":
    init_database()
