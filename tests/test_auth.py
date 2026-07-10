"""认证系统功能测试."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from auth.models import User
from auth.security import get_password_hash, verify_password


class TestRegister:
    """用户注册功能测试."""

    def test_register_success(self, client: TestClient):
        """正常注册新用户."""
        response = client.post(
            "/auth/register",
            json={"username": "newuser", "password": "secure123"},
        )
        assert response.status_code == 201
        data = response.json()
        assert data["username"] == "newuser"
        assert data["role"] == "user"
        assert "id" in data
        assert "message" in data

    def test_register_duplicate_username(self, client: TestClient, normal_user: User):
        """重复用户名注册应返回 409."""
        response = client.post(
            "/auth/register",
            json={"username": "testuser", "password": "another123"},
        )
        assert response.status_code == 409
        assert "已被注册" in response.json()["detail"]

    @pytest.mark.parametrize(
        "payload,expected_status",
        [
            ({"username": "ab", "password": "short"}, 422),  # 用户名过短
            ({"username": "user name", "password": "password1"}, 422),  # 含空格
            ({"username": "user<script>", "password": "password1"}, 422),  # XSS 尝试
            ({"username": "user' OR '1'='1", "password": "password1"}, 422),  # 注入尝试
            ({"username": "validuser", "password": "12345"}, 422),  # 密码过短
            ({"username": "validuser"}, 422),  # 缺少密码
            ({"password": "password1"}, 422),  # 缺少用户名
        ],
    )
    def test_register_validation(
        self,
        client: TestClient,
        payload: dict,
        expected_status: int,
    ):
        """注册参数校验与安全防护测试."""
        response = client.post("/auth/register", json=payload)
        assert response.status_code == expected_status


class TestLogin:
    """用户登录功能测试."""

    def test_login_success(self, client: TestClient, normal_user: User):
        """已注册用户使用正确账号密码登录."""
        response = client.post(
            "/auth/login",
            data={"username": "testuser", "password": "testpass123"},
        )
        assert response.status_code == 200
        data = response.json()
        assert "access_token" in data
        assert data["token_type"] == "bearer"

    def test_login_wrong_password(self, client: TestClient, normal_user: User):
        """密码错误应返回 401."""
        response = client.post(
            "/auth/login",
            data={"username": "testuser", "password": "wrongpass"},
        )
        assert response.status_code == 401
        assert "用户名或密码错误" in response.json()["detail"]

    def test_login_nonexistent_user(self, client: TestClient):
        """不存在的用户登录应返回 401."""
        response = client.post(
            "/auth/login",
            data={"username": "notexist", "password": "anypass"},
        )
        assert response.status_code == 401


class TestAdminAccount:
    """预设管理员账号测试."""

    def test_admin_login(self, client: TestClient, admin_user: User):
        """管理员 Glaive 使用初始密码登录."""
        response = client.post(
            "/auth/login",
            data={"username": "Glaive", "password": "19866179818"},
        )
        assert response.status_code == 200
        data = response.json()
        assert "access_token" in data

    def test_admin_password_hashed(self, admin_user: User):
        """管理员密码在数据库中应为加密状态."""
        assert admin_user.hashed_password != "19866179818"
        assert verify_password("19866179818", admin_user.hashed_password)


class TestAuthorization:
    """基于角色的权限控制测试."""

    def _get_token(self, client: TestClient, username: str, password: str) -> str:
        """辅助方法：登录并返回 Token."""
        response = client.post(
            "/auth/login",
            data={"username": username, "password": password},
        )
        return response.json()["access_token"]

    def test_read_current_user(self, client: TestClient, normal_user: User):
        """携带有效 Token 可获取当前用户信息."""
        token = self._get_token(client, "testuser", "testpass123")
        response = client.get(
            "/auth/me",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["username"] == "testuser"
        assert data["role"] == "user"

    def test_read_current_user_without_token(self, client: TestClient):
        """未携带 Token 访问受保护接口应返回 401."""
        response = client.get("/auth/me")
        assert response.status_code == 401

    def test_normal_user_cannot_access_admin_route(
        self,
        client: TestClient,
        normal_user: User,
    ):
        """普通用户访问管理员接口应返回 403."""
        token = self._get_token(client, "testuser", "testpass123")
        response = client.get(
            "/auth/admin-only",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 403
        assert "权限不足" in response.json()["detail"]

    def test_admin_can_access_admin_route(
        self,
        client: TestClient,
        admin_user: User,
    ):
        """管理员可以访问管理员接口."""
        token = self._get_token(client, "Glaive", "19866179818")
        response = client.get(
            "/auth/admin-only",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 200
        assert response.json()["role"] == "admin"

    def test_file_management_requires_admin(
        self,
        client: TestClient,
        normal_user: User,
    ):
        """文件管理接口需要管理员权限."""
        token = self._get_token(client, "testuser", "testpass123")
        response = client.post(
            "/api/series",
            data={"name": "testseries"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 403


class TestSecurity:
    """系统安全性测试."""

    def test_sql_injection_prevention(self, client: TestClient):
        """SQL 注入尝试应被输入校验拦截."""
        payloads = [
            {"username": "admin'--", "password": "password1"},
            {"username": "' OR 1=1 --", "password": "password1"},
            {"username": "user; DROP TABLE users;--", "password": "password1"},
        ]
        for payload in payloads:
            response = client.post("/auth/register", json=payload)
            assert response.status_code == 422

    def test_xss_prevention(self, client: TestClient):
        """XSS 攻击尝试应被输入校验拦截."""
        response = client.post(
            "/auth/register",
            json={
                "username": "<script>alert(1)</script>",
                "password": "password1",
            },
        )
        assert response.status_code == 422

    def test_password_not_returned(self, client: TestClient):
        """任何接口都不应返回密码或哈希值."""
        client.post(
            "/auth/register",
            json={"username": "secureuser", "password": "password1"},
        )
        response = client.post(
            "/auth/login",
            data={"username": "secureuser", "password": "password1"},
        )
        token = response.json()["access_token"]
        me_response = client.get(
            "/auth/me",
            headers={"Authorization": f"Bearer {token}"},
        )
        data = me_response.json()
        assert "password" not in data
        assert "hashed_password" not in data
