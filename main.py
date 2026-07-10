"""文件下载中心 - FastAPI 后端入口."""

from __future__ import annotations

import json
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, List

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

# 加载 .env 环境变量
load_dotenv()

from auth.database import Base, engine
from auth.models import User
from auth.router import router as auth_router
from auth.security import require_admin


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期事件：启动时初始化数据库与管理员账号."""
    from init_db import init_database

    Base.metadata.create_all(bind=engine)
    init_database()
    yield


app = FastAPI(title="文件下载中心", lifespan=lifespan)
app.include_router(auth_router)

BASE_DIR = Path(__file__).resolve().parent
# 文件存储目录：优先使用 DATA_DIR 环境变量，便于部署到 Render / Docker 等环境
# Render 免费版磁盘为临时存储，建议在 Render 环境变量中设置 DATA_DIR=/tmp/data
_DATA_DIR = Path(os.environ.get("DATA_DIR", BASE_DIR / "files"))
FILES_DIR = _DATA_DIR
STATIC_DIR = BASE_DIR / "static"
SERIES_META_FILE = FILES_DIR / ".series.json"

# 确保目录存在
FILES_DIR.mkdir(parents=True, exist_ok=True)
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
    if not SAFE_FILENAME_RE.fullmatch(filename):
        return False
    return True


def _is_safe_extension(ext: str) -> bool:
    """校验扩展名是否合法（同时拒绝可执行扩展名）."""
    if not ext:
        return False
    ext_lower = ext.lower()
    if not SAFE_EXT_RE.fullmatch(ext_lower):
        return False
    if ext_lower in BLOCKED_EXTENSIONS:
        return False
    return True


def _format_size(size_bytes: int) -> str:
    """将字节大小转换为人类可读字符串."""
    if size_bytes < 1024:
        return f"{size_bytes} B"
    if size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    if size_bytes < 1024 * 1024 * 1024:
        return f"{size_bytes / (1024 * 1024):.1f} MB"
    return f"{size_bytes / (1024 * 1024 * 1024):.1f} GB"


def _parse_series_version(filename: str) -> tuple[str, str]:
    """从文件名解析系列名与版本号，格式为 {系列}_{版本}.{扩展名}."""
    name = Path(filename).stem  # 移除扩展名
    if "_" not in name:
        return name, ""
    series, version = name.rsplit("_", 1)
    return series, version


def _get_series_files(series: str) -> list[Path]:
    """获取指定系列的所有文件路径."""
    files = []
    for item in FILES_DIR.iterdir():
        if item.is_file() and not item.name.startswith("."):
            s, _ = _parse_series_version(item.name)
            if s == series:
                files.append(item)
    return sorted(files)


def _next_version_number(series: str) -> int:
    """获取该系列下一个可用的版本号."""
    max_version = 0
    for item in _get_series_files(series):
        _, version = _parse_series_version(item.name)
        if version.lower().startswith("v"):
            try:
                num = int(version[1:])
                max_version = max(max_version, num)
            except ValueError:
                pass
    return max_version + 1


def _load_series_meta() -> set[str]:
    """加载已创建的系列名集合。"""
    if not SERIES_META_FILE.exists():
        return set()
    try:
        data = json.loads(SERIES_META_FILE.read_text(encoding="utf-8"))
        return {str(x) for x in data.get("series", [])}
    except (json.JSONDecodeError, OSError):
        return set()


def _save_series_meta(series_set: set[str]) -> None:
    """保存已创建的系列名集合。"""
    SERIES_META_FILE.write_text(
        json.dumps(
            {"series": sorted(series_set)},
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )


def _add_series_meta(series: str) -> None:
    """将系列加入元数据集合。"""
    series_set = _load_series_meta()
    series_set.add(series)
    _save_series_meta(series_set)


def _remove_series_meta(series: str) -> None:
    """从元数据集合中移除系列。"""
    series_set = _load_series_meta()
    if series in series_set:
        series_set.discard(series)
        _save_series_meta(series_set)


def _series_exists(series: str) -> bool:
    """判断系列是否存在（文件或元数据中任一存在）."""
    if series in _load_series_meta():
        return True
    for item in FILES_DIR.iterdir():
        if item.is_file() and not item.name.startswith("."):
            s, _ = _parse_series_version(item.name)
            if s == series:
                return True
    return False


@app.get("/", response_class=HTMLResponse)
async def index() -> str:
    """返回首页 HTML."""
    index_path = STATIC_DIR / "index.html"
    if not index_path.exists():
        raise HTTPException(status_code=404, detail="首页文件不存在")
    return index_path.read_text(encoding="utf-8")


@app.get("/files")
async def list_files() -> List[dict]:
    """返回按系列分组的可下载文件列表，支持任意扩展名。"""
    groups: dict[str, list[dict]] = {}

    # 先添加已有文件的系列
    for item in sorted(FILES_DIR.iterdir()):
        if item.is_file() and not item.name.startswith("."):
            series, version = _parse_series_version(item.name)
            ext = item.suffix
            # 显示用版本号 = 解析出的版本号 + 原扩展名（如 v1.pdf、v2.docx）
            display_version = f"{version}{ext}" if version else item.name
            groups.setdefault(series, []).append({
                "name": item.name,
                "version": display_version,
                "size": _format_size(item.stat().st_size),
            })

    # 再补充仅有元数据但还没有文件的空系列
    for series in _load_series_meta():
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
    name: str = Form(...),
) -> JSONResponse:
    """创建新系列（不再生成占位文件，系列独立于具体文件类型）。"""
    if not _is_safe_series_name(name):
        raise HTTPException(status_code=400, detail="非法系列名")

    if _series_exists(name):
        raise HTTPException(status_code=409, detail="系列已存在")

    _add_series_meta(name)
    return JSONResponse({"series": name, "message": "系列创建成功"})


@app.post("/api/series/{series}/files")
async def upload_file(
    series: str,
    current_user: Annotated[User, Depends(require_admin)],
    file: UploadFile = File(...),
) -> JSONResponse:
    """向指定系列上传任意类型文件，自动命名为 {series}_vN.{原扩展名}。"""
    if not _is_safe_series_name(series):
        raise HTTPException(status_code=400, detail="非法系列名")

    if not _series_exists(series):
        raise HTTPException(status_code=404, detail="系列不存在")

    if not file.filename:
        raise HTTPException(status_code=400, detail="文件名为空")

    # 解析并校验扩展名
    original_ext = Path(file.filename).suffix
    if not _is_safe_extension(original_ext.lower()):
        raise HTTPException(status_code=400, detail="非法的文件扩展名")

    # 读取文件内容（二进制）
    content = await file.read()

    next_version = _next_version_number(series)
    safe_ext = original_ext.lower()
    filename = f"{series}_v{next_version}{safe_ext}"
    target = FILES_DIR / filename

    # 防止意外冲突
    while target.exists():
        next_version += 1
        filename = f"{series}_v{next_version}{safe_ext}"
        target = FILES_DIR / filename

    target.write_bytes(content)
    return JSONResponse({"filename": filename, "message": "上传成功"})


@app.delete("/api/series/{series}")
async def delete_series(
    series: str,
    current_user: Annotated[User, Depends(require_admin)],
) -> JSONResponse:
    """删除整个系列及其所有文件。"""
    if not _is_safe_series_name(series):
        raise HTTPException(status_code=400, detail="非法系列名")

    deleted = 0
    for item in _get_series_files(series):
        item.unlink()
        deleted += 1

    _remove_series_meta(series)

    if deleted == 0 and not _series_exists(series):
        raise HTTPException(status_code=404, detail="系列不存在")

    return JSONResponse(
        {"message": f"系列 {series} 及其 {deleted} 个文件已删除"},
    )


@app.delete("/api/series/{series}/files/{filename}")
async def delete_file(
    series: str,
    filename: str,
    current_user: Annotated[User, Depends(require_admin)],
) -> JSONResponse:
    """删除系列内指定文件。"""
    if not _is_safe_series_name(series):
        raise HTTPException(status_code=400, detail="非法系列名")
    if not _is_safe_filename(filename):
        raise HTTPException(status_code=400, detail="非法文件名")

    file_series, _ = _parse_series_version(filename)
    if file_series != series:
        raise HTTPException(status_code=400, detail="文件不属于该系列")

    file_path = FILES_DIR / filename
    # 再次确保解析后的路径仍在 FILES_DIR 内
    if not str(file_path.resolve()).startswith(str(FILES_DIR.resolve())):
        raise HTTPException(status_code=400, detail="非法文件路径")

    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")

    file_path.unlink()
    return JSONResponse({"message": f"文件 {filename} 已删除"})


@app.get("/download/{filename}")
async def download_file(filename: str) -> FileResponse:
    """下载指定文件，支持任意扩展名。"""
    if not _is_safe_filename(filename):
        raise HTTPException(status_code=400, detail="非法文件名")

    file_path = FILES_DIR / filename
    # 再次确保解析后的路径仍在 FILES_DIR 内
    if not str(file_path.resolve()).startswith(str(FILES_DIR.resolve())):
        raise HTTPException(status_code=400, detail="非法文件路径")

    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")

    return FileResponse(
        path=file_path,
        filename=filename,
        media_type="application/octet-stream",
    )


@app.post("/api/admin/reset-password")
async def reset_admin_password(
    token: str,
    new_password: str,
) -> JSONResponse:
    """紧急重置管理员密码（无需登录）。

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

    from auth.database import SessionLocal  # noqa: WPS433
    from auth.models import User  # noqa: WPS433
    from auth.security import get_password_hash  # noqa: WPS433

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
    """诊断端点：返回管理员账号状态、数据库路径、JWT 配置（不泄露密钥）。

    用于部署后排查登录问题，无需鉴权（仅返回只读信息）。
    """
    from auth.database import DB_PATH, SessionLocal  # noqa: WPS433
    from auth.models import User  # noqa: WPS433

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
        "db_path": str(DB_PATH),
        "db_exists": DB_PATH.exists(),
        "data_dir": str(FILES_DIR),
        "admin_username": admin_username,
        "admin_exists": admin_info is not None,
        "admin_info": admin_info,
        "secret_key_configured": secret_configured,
        "reset_endpoint_available": bool(os.environ.get("ADMIN_INIT_TOKEN")),
    })


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "1234")))
