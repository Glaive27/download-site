"""Pytest 共享配置与 fixture."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

# 确保测试使用临时数据库
os.environ.setdefault("TESTING", "true")

from auth.database import Base, get_db
from auth.models import User
from auth.security import get_password_hash
from main import app


@pytest.fixture(scope="function")
def db_session():
    """为每个测试函数创建独立的内存数据库会话."""
    db_fd, db_path = tempfile.mkstemp(suffix=".db")
    engine = create_engine(f"sqlite:///{db_path}")
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    session = TestingSessionLocal()
    try:
        yield session
    finally:
        session.close()
        os.close(db_fd)
        os.unlink(db_path)


@pytest.fixture(scope="function")
def client(db_session):
    """返回配置好测试数据库的 TestClient."""
    def override_get_db():
        try:
            yield db_session
        finally:
            pass

    app.dependency_overrides[get_db] = override_get_db
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture
def admin_user(db_session):
    """创建预设管理员账号 Glaive."""
    user = User(
        username="Glaive",
        hashed_password=get_password_hash("19866179818"),
        role="admin",
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


@pytest.fixture
def normal_user(db_session):
    """创建普通测试用户."""
    user = User(
        username="testuser",
        hashed_password=get_password_hash("testpass123"),
        role="user",
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user
