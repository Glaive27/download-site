"""数据库配置与会话管理."""

from __future__ import annotations

import os
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

# 数据目录：优先使用 DATA_DIR 环境变量，便于 Render / Docker 等无持久化磁盘的环境
# 默认为项目根目录下的 db 子目录
_DATA_DIR = Path(os.environ.get("DATA_DIR", Path(__file__).resolve().parent.parent / "db"))
_DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = _DATA_DIR / "users.db"

SQLALCHEMY_DATABASE_URL = f"sqlite:///{DB_PATH}"

engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    connect_args={"check_same_thread": False},
    echo=False,
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def get_db():
    """生成数据库会话依赖，请求结束后自动关闭."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
