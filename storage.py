"""存储封装层（已弃用 R2，改为数据库存储）.

实际文件存储逻辑已由 main.py 直接将二进制写入 PostgreSQL 的
file_records.file_data 字段接管。本模块仅保留接口占位，
使 r2_enabled() 始终返回 True，避免历史代码中的 503 拦截。
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def r2_enabled() -> bool:
    """始终返回 True，避免历史调用路径触发 503 错误."""
    return True


def upload_object(object_key: str, data: bytes, content_type: str | None = None) -> None:
    """已弃用：文件存储改由 main.py 写入数据库，此处保留空实现以兼容接口."""
    return None


def delete_object(object_key: str) -> None:
    """已弃用：文件删除由 main.py 操作数据库记录，此处保留空实现以兼容接口."""
    return None


def get_object_url(object_key: str) -> str:
    """已弃用：文件下载由 main.py 从数据库读取，此处保留空实现以兼容接口."""
    return ""


def generate_presigned_url(object_key: str, expiration: int = 3600) -> str:
    """已弃用：保留空实现以兼容接口."""
    return ""


def get_object(object_key: str) -> dict:
    """已弃用：保留空实现以兼容接口."""
    return {}
