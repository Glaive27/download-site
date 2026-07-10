"""文件下载中心 - FastAPI 后端入口.

文件持久化存储：PostgreSQL 数据库（文件二进制直接存入 file_records.file_data）
数据库：Render PostgreSQL（DATABASE_URL），本地开发回退到 SQLite
"""

from __future__ import annotations

import os
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, List

import logging
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session

# 加载 .env 环境变量
load_dotenv()

from auth.database import Base, SessionLocal, engine, get_db
from auth.models import FileRecord, Series, User
from auth.router import router as auth_router
from auth.security import require_admin
from storage import delete_object, r2_enabled


logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期事件：启动时初始化数据库与管理员账号."""
    from init_db import init_database

    Base.metadata.create_all(bind=engine)
    init_database()
    yield


app = FastAPI(title="文件下载中心", lifespan=lifespan)
app.include_router(auth_router)


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """全局兜底异常处理器：返回 JSON 错误详情，便于线上排查."""
    import traceback

    logger.error("Unhandled exception at %s %s: %s\n%s",
                 request.method, request.url.path, exc, traceback.format_exc())
    return JSONResponse(
        status_code=500,
        content={
            "detail": f"{type(exc).__name__}: {exc}",
            "path": request.url.path,
        },
    )


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
STATIC_DIR.mkdir(parents=True, exist_ok=True)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# 系列名允许的字符：字母、数字、下划线、连字符、中文
SAFE_NAME_RE = re.compile(r"^[\w\-\u4e00-\u9fa5]+$")
# 文件名主体允许的字符：字母、数字、下划线、连字符、点、空格、中文
SAFE_FILENAME_RE = re.compile(r"^[\w\-.\u4e00-\u9fa5 ]+$")
# 扩展名仅允许字母与数字，长度 1-10
SAFE_EXT_RE = re.compile(r"^\.[A-Za-z0-9]{1,10}$")
# 黑名单扩展名（避免可执行脚本带来的安全风险）
BLOCKED_EXTENSIONS = {
    ".py",
    ".pyc",
    ".sh",
    ".bat",
    ".cmd",
    ".exe",
    ".msi",
    ".dll",
    ".com",
    ".scr",
}


def _is_safe_series_name(name: str) -> bool:
    """校验系列名是否安全."""
    return bool(SAFE_NAME_RE.fullmatch(name)) and not name.startswith("_")


def _is_safe_filename(filename: str) -> bool:
    """校验文件名是否安全，防止路径遍历与非法字符."""
    if not filename:
        return False
    if "/" in filename or "\\" in filename or "\0" in filename:
        return False
    if filename.startswith("."):
        return False
    return bool(SAFE_FILENAME_RE.fullmatch(filename))


def _is_safe_extension(ext: str) -> bool:
    """校验扩展名是否合法（同时拒绝可执行扩展名）."""
    if not ext:
        return False
    ext_lower = ext.lower()
    if not SAFE_EXT_RE.fullmatch(ext_lower):
        return False
    return ext_lower not in BLOCKED_EXTENSIONS


def _format_size(size_bytes: int) -> str:
    """将字节大小转换为人类可读字符串."""
    if size_bytes < 1024:
        return f"{size_bytes} B"
    if size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    if size_bytes < 1024 * 1024 * 1024:
        return f"{size_bytes / (1024 * 1024):.1f} MB"
    return f"{size_bytes / (1024 * 1024 * 1024):.1f} GB"


def _build_object_key(series: str, filename: str) -> str:
    """构建对象键（历史遗留，现仅用于占位）."""
    return f"{series}/{filename}"


def _next_version_number(db: Session, series: str) -> int:
    """获取该系列下一个可用的版本号."""
    records = db.query(FileRecord).filter(FileRecord.series == series).all()
    max_version = 0
    for record in records:
        version = record.version
        if version.lower().startswith("v"):
            try:
                num = int(version[1:])
                max_version = max(max_version, num)
            except ValueError:
                pass
    return max_version + 1


@app.get("/", response_class=HTMLResponse)
async def index() -> str:
    """返回首页 HTML."""
    index_path = STATIC_DIR / "index.html"
    if not index_path.exists():
        raise HTTPException(status_code=404, detail="首页文件不存在")
    return index_path.read_text(encoding="utf-8")


@app.get("/files")
async def list_files(
    db: Annotated[Session, Depends(get_db)],
) -> List[dict]:
    """返回按系列分组的可下载文件列表."""
    records = db.query(FileRecord).order_by(FileRecord.filename).all()
    series_names = {s.name for s in db.query(Series).all()}

    groups: dict[str, list[dict]] = {}
    for record in records:
        ext = Path(record.filename).suffix
        display_version = f"{record.version}{ext}" if record.version else record.filename
        groups.setdefault(record.series, []).append({
            "name": record.filename,
            "version": display_version,
            "size": _format_size(record.size),
        })

    # 补充空系列
    for series in series_names:
        groups.setdefault(series, [])

    result = []
    for series in sorted(groups.keys()):
        result.append({
            "series": series,
            "versions": sorted(groups[series], key=lambda x: x["name"]),
        })
    return result


@app.post("/api/series")
async def create_series(
    current_user: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_db)],
    name: str = Form(...),
) -> JSONResponse:
    """创建新系列."""
    name = name.strip()
    if not _is_safe_series_name(name):
        raise HTTPException(status_code=400, detail="非法系列名")

    existing = db.query(Series).filter(Series.name == name).first()
    if existing:
        raise HTTPException(status_code=409, detail="系列已存在")

    series = Series(name=name)
    db.add(series)
    db.commit()
    return JSONResponse({"series": name, "message": "系列创建成功"})


@app.post("/api/series/{series}/files")
async def upload_file(
    series: str,
    current_user: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_db)],
    file: UploadFile = File(...),
) -> JSONResponse:
    """向指定系列上传文件，自动命名并将文件二进制存入数据库."""
    if not r2_enabled():
        raise HTTPException(
            status_code=503,
            detail="存储服务不可用",
        )

    if not _is_safe_series_name(series):
        raise HTTPException(status_code=400, detail="非法系列名")

    if not file.filename:
        raise HTTPException(status_code=400, detail="文件名为空")

    original_ext = Path(file.filename).suffix
    if not _is_safe_extension(original_ext.lower()):
        raise HTTPException(status_code=400, detail="非法的文件扩展名")

    series_obj = db.query(Series).filter(Series.name == series).first()
    if not series_obj:
        raise HTTPException(status_code=404, detail="系列不存在")

    content = await file.read()
    size = len(content)
    mime_type = file.content_type or "application/octet-stream"

    next_version = _next_version_number(db, series)
    safe_ext = original_ext.lower()
    filename = f"{series}_v{next_version}{safe_ext}"

    # 防止版本号冲突（理论上不会发生，但做兜底）
    while db.query(FileRecord).filter(FileRecord.filename == filename).first():
        next_version += 1
        filename = f"{series}_v{next_version}{safe_ext}"

    object_key = "legacy"

    record = FileRecord(
        series=series,
        filename=filename,
        version=f"v{next_version}",
        size=size,
        mime_type=mime_type,
        object_key=object_key,
        file_data=content,
        file_mime=mime_type,
    )
    db.add(record)
    db.commit()

    await file.close()
    return JSONResponse({"filename": filename, "message": "上传成功"})


@app.delete("/api/series/{series}")
async def delete_series(
    series: str,
    current_user: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> JSONResponse:
    """删除整个系列及其所有文件记录."""
    if not _is_safe_series_name(series):
        raise HTTPException(status_code=400, detail="非法系列名")

    records = db.query(FileRecord).filter(FileRecord.series == series).all()
    if not records:
        series_obj = db.query(Series).filter(Series.name == series).first()
        if not series_obj:
            raise HTTPException(status_code=404, detail="系列不存在")

    deleted = 0
    for record in records:
        if r2_enabled():
            try:
                delete_object(record.object_key)
            except Exception as exc:
                raise HTTPException(
                    status_code=500,
                    detail=f"删除对象失败: {exc}",
                ) from exc
        db.delete(record)
        deleted += 1

    series_obj = db.query(Series).filter(Series.name == series).first()
    if series_obj:
        db.delete(series_obj)

    db.commit()
    return JSONResponse(
        {"message": f"系列 {series} 及其 {deleted} 个文件已删除"},
    )


@app.delete("/api/series/{series}/files/{filename}")
async def delete_file(
    series: str,
    filename: str,
    current_user: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> JSONResponse:
    """删除系列内指定文件（数据库记录 + 二进制数据）."""
    if not _is_safe_series_name(series):
        raise HTTPException(status_code=400, detail="非法系列名")
    if not _is_safe_filename(filename):
        raise HTTPException(status_code=400, detail="非法文件名")

    record = (
        db.query(FileRecord)
        .filter(FileRecord.series == series, FileRecord.filename == filename)
        .first()
    )
    if not record:
        raise HTTPException(status_code=404, detail="文件不存在")

    if r2_enabled():
        try:
            delete_object(record.object_key)
        except Exception as exc:
            raise HTTPException(
                status_code=500,
                detail=f"删除对象失败: {exc}",
            ) from exc

    db.delete(record)
    db.commit()
    return JSONResponse({"message": f"文件 {filename} 已删除"})


@app.get("/download/{filename}")
async def download_file(
    filename: str,
    db: Annotated[Session, Depends(get_db)],
):
    """下载指定文件：从数据库读取二进制内容并直接返回文件流."""
    if not _is_safe_filename(filename):
        raise HTTPException(status_code=400, detail="非法文件名")

    record = db.query(FileRecord).filter(FileRecord.filename == filename).first()
    if not record:
        raise HTTPException(status_code=404, detail="文件不存在")

    if not record.file_data:
        raise HTTPException(status_code=404, detail="文件内容不存在")

    return Response(
        content=record.file_data,
        media_type=record.file_mime,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/admin/reset-password")
async def reset_admin_password(
    token: str,
    new_password: str,
) -> JSONResponse:
    """紧急重置管理员密码（无需登录）.

    需要同时满足以下条件：
    1. 环境变量 ``ADMIN_INIT_TOKEN`` 已设置且与请求中的 ``token`` 匹配
    2. ``new_password`` 长度 ≥ 6
    3. 请求来自非 GET 方法（仅 POST 暴露，避免日志泄露）

    适用场景：在 Render 上忘记管理员密码但无法 SSH / Shell 进入容器时，
    通过 Render Dashboard 的 Shell 或一次性 curl 调用重置。

    使用示例（部署完成后调用一次）::

        curl -X POST "$RENDER_URL/api/admin/reset-password?token=$TOKEN&new_password=$NEW_PW"
    """
    expected = os.environ.get("ADMIN_INIT_TOKEN", "")
    if not expected:
        raise HTTPException(
            status_code=503,
            detail="ADMIN_INIT_TOKEN 未配置，无法重置密码",
        )
    if token != expected:
        raise HTTPException(status_code=403, detail="token 不正确")
    if len(new_password) < 6:
        raise HTTPException(status_code=400, detail="密码长度至少 6 位")

    from auth.security import get_password_hash

    admin_username = os.environ.get("ADMIN_USERNAME", "Glaive").strip() or "Glaive"
    db = SessionLocal()
    try:
        admin = db.query(User).filter(User.username == admin_username).first()
        if admin is None:
            admin = User(
                username=admin_username,
                hashed_password=get_password_hash(new_password),
                role="admin",
            )
            db.add(admin)
        else:
            admin.hashed_password = get_password_hash(new_password)
        db.commit()
    finally:
        db.close()

    return JSONResponse({
        "message": f"管理员 {admin_username} 密码已重置",
        "username": admin_username,
    })


@app.get("/api/admin/diag")
async def admin_diag() -> JSONResponse:
    """诊断端点：返回管理员账号状态与存储配置（不泄露密钥）.

    用于部署后排查登录问题，无需鉴权（仅返回只读信息）。
    """
    admin_username = os.environ.get("ADMIN_USERNAME", "Glaive").strip() or "Glaive"
    secret_configured = bool(os.environ.get("SECRET_KEY"))

    db = SessionLocal()
    try:
        admin = db.query(User).filter(User.username == admin_username).first()
        admin_info = None
        if admin is not None:
            admin_info = {
                "username": admin.username,
                "role": admin.role,
                "id": admin.id,
            }
    finally:
        db.close()

    return JSONResponse({
        "database_url_configured": bool(os.environ.get("DATABASE_URL")),
        "r2_configured": r2_enabled(),
        "admin_username": admin_username,
        "admin_exists": admin_info is not None,
        "admin_info": admin_info,
        "secret_key_configured": secret_configured,
        "reset_endpoint_available": bool(os.environ.get("ADMIN_INIT_TOKEN")),
    })


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "1234")))
