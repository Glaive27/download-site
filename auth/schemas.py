"""Pydantic 数据校验模型."""

from __future__ import annotations

import re

from pydantic import BaseModel, ConfigDict, Field, field_validator

SAFE_USERNAME_RE = re.compile(r"^[a-zA-Z0-9_\u4e00-\u9fa5]{3,32}$")


class UserBase(BaseModel):  # noqa: D101
    """用户基础字段."""

    username: str = Field(..., min_length=3, max_length=32)

    @field_validator("username")
    @classmethod
    def validate_username(cls, value: str) -> str:
        """校验用户名格式，防止注入与 XSS."""
        value = value.strip()
        if not SAFE_USERNAME_RE.fullmatch(value):
            raise ValueError(
                "用户名仅支持 3-32 位字母、数字、下划线或中文",
            )
        return value


class UserCreate(UserBase):  # noqa: D101
    """用户注册请求模型."""

    password: str = Field(..., min_length=6, max_length=128)

    @field_validator("password")
    @classmethod
    def validate_password(cls, value: str) -> str:
        """校验密码复杂度."""
        if len(value) < 6:
            raise ValueError("密码长度至少 6 位")
        return value


class UserLogin(UserBase):  # noqa: D101
    """用户登录请求模型."""

    password: str = Field(..., min_length=1, max_length=128)


class Token(BaseModel):  # noqa: D101
    """登录成功后返回的 Token 模型."""

    access_token: str
    token_type: str = "bearer"


class UserOut(UserBase):  # noqa: D101
    """用户信息响应模型."""

    id: int
    role: str

    model_config = ConfigDict(from_attributes=True)


class UserRegisterResponse(BaseModel):  # noqa: D101
    """注册成功响应模型."""

    id: int
    username: str
    role: str
    message: str
