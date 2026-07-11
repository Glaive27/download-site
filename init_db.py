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


def _auto_migrate() -> None:
    """自动迁移：为已有表添加新增列（PostgreSQL / SQLite 兼容）.

    SQLAlchemy 的 create_all 只创建不存在的表，不会给已有表添加新列。
    此函数在启动时检查并补全缺失的列，避免手动执行 SQL 迁移脚本。
    """
    from sqlalchemy import inspect as _sa_inspect, text as _sa_text

    try:
        inspector = _sa_inspect(engine)
        existing_columns = {col["name"] for col in inspector.get_columns("file_records")}
    except Exception:
        # 表可能还不存在，跳过迁移
        return

    migrations = [
        ("original_filename", "VARCHAR(255)"),
        ("file_data", "BYTEA" if "postgres" in str(engine.url.dialect).lower() else "BLOB"),
        ("file_mime", "VARCHAR(100)"),
    ]

    db = SessionLocal()
    for column_name, column_type in migrations:
        if column_name not in existing_columns:
            try:
                dialect = str(engine.url.dialect).lower()
                if "postgres" in dialect:
                    db.execute(_sa_text(
                        f'ALTER TABLE file_records ADD COLUMN IF NOT EXISTS "{column_name}" {column_type}'
                    ))
                else:
                    # SQLite 不支持 IF NOT EXISTS + ADD COLUMN，用 try/except 容错
                    db.execute(_sa_text(
                        f"ALTER TABLE file_records ADD COLUMN {column_name} {column_type}"
                    ))
                db.commit()
                logger.info("✓ 自动迁移: file_records 表已添加 %s 列", column_name)
            except Exception:
                db.rollback()
                logger.warning("⚠ 自动迁移 %s 列失败（可能已存在），忽略", column_name)
    db.close()


def init_database() -> None:
    """初始化数据库并管理管理员账号.

    - 若管理员不存在: 创建管理员（密码来自 ADMIN_PASSWORD 环境变量，默认 19866179818）
    - 若管理员已存在: 跳过创建
    - 若 RESET_ADMIN_PASSWORD=1: 重置管理员密码为 ADMIN_PASSWORD 的当前值
    - 自动迁移: 检测并添加缺失的数据库列（如 original_filename）
    """
    try:
        Base.metadata.create_all(bind=engine)
    except Exception:
        logger.error("创建数据表失败:\n%s", traceback.format_exc())
        raise

    # 自动迁移：为已有表添加新增字段（create_all 不会给已有表加新列）
    _auto_migrate()

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

        database_url = os.environ.get("DATABASE_URL", "").strip()
        if database_url:
            logger.info("使用 PostgreSQL 数据库: %s", database_url.split("@")[-1])
        else:
            from auth.database import DB_PATH  # noqa: WPS433
            logger.info("使用 SQLite 数据库: %s (存在=%s)", DB_PATH, DB_PATH.exists())
    except Exception:
        logger.error("初始化管理员账号失败:\n%s", traceback.format_exc())
        raise
    finally:
        db.close()


if __name__ == "__main__":
    init_database()
