"""认证系统功能测试."""

from __future__ import annotations

import base64
import json
from datetime import datetime, timezone, timedelta

import pytest
from altcha import create_challenge_v1, solve_challenge_v1
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from auth.altcha import ALTCHA_HMAC_KEY
from auth.models import User, FileRecord, DownloadLog
from auth.security import get_password_hash, verify_password


def altcha_payload() -> str:
    """生成一个通过校验的 ALTCHA payload（模拟前端 widget 解出后的凭证）."""
    ch = create_challenge_v1(
        hmac_key=ALTCHA_HMAC_KEY,
        algorithm="SHA-256",
        max_number=1000000,
        expires=None,
    )
    sol = solve_challenge_v1(ch, algorithm="SHA-256", max_number=1000000)
    data = {
        "algorithm": ch.algorithm,
        "challenge": ch.challenge,
        "number": sol.number,
        "salt": ch.salt,
        "signature": ch.signature,
    }
    return base64.b64encode(json.dumps(data).encode()).decode()


class TestRegister:
    """用户注册功能测试."""

    def test_register_success(self, client: TestClient):
        """正常注册新用户（含有效人机验证）."""
        response = client.post(
            "/auth/register",
            json={"username": "newuser", "password": "secure123", "altcha": altcha_payload()},
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
            json={"username": "testuser", "password": "another123", "altcha": altcha_payload()},
        )
        assert response.status_code == 409
        assert "已被注册" in response.json()["detail"]

    def test_register_missing_altcha(self, client: TestClient):
        """缺少人机验证应返回 422（参数校验拦截）."""
        response = client.post(
            "/auth/register",
            json={"username": "newuser", "password": "secure123"},
        )
        assert response.status_code == 422

    def test_register_invalid_altcha(self, client: TestClient):
        """非法人机验证凭证应返回 400."""
        response = client.post(
            "/auth/register",
            json={"username": "newuser", "password": "secure123", "altcha": "not-valid"},
        )
        assert response.status_code == 400
        assert "人机验证" in response.json()["detail"]

    @pytest.mark.parametrize(
        "payload,expected_status",
        [
            ({"username": "ab", "password": "short", "altcha": "X"}, 422),  # 用户名过短
            ({"username": "user name", "password": "password1", "altcha": "X"}, 422),  # 含空格
            ({"username": "user<script>", "password": "password1", "altcha": "X"}, 422),  # XSS 尝试
            ({"username": "user' OR '1'='1", "password": "password1", "altcha": "X"}, 422),  # 注入尝试
            ({"username": "validuser", "password": "12345", "altcha": "X"}, 422),  # 密码过短
            ({"username": "validuser", "altcha": "X"}, 422),  # 缺少密码
            ({"password": "password1", "altcha": "X"}, 422),  # 缺少用户名
        ],
    )
    def test_register_validation(
        self,
        client: TestClient,
        payload: dict,
        expected_status: int,
    ):
        """注册参数校验与安全防护测试（altcha 占位，422 由字段校验触发）."""
        response = client.post("/auth/register", json=payload)
        assert response.status_code == expected_status


class TestLogin:
    """用户登录功能测试."""

    def test_login_success(self, client: TestClient, normal_user: User):
        """已注册用户使用正确账号密码登录（含有效人机验证）."""
        response = client.post(
            "/auth/login",
            data={"username": "testuser", "password": "testpass123", "altcha": altcha_payload()},
        )
        assert response.status_code == 200
        data = response.json()
        assert "access_token" in data
        assert data["token_type"] == "bearer"

    def test_login_without_altcha(self, client: TestClient, normal_user: User):
        """缺少人机验证应返回 422."""
        response = client.post(
            "/auth/login",
            data={"username": "testuser", "password": "testpass123"},
        )
        assert response.status_code == 422

    def test_login_invalid_altcha(self, client: TestClient, normal_user: User):
        """非法人机验证凭证应返回 400."""
        response = client.post(
            "/auth/login",
            data={"username": "testuser", "password": "testpass123", "altcha": "bad"},
        )
        assert response.status_code == 400
        assert "人机验证" in response.json()["detail"]

    def test_login_wrong_password(self, client: TestClient, normal_user: User):
        """密码错误应返回 401."""
        response = client.post(
            "/auth/login",
            data={"username": "testuser", "password": "wrongpass", "altcha": altcha_payload()},
        )
        assert response.status_code == 401
        assert "用户名或密码错误" in response.json()["detail"]

    def test_login_nonexistent_user(self, client: TestClient):
        """不存在的用户登录应返回 401."""
        response = client.post(
            "/auth/login",
            data={"username": "notexist", "password": "anypass", "altcha": altcha_payload()},
        )
        assert response.status_code == 401


