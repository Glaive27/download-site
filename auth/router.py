"""认证相关 API 路由."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, Form, HTTPException, Request, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session

from auth.database import get_db
from auth.models import User
from auth.altcha import verify_altcha
from auth.schemas import Token, UserCreate, UserLogin, UserOut, UserRegisterResponse
from auth.security import (
    ACCESS_TOKEN_EXPIRE_MINUTES,
    authenticate_user,
    create_access_token,
    get_current_active_user,
    get_password_hash,
    require_admin,
)

router = APIRouter(prefix="/auth", tags=["认证"])

# 客户端环境自动化风险分阈值：达到该值即判定为明显的自动化浏览器环境，直接拦截。
# 配合登录后的鼠标轨迹行为分析（BehaviorMonitor）形成纵深防御：
# 明显自动化环境在此拦截，隐蔽自动化（如 CDP 模拟真实事件）由行为分析兜底。
BOT_SCORE_THRESHOLD = 0.7


@router.post(
    "/register",
    response_model=UserRegisterResponse,
    status_code=status.HTTP_201_CREATED,
)
def register(
    user_in: UserCreate,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
):
    """用户注册接口."""
    # 校验 ALTCHA 人机验证（Proof-of-Work）
    verify_altcha(user_in.altcha)

    # 自动化环境硬拦截：bot_score 由前端环境指纹计算（webdriver/无头/自动化框架特征）
    if user_in.bot_score >= BOT_SCORE_THRESHOLD:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="检测到自动化操作环境，请求已被拦截",
        )

    # 检查用户名是否已存在
    existing = db.query(User).filter(User.username == user_in.username).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="用户名已被注册",
        )

    hashed_password = get_password_hash(user_in.password)
    new_user = User(
        username=user_in.username,
        hashed_password=hashed_password,
        role=user_in.role,
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)

    # 记录注册 IP 与地理位置（管理员可见）
    from main import _record_user_ip
    _record_user_ip(new_user, request, db)

    return {
        "id": new_user.id,
        "username": new_user.username,
        "role": new_user.role,
        "message": "注册成功",
    }


@router.post("/login", response_model=Token)
def login(
    form_data: Annotated[OAuth2PasswordRequestForm, Depends()],
    altcha: Annotated[str, Form()],
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    bot_score: Annotated[float, Form()] = 0.0,
):
    """用户登录接口，返回 JWT 访问令牌."""
    # 校验 ALTCHA 人机验证（Proof-of-Work）
    verify_altcha(altcha)

    # 自动化环境硬拦截：AI 浏览器（如 Tabbit）虽能解算 PoW，但其环境指纹会暴露自动化特征
    if bot_score >= BOT_SCORE_THRESHOLD:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="检测到自动化操作环境，请求已被拦截",
        )

    # 先判断账号是否存在：
    # 账号存在但密码错 → 返回「用户名或密码错误」（普通内联提示）；
    # 账号不存在（从未注册，或注册后被管理员注销）→ 返回结构化 code=ACCOUNT_NOT_FOUND，
    # 前端据此弹出「该账号异常/已注销」弹窗（与会话异常弹窗同款）。
    existing = db.query(User).filter(User.username == form_data.username).first()
    if not existing:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "ACCOUNT_NOT_FOUND",
                "message": "该账号不存在或已被注销",
            },
            headers={"WWW-Authenticate": "Bearer"},
        )

    user = authenticate_user(db, form_data.username, form_data.password)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="用户名或密码错误",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # 记录上线时间并清除此前的不活跃高危标记（用户已回归，恢复为正常账号）
    user.last_login = datetime.now(timezone.utc)
    user.high_risk = False

    # 记录登录 IP 与地理位置（管理员可见）
    from main import _record_user_ip
    _record_user_ip(user, request, db)

    db.commit()

    access_token_expires = timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = create_access_token(
        data={"sub": user.username, "role": user.role},
        expires_delta=access_token_expires,
    )
    return {"access_token": access_token, "token_type": "bearer"}


@router.get("/me", response_model=UserOut)
def read_current_user(
    current_user: Annotated[User, Depends(get_current_active_user)],
):
    """获取当前登录用户信息."""
    return current_user


@router.get("/admin-only")
def admin_only(current_user: Annotated[User, Depends(require_admin)]):
    """仅管理员可访问的示例接口."""
    return {
        "message": "欢迎管理员",
        "username": current_user.username,
        "role": current_user.role,
    }
