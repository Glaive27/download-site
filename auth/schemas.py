"""Pydantic 数据校验模型."""

from __future__ import annotations

import re

from typing import Literal

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
    altcha: str = Field(..., min_length=1, description="ALTCHA 人机验证 payload")

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


class BehaviorReport(BaseModel):  # noqa: D101
    """前端行为式人机认证上报模型（仅聚合特征，不含原始坐标，保护隐私）.

    - risk_score: 综合风险分 0~1（越高越疑似机器人）
    - verdict:    'human' / 'suspicious'
    - sample_count: 参与分析的采样点数
    - features: 各类特征（速度变异系数、方向熵、周期性等），用于审计与调参
    """

    risk_score: float = Field(..., ge=0.0, le=1.0)
    verdict: Literal["human", "suspicious"] = "human"
    sample_count: int = Field(0, ge=0)
    features: dict = Field(default_factory=dict)


class BehaviorReverify(BaseModel):  # noqa: D101
    """行为异常后二次验证（ALTCHA）请求模型."""

    altcha: str = Field(..., min_length=1, description="ALTCHA 人机验证 payload")
