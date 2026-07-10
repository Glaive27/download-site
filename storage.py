"""Cloudflare R2（S3 API）对象存储封装.

负责文件的上传、下载、删除以及预签名链接生成。
所有配置均来自环境变量，未配置时相关函数会抛出清晰错误。
"""

from __future__ import annotations

import logging
import mimetypes
import os
from typing import BinaryIO

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

_R2_ACCOUNT_ID = os.environ.get("R2_ACCOUNT_ID", "").strip()
_R2_ACCESS_KEY_ID = os.environ.get("R2_ACCESS_KEY_ID", "").strip()
_R2_SECRET_ACCESS_KEY = os.environ.get("R2_SECRET_ACCESS_KEY", "").strip()
_R2_BUCKET = os.environ.get("R2_BUCKET", "").strip()
_R2_PUBLIC_URL = os.environ.get("R2_PUBLIC_URL", "").strip()

_R2_CONFIGURED = all((_R2_ACCOUNT_ID, _R2_ACCESS_KEY_ID, _R2_SECRET_ACCESS_KEY, _R2_BUCKET))


def _get_s3_client():
    """返回配置好的 boto3 S3 客户端（用于 R2）."""
    if not _R2_CONFIGURED:
        raise RuntimeError(
            "R2 未配置，请设置环境变量："
            "R2_ACCOUNT_ID、R2_ACCESS_KEY_ID、R2_SECRET_ACCESS_KEY、R2_BUCKET",
        )
    endpoint_url = f"https://{_R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
    return boto3.client(
        "s3",
        endpoint_url=endpoint_url,
        aws_access_key_id=_R2_ACCESS_KEY_ID,
        aws_secret_access_key=_R2_SECRET_ACCESS_KEY,
        region_name="auto",
        config=Config(signature_version="s3v4"),
    )


def r2_enabled() -> bool:
    """返回 R2 是否已完整配置."""
    return _R2_CONFIGURED


def upload_object(object_key: str, data: bytes, content_type: str | None = None) -> None:
    """上传字节数据到 R2.

    Args:
        object_key: R2 对象键，例如 "series/series_v1.pdf"。
        data: 文件二进制内容。
        content_type: 可选 MIME 类型，默认根据扩展名猜测或 application/octet-stream。
    """
    if content_type is None:
        content_type = mimetypes.guess_type(object_key)[0] or "application/octet-stream"

    s3 = _get_s3_client()
    try:
        s3.put_object(
            Bucket=_R2_BUCKET,
            Key=object_key,
            Body=data,
            ContentType=content_type,
            ContentDisposition=f'attachment; filename="{object_key.split("/")[-1]}"',
        )
    except ClientError as exc:
        logger.error("上传文件到 R2 失败: %s", exc)
        raise


def upload_object_from_fileobj(object_key: str, fileobj: BinaryIO, content_type: str | None = None) -> None:
    """从文件对象上传内容到 R2（适合大文件流式上传）."""
    if content_type is None:
        content_type = mimetypes.guess_type(object_key)[0] or "application/octet-stream"

    s3 = _get_s3_client()
    try:
        s3.upload_fileobj(
            fileobj,
            _R2_BUCKET,
            object_key,
            ExtraArgs={
                "ContentType": content_type,
                "ContentDisposition": f'attachment; filename="{object_key.split("/")[-1]}"',
            },
        )
    except ClientError as exc:
        logger.error("上传文件到 R2 失败: %s", exc)
        raise


def delete_object(object_key: str) -> None:
    """从 R2 删除对象."""
    s3 = _get_s3_client()
    try:
        s3.delete_object(Bucket=_R2_BUCKET, Key=object_key)
    except ClientError as exc:
        logger.error("从 R2 删除文件失败: %s", exc)
        raise


def generate_presigned_url(object_key: str, expiration: int = 3600) -> str:
    """生成预签名下载链接.

    Args:
        object_key: R2 对象键。
        expiration: 链接有效期（秒），默认 1 小时。

    Returns:
        可直接在浏览器中访问的预签名 URL。
    """
    s3 = _get_s3_client()
    try:
        return s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": _R2_BUCKET, "Key": object_key},
            ExpiresIn=expiration,
        )
    except ClientError as exc:
        logger.error("生成 R2 预签名链接失败: %s", exc)
        raise


def get_object_url(object_key: str) -> str:
    """获取对象访问 URL.

    优先使用 R2_PUBLIC_URL（如果桶为公开访问并配置了自定义域名），
    否则生成一个短期预签名链接。
    """
    if _R2_PUBLIC_URL:
        base = _R2_PUBLIC_URL.rstrip("/")
        return f"{base}/{object_key}"
    return generate_presigned_url(object_key)


def get_object(object_key: str) -> dict:
    """从 R2 获取对象，返回包含 Body、ContentType、ContentLength 的字典."""
    s3 = _get_s3_client()
    try:
        return s3.get_object(Bucket=_R2_BUCKET, Key=object_key)
    except ClientError as exc:
        logger.error("从 R2 获取文件失败: %s", exc)
        raise
