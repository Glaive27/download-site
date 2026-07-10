"""数据库配置与会话管理.

支持两种运行环境：
- 线上（Render）：优先使用 DATABASE_URL（PostgreSQL），数据持久化。
- 本地开发：未设置 DATABASE_URL 时回退到 SQLite，便于快速启动。
"""

from __future__ import annotations

import os
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()

if DATABASE_URL:
    # Render 提供的 postgres:// 与 SQLAlchemy 的 postgresql:// 兼容处理
    SQLALCHEMY_DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)
    # 部分平台（如 Render）的 DATABASE_URL 可能包含 sslmode，SQLAlchemy 2 可自动识别查询参数
    engine_kwargs: dict = {}
else:
    # 本地开发回退到 SQLite
    _DATA_DIR = Path(
        os.environ.get("DATA_DIR", Path(__file__).resolve().parent.parent / "db"),
    )
    _DATA_DIR.mkdir(parents=True, exist_ok=True)
    DB_PATH = _DATA_DIR / "users.db"
    SQLALCHEMY_DATABASE_URL = f"sqlite:///{DB_PATH}"
    engine_kwargs = {"connect_args": {"check_same_thread": False}}

engine = create_engine(SQLALCHEMY_DATABASE_URL, echo=False, **engine_kwargs)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def get_db():
    """生成数据库会话依赖，请求结束后自动关闭."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
