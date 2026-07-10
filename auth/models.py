"""用户 ORM 模型."""

from __future__ import annotations

from sqlalchemy import Column, Integer, String

from auth.database import Base


class User(Base):  # noqa: D101
    """用户表，使用 ORM 参数化查询防止 SQL 注入."""

    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(64), unique=True, index=True, nullable=False)
    hashed_password = Column(String(255), nullable=False)
    role = Column(String(16), default="user", nullable=False)

    def __repr__(self) -> str:  # noqa: D105
        return f"<User(id={self.id}, username={self.username}, role={self.role})>"
