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
from auth.models import FileRecord, User
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
    """自动迁移：基于 ORM 模型动态补齐 file_records 表缺失的列.

    SQLAlchemy 的 create_all 只创建不存在的表，不会给已有表添加新列。
    本函数动态对比 FileRecord 模型与数据库实际列，自动 ALTER TABLE ADD COLUMN，
    覆盖所有缺失列（如 original_filename、file_data、file_mime、created_at 等），
    避免手动维护迁移列表导致漏列（漏列会让 /files 查询直接 500）。

    本函数内部完全容错，任何异常都不会导致应用启动失败。
    """
    from sqlalchemy import DateTime, inspect as _sa_inspect, text as _sa_text

    try:
        is_postgres = engine.dialect.name == "postgresql"
    except Exception:
        is_postgres = False

    try:
        existing_columns = {
            col["name"] for col in _sa_inspect(engine).get_columns("file_records")
        }
    except Exception:
        # 表可能还不存在，create_all 会负责创建完整表
        return

    db = SessionLocal()
    try:
        for col in FileRecord.__table__.columns:
            col_name = col.name
            if col_name == "id":  # 主键不会缺失
                continue
            if col_name in existing_columns:
                continue
            try:
                # 用 SQLAlchemy 方言把列类型编译成数据库原生 DDL 类型
                col_type = col.type.compile(dialect=engine.dialect)
                # 第一步：先以可空方式添加列。
                # 注意：SQLite 旧版本不允许 ADD COLUMN 使用非恒定默认值（如 CURRENT_TIMESTAMP），
                # 因此这里不写 DEFAULT，改为后续 UPDATE 填充，PostgreSQL / SQLite 均可兼容。
                add_ddl = f'ALTER TABLE file_records ADD COLUMN "{col_name}" {col_type}'
                if is_postgres:
                    add_ddl = add_ddl.replace(" ADD COLUMN ", " ADD COLUMN IF NOT EXISTS ")
                db.execute(_sa_text(add_ddl))
                db.commit()
                logger.info("✓ 自动迁移: file_records 表已添加 %s 列", col_name)

                # 第二步：若模型定义该列非空，先填充历史空值，再（仅 PG）设为 NOT NULL
                if not col.nullable:
                    if isinstance(col.type, DateTime):
                        default_expr = "CURRENT_TIMESTAMP"
                    else:
                        default_expr = "''"
                    db.execute(_sa_text(
                        f'UPDATE file_records SET "{col_name}" = {default_expr} '
                        f'WHERE "{col_name}" IS NULL'
                    ))
                    db.commit()
                    if is_postgres:
                        db.execute(_sa_text(
                            f'ALTER TABLE file_records ALTER COLUMN "{col_name}" SET NOT NULL'
                        ))
                        db.commit()
            except Exception as exc:
                db.rollback()
                logger.warning("⚠ 自动迁移 %s 列失败（已忽略）: %s", col_name, exc)
    finally:
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