class TestAdminAccount:
    """预设管理员账号测试."""

    def test_admin_login(self, client: TestClient, admin_user: User):
        """管理员 Glaive 使用初始密码登录（含有效人机验证）."""
        response = client.post(
            "/auth/login",
            data={"username": "Glaive", "password": "19866179818", "altcha": altcha_payload()},
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
            data={"username": username, "password": password, "altcha": altcha_payload()},
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
        """SQL 注入尝试应被输入校验拦截（altcha 占位，422 由字段校验触发）."""
        payloads = [
            {"username": "admin'--", "password": "password1", "altcha": "X"},
            {"username": "' OR 1=1 --", "password": "password1", "altcha": "X"},
            {"username": "user; DROP TABLE users;--", "password": "password1", "altcha": "X"},
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
                "altcha": "X",
            },
        )
        assert response.status_code == 422

    def test_password_not_returned(self, client: TestClient):
        """任何接口都不应返回密码或哈希值."""
        client.post(
            "/auth/register",
            json={"username": "secureuser", "password": "password1", "altcha": altcha_payload()},
        )
        response = client.post(
            "/auth/login",
            data={"username": "secureuser", "password": "password1", "altcha": altcha_payload()},
        )
        token = response.json()["access_token"]
        me_response = client.get(
            "/auth/me",
            headers={"Authorization": f"Bearer {token}"},
        )
        data = me_response.json()
        assert "password" not in data
        assert "hashed_password" not in data


