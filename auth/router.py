"""认证相关 API 路由."""

from __future__ import annotations

from datetime import timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session

from auth.database import get_db
from auth.models import User
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


@router.post(
    "/register",
    response_model=UserRegisterResponse,
    status_code=status.HTTP_201_CREATED,
)
def register(user_in: UserCreate, db: Annotated[Session, Depends(get_db)]):
    """用户注册接口."""
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
        role="user",
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)

    return {
        "id": new_user.id,
        "username": new_user.username,
        "role": new_user.role,
        "message": "注册成功",
    }


@router.post("/login", response_model=Token)
def login(
    form_data: Annotated[OAuth2PasswordRequestForm, Depends()],
    db: Annotated[Session, Depends(get_db)],
):
    """用户登录接口，返回 JWT 访问令牌."""
    user = authenticate_user(db, form_data.username, form_data.password)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="用户名或密码错误",
            headers={"WWW-Authenticate": "Bearer"},
        )

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
