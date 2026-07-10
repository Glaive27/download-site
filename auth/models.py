"""ORM 模型：用户、文件系列、文件记录."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, Integer, String

from auth.database import Base


def _utcnow() -> datetime:
    """返回带 UTC 时区的当前时间."""
    return datetime.now(timezone.utc)


class User(Base):  # noqa: D101
    """用户表，使用 ORM 参数化查询防止 SQL 注入."""

    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(64), unique=True, index=True, nullable=False)
    hashed_password = Column(String(255), nullable=False)
    role = Column(String(16), default="user", nullable=False)

    def __repr__(self) -> str:  # noqa: D105
        return f"<User(id={self.id}, username={self.username}, role={self.role})>"


class Series(Base):  # noqa: D101
    """文件系列表，持久化存储已创建的系列名."""

    __tablename__ = "series"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(128), unique=True, index=True, nullable=False)
    created_at = Column(DateTime, default=_utcnow, nullable=False)

    def __repr__(self) -> str:  # noqa: D105
        return f"<Series(id={self.id}, name={self.name})>"


class FileRecord(Base):  # noqa: D101
    """文件元数据记录表，实际文件内容保存在 Cloudflare R2（S3 API）.

    字段说明：
    - series: 所属系列名
    - filename: 下载时显示的文件名（如 series_v1.pdf）
    - version: 版本号（如 v1、v2）
    - size: 文件大小（字节）
    - mime_type: 文件 MIME 类型
    - object_key: R2 中的对象键（如 series/series_v1.pdf）
    - created_at: 上传时间
    """

    __tablename__ = "file_records"

    id = Column(Integer, primary_key=True, index=True)
    series = Column(String(128), nullable=False, index=True)
    filename = Column(String(255), nullable=False, index=True)
    version = Column(String(32), nullable=False)
    size = Column(Integer, nullable=False)
    mime_type = Column(String(128), nullable=False)
    object_key = Column(String(512), nullable=False, unique=True, index=True)
    created_at = Column(DateTime, default=_utcnow, nullable=False)

    def __repr__(self) -> str:  # noqa: D105
        return f"<FileRecord(id={self.id}, series={self.series}, filename={self.filename})>"