class TestDownloadHistory:
    """账号历史下载记录（归属统计）功能测试."""

    def _make_file(self, db_session: Session, filename: str, series: str, original: str | None = None) -> FileRecord:
        """在测试库中直接插入一条文件记录（避免依赖文件上传/存储服务）."""
        rec = FileRecord(
            series=series,
            filename=filename,
            original_filename=original,
            version="v1",
            size=10,
            mime_type="application/zip",
            object_key=f"{series}/{filename}",
            file_data=b"data",
            file_mime="application/zip",
        )
        db_session.add(rec)
        db_session.commit()
        db_session.refresh(rec)
        return rec

    def _token(self, client: TestClient, username: str, password: str) -> str:
        resp = client.post(
            "/auth/login",
            data={"username": username, "password": password, "altcha": altcha_payload()},
        )
        return resp.json()["access_token"]

    def test_log_download_creates_entry(
        self,
        client: TestClient,
        db_session: Session,
        normal_user: User,
    ):
        """登录用户下载后，POST /api/download-log 写入归属记录."""
        self._make_file(db_session, "s1_v1.zip", "s1", "实例.zip")
        token = self._token(client, "testuser", "testpass123")
        resp = client.post(
            "/api/download-log/s1_v1.zip",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        assert db_session.query(DownloadLog).filter_by(user_id=normal_user.id).count() == 1

    def test_log_download_requires_auth(self, client: TestClient, db_session: Session):
        """未登录调用下载归属接口应返回 401."""
        self._make_file(db_session, "s1_v1.zip", "s1")
        resp = client.post("/api/download-log/s1_v1.zip")
        assert resp.status_code == 401

    def test_log_download_missing_file(self, client: TestClient, normal_user: User):
        """下载不存在的文件，归属接口应返回 404."""
        token = self._token(client, "testuser", "testpass123")
        resp = client.post(
            "/api/download-log/nope.zip",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 404

    def test_history_requires_admin(
        self,
        client: TestClient,
        db_session: Session,
        normal_user: User,
        admin_user: User,
    ):
        """普通用户不能查看他人下载历史（403）；管理员可以（200）."""
        token = self._token(client, "testuser", "testpass123")
        forbidden = client.get(
            "/api/admin/users/testuser/downloads",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert forbidden.status_code == 403

        admin = self._token(client, "Glaive", "19866179818")
        ok = client.get(
            "/api/admin/users/testuser/downloads",
            headers={"Authorization": f"Bearer {admin}"},
        )
        assert ok.status_code == 200

    def test_history_content_and_ratio(
        self,
        client: TestClient,
        db_session: Session,
        normal_user: User,
        admin_user: User,
    ):
        """历史记录含文件名、时间、下载比例；同文件多次下载去重计数."""
        self._make_file(db_session, "s1_v1.zip", "s1", "实例.zip")
        self._make_file(db_session, "s2_v1.zip", "s2", "资料.zip")
        token = self._token(client, "testuser", "testpass123")

        # 同一文件下载两次
        for _ in range(2):
            r = client.post(
                "/api/download-log/s1_v1.zip",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert r.status_code == 200

        admin_token = self._token(client, "Glaive", "19866179818")
        resp = client.get(
            "/api/admin/users/testuser/downloads?order=desc",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["username"] == "testuser"
        assert data["total_files"] == 2
        assert data["downloaded_files"] == 1  # 去重：只下载了 1 个不同文件
        assert data["ratio"] == 50.0          # 1 / 2 * 100
        assert len(data["history"]) == 2      # 两次下载事件均记录
        assert data["history"][0]["file_name"] == "实例.zip"

    def test_history_sorting(
        self,
        client: TestClient,
        db_session: Session,
        normal_user: User,
        admin_user: User,
    ):
        """按下载时间排序：order=desc 最新在前，order=asc 最早在前."""
        f1 = self._make_file(db_session, "s1_v1.zip", "s1", "A.zip")
        f2 = self._make_file(db_session, "s2_v1.zip", "s2", "B.zip")
        db_session.add_all([
            DownloadLog(user_id=normal_user.id, file_record_id=f1.id,
                        downloaded_at=datetime(2026, 1, 1, tzinfo=timezone.utc)),
            DownloadLog(user_id=normal_user.id, file_record_id=f2.id,
                        downloaded_at=datetime(2026, 6, 1, tzinfo=timezone.utc)),
        ])
        db_session.commit()

        admin_token = self._token(client, "Glaive", "19866179818")
        desc = client.get(
            "/api/admin/users/testuser/downloads?order=desc",
            headers={"Authorization": f"Bearer {admin_token}"},
        ).json()
        assert desc["history"][0]["file_name"] == "B.zip"
        asc = client.get(
            "/api/admin/users/testuser/downloads?order=asc",
            headers={"Authorization": f"Bearer {admin_token}"},
        ).json()
        assert asc["history"][0]["file_name"] == "A.zip"

    def test_delete_user_cleans_logs(
        self,
        client: TestClient,
        db_session: Session,
        normal_user: User,
        admin_user: User,
    ):
        """删除用户时，其下载日志应一并清理."""
        self._make_file(db_session, "s1_v1.zip", "s1", "实例.zip")
        token = self._token(client, "testuser", "testpass123")
        client.post(
            "/api/download-log/s1_v1.zip",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert db_session.query(DownloadLog).filter_by(user_id=normal_user.id).count() == 1

        admin_token = self._token(client, "Glaive", "19866179818")
        resp = client.delete(
            "/api/admin/users/testuser",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 200
        assert db_session.query(DownloadLog).filter_by(user_id=normal_user.id).count() == 0
