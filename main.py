"""文件下载中心 - FastAPI 后端入口.

文件持久化存储：PostgreSQL 数据库（文件二进制直接存入 file_records.file_data）
数据库：Render PostgreSQL（DATABASE_URL），本地开发回退到 SQLite
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, List
from urllib.parse import quote

import logging
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile, status, Body
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
import httpx
from sqlalchemy.orm import Session
from sqlalchemy import text

# 加载 .env 环境变量
load_dotenv()

from auth.database import Base, SessionLocal, engine, get_db
from auth.models import DownloadLog, FileRecord, Series, SiteConfig, UniqueVisitor, User, _utcnow
from auth.schemas import BehaviorReport, BehaviorReverify, TrajectoryVerdict
from altcha import create_challenge_v1
from auth.router import router as auth_router
from auth.altcha import ALTCHA_HMAC_KEY, verify_altcha
from auth.security import get_current_user, require_admin
from storage import delete_object, r2_enabled

# 行为式人机认证：风险分达到该阈值即标记该用户需二次验证 / 限制操作
BEHAVIOR_RISK_THRESHOLD = 0.6

# 不活跃账号自动管理（仅针对「注册后从未下载文件」的普通账号，管理员豁免）：
# - 超过 ACCOUNT_RISK_DAYS 天未上线  → 标记为高危账号（high_risk=True）
# - 超过 ACCOUNT_DELETE_DAYS 天未上线 → 直接注销账号
# 均可通过环境变量覆盖，方便按运营需要调整（单位：天）。
ACCOUNT_RISK_DAYS = int(os.environ.get("ACCOUNT_RISK_DAYS", "5"))
ACCOUNT_DELETE_DAYS = int(os.environ.get("ACCOUNT_DELETE_DAYS", "10"))
# 后台清理任务的扫描间隔（秒），默认 1 小时扫描一次
ACCOUNT_SWEEP_INTERVAL_SECONDS = int(os.environ.get("ACCOUNT_SWEEP_INTERVAL_SECONDS", "3600"))

# 数据库存储额度（字节）：用于「数据记录」弹窗展示剩余空间进度条。
# Render 免费 PostgreSQL 实例磁盘上限为 1 GB；若使用更高套餐请相应调大。
# 该值仅用于前端展示剩余额度，不影响数据库实际写入（由数据库自身限制）。
DATABASE_QUOTA_BYTES = int(os.environ.get("DATABASE_QUOTA_BYTES", str(1024 * 1024 * 1024)))

# 英伟达 NIM API（用于 AI 风险用户分析）
# 优先读取环境变量，未设置时回退到数据库 site_config 表（key="nvidia_api_key"）
NVIDIA_API_BASE = "https://integrate.api.nvidia.com/v1"
NVIDIA_RISK_MODEL = os.environ.get("NVIDIA_RISK_MODEL", "deepseek-ai/deepseek-v4-flash")


def _get_nvidia_api_key(db: Session | None = None) -> str:
    """获取英伟达 API Key：环境变量优先，否则从数据库 site_config 读取.

    若传入 db 会话则直接查询；否则临时创建一次性会话查询。
    """
    env_key = os.environ.get("NVIDIA_API_KEY", "").strip()
    if env_key:
        return env_key

    from auth.models import SiteConfig
    if db is not None:
        row = db.query(SiteConfig).filter(SiteConfig.key == "nvidia_api_key").first()
        return row.value.strip() if row and row.value else ""
    try:
        with SessionLocal() as s:
            row = s.query(SiteConfig).filter(SiteConfig.key == "nvidia_api_key").first()
            return row.value.strip() if row and row.value else ""
    except Exception:
        return ""


logger = logging.getLogger(__name__)


def get_database_size_bytes(session: Session) -> int:
    """返回当前数据库已占用空间（字节）.

    - PostgreSQL：使用 ``pg_database_size(current_database())`` 获取整库大小。
    - SQLite：返回数据库文件在磁盘上的大小（文件型存储）。
    - 其它 / 异常：返回 0（额度进度条退化为「未知」显示）。
    """
    try:
        dialect = engine.dialect.name
        if dialect == "postgresql":
            return int(session.execute(
                text("SELECT pg_database_size(current_database())")
            ).scalar() or 0)
        if dialect == "sqlite":
            db_path = engine.url.database
            if db_path and os.path.exists(db_path):
                return os.path.getsize(db_path)
    except Exception:  # noqa: BLE001 - 额度探测失败不应影响主流程
        logger.exception("获取数据库大小失败，将按 0 处理")
    return 0


# ---------------------------------------------------------------------------
# IP 地理位置解析（用于管理员查看用户登录来源）
# ---------------------------------------------------------------------------
import json as _json
from urllib.request import urlopen, Request as _UrlReq
from urllib.error import URLError

_IP_GEO_CACHE: dict[str, str] = {}   # IP → "国家·城市" 缓存，避免重复请求
_IP_GEO_CACHE_TTL = 3600             # 缓存有效期（秒）
_IP_REFRESH_INTERVAL = 120          # 同一 IP 两次解析之间的最小间隔（秒），用于节流


def _get_client_ip(request: Request) -> str | None:
    """从请求中提取客户端真实 IP（兼容反向代理 / Render）."""
    # 优先取 X-Forwarded-For（代理链中的第一个真实 IP）
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    # 回退到直接连接的远程地址
    return request.client.host if request.client else None


def _resolve_ip_location(ip: str) -> str:
    """解析 IP 地址为地理位置字符串（如"中国·广东·广州"）。

    使用免费接口 ip-api.com（中文模式），结果缓存 1 小时。
    解析失败时返回空字符串（不影响主流程）。
    """
    if not ip or ip in ("127.0.0.1", "::1", "localhost", "testclient"):
        return "本地"

    cached = _IP_GEO_CACHE.get(ip)
    if cached:
        return cached

    try:
        req = _UrlReq(f"http://ip-api.com/json/{ip}?lang=zh-CN", headers={"User-Agent": "download-site/1.0"})
        with urlopen(req, timeout=3) as resp:
            data = _json.loads(resp.read())
        if data.get("status") == "success":
            parts = [data.get("country", ""), data.get("regionName", ""), data.get("city", "")]
            # 过滤掉空值和重复值（如 country==regionName 时去重）
            parts = [p for p in parts if p]
            location = "·".join(dict.fromkeys(parts))   # 去重保序
        else:
            location = ""
    except (URLError, OSError, ValueError, KeyError):
        logger.warning("IP 地理位置 %s 解析失败", ip)
        location = ""

    if location:
        _IP_GEO_CACHE[ip] = location
    return location


def _record_user_ip(user: User, request: Request, db: Session) -> None:
    """在注册或登录时记录用户的 IP 和地理位置."""
    ip = _get_client_ip(request)
    user.last_login_ip = ip
    user.last_login_location = _resolve_ip_location(ip) if ip else None
    user.last_ip_check_at = _utcnow()
    db.commit()


def refresh_user_location(user: User, request: Request, db: Session) -> None:
    """实时刷新用户 IP 归属地（由会话状态轮询周期性调用）.

    - 每次都检测当前 IP。
    - IP 发生变化（如切换 VPN）→ 立即重新解析并记录。
    - IP 未变 → 仅在距上次解析超过 ``_IP_REFRESH_INTERVAL`` 时才重新解析，
      避免对解析接口造成频繁请求（ip-api 免费版限 45 次/分钟）。
    解析失败时静默跳过，不影响主流程。
    """
    ip = _get_client_ip(request)
    if not ip:
        return

    now = _utcnow()
    last_check = user.last_ip_check_at
    # IP 未变化且距上次检测不足节流间隔 → 跳过
    if ip == user.last_login_ip and last_check is not None:
        elapsed = (now - last_check).total_seconds()
        if elapsed < _IP_REFRESH_INTERVAL:
            return

    # IP 变了（或首次/超时）：重新解析。_resolve_ip_location 内部有 1h 结果缓存，
    # 对已经解析过的 IP 会直接命中缓存，不发起网络请求。
    location = _resolve_ip_location(ip)
    # 重新在 db 会话中加载用户对象（current_user 属于 get_current_user 的独立会话，
    # 直接修改它再 db.commit() 不会持久化），确保在正确的会话中写入。
    db_user = db.query(User).filter_by(id=user.id).first()
    if db_user is None:
        return
    db_user.last_login_ip = ip
    db_user.last_login_location = location or None
    db_user.last_ip_check_at = now
    db.commit()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期事件：启动时初始化数据库与管理员账号，并启动不活跃账号清理任务."""
    from init_db import init_database

    Base.metadata.create_all(bind=engine)
    init_database()

    # 启动后台任务：周期性扫描并清理长期不活跃且从未下载的账号
    sweep_task = asyncio.create_task(_inactivity_sweep_loop())
    try:
        yield
    finally:
        sweep_task.cancel()
        try:
            await sweep_task
        except asyncio.CancelledError:
            pass


app = FastAPI(title="文件下载中心", lifespan=lifespan)
app.include_router(auth_router)


async def _inactivity_sweep_loop() -> None:
    """后台循环：每隔 ACCOUNT_SWEEP_INTERVAL_SECONDS 秒执行一次不活跃账号清理.

    用 ``asyncio.to_thread`` 在 worker 线程中运行同步的 DB 扫描，避免阻塞事件循环。
    任务在应用关闭时由 lifespan 取消。
    """
    while True:
        await asyncio.sleep(ACCOUNT_SWEEP_INTERVAL_SECONDS)
        try:
            await asyncio.to_thread(sweep_inactive_accounts)
        except Exception:  # noqa: BLE001
            logger.exception("不活跃账号清理任务执行出错（已忽略，下次重试）")


def sweep_inactive_accounts(db: Session | None = None) -> dict:
    """扫描并清理长期不活跃且从未下载文件的普通账号.

    规则（仅作用于 role=='user' 且 download_count==0 的账号，管理员豁免）：
    - 距 ``last_login`` 超过 ``ACCOUNT_DELETE_DAYS`` 天 → 直接注销
    - 距 ``last_login`` 超过 ``ACCOUNT_RISK_DAYS`` 天 → 标记为高危账号

    :param db: 可选会话；不传入时内部新建并关闭一个全局会话（供测试注入使用）。
    返回本次处理的统计信息（deleted / flagged 数量）。
    """
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    risk_cutoff = now - timedelta(days=ACCOUNT_RISK_DAYS)
    delete_cutoff = now - timedelta(days=ACCOUNT_DELETE_DAYS)

    deleted = 0
    flagged = 0

    own_session = db is None
    if own_session:
        db = SessionLocal()
    try:
        # 从未下载过文件的普通账号（download_count 为 0 或历史缺失为 NULL）
        candidates = (
            db.query(User)
            .filter(
                User.role != "admin",
                (User.download_count == 0) | (User.download_count.is_(None)),
            )
            .all()
        )
        for user in candidates:
            last = user.last_login or now
            # 数据库读回的 DateTime 可能为 naive（SQLite/PG 无时区列），统一转 naive UTC 比较
            if last.tzinfo is not None:
                last = last.replace(tzinfo=None)
            if last <= delete_cutoff:
                # 超期未上线：直接注销（先清理其下载日志，避免外键残留）
                db.query(DownloadLog).filter(DownloadLog.user_id == user.id).delete()
                db.delete(user)
                deleted += 1
            elif last <= risk_cutoff and not user.high_risk:
                user.high_risk = True
                flagged += 1
        db.commit()
    except Exception:
        db.rollback()
        logger.exception("扫描不活跃账号时出错，已回滚")
        raise
    finally:
        if own_session:
            db.close()

    if deleted or flagged:
        logger.info(
            "不活跃账号清理完成：注销 %d 个，标记高危 %d 个", deleted, flagged,
        )
    return {"deleted": deleted, "flagged": flagged}



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


# ---------------------------------------------------------------------------
# 当前在线访问数统计（内存结构，适用于单实例部署）
# 记录每个访问会话最近一次活动的时间戳；超过窗口未活动视为离线。
# ---------------------------------------------------------------------------
# 在线会话追踪（内存）：{session_id: {"ts": timestamp, "username": str|None}}
ACTIVE_SESSIONS: dict[str, dict] = {}
ACTIVE_SESSIONS_LOCK = threading.Lock()
ACTIVE_WINDOW_SECONDS = 60  # 超过该时长未发送心跳即视为离线


def _prune_active_sessions() -> None:
    """清理过期的会话记录，防止内存无限增长."""
    now = time.time()
    cutoff = now - ACTIVE_WINDOW_SECONDS
    dead = [sid for sid, info in ACTIVE_SESSIONS.items() if info["ts"] < cutoff]
    for sid in dead:
        ACTIVE_SESSIONS.pop(sid, None)


def _count_active_sessions() -> int:
    """返回当前在线（活跃）的访问会话数量，非累计值."""
    _prune_active_sessions()
    return len(ACTIVE_SESSIONS)


def _get_active_users_list() -> list[dict]:
    """返回当前在线用户列表（含用户名与最后活跃时间），仅管理员使用."""
    from auth.security import decode_access_token, JWTError
    _prune_active_sessions()
    results = []
    seen_usernames: set[str] = set()
    for sid, info in ACTIVE_SESSIONS.items():
        uname = info.get("username")
        entry = {
            "session_id": sid[:8] + "...",  # 仅展示前几位，不泄露完整 ID
            "username": uname or "匿名访客",
            "last_active_at": datetime.fromtimestamp(info["ts"], tz=timezone.utc).isoformat(),
        }
        # 去重：同一用户多设备/标签页只保留最新一条
        if uname:
            if uname not in seen_usernames:
                seen_usernames.add(uname)
                results.append(entry)
        else:
            results.append(entry)
    # 按最后活跃时间倒序
    results.sort(key=lambda x: x["last_active_at"], reverse=True)
    return results


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


@app.get("/api/health")
async def health_check(db: Annotated[Session, Depends(get_db)]) -> JSONResponse:
    """轻量级健康检查 + 保活探针.

    - 执行一次极轻的数据库查询（SELECT 1），用于在免费实例休眠后
      顺带唤醒数据库，避免首个真实请求才触发漫长的冷启动。
    - 被外部监控（如 UptimeRobot）或定时任务周期ping时，可让 Web 与
      数据库都保持活跃，从而让用户（含手机端）随时访问都即时可用。
    """
    try:
        db.execute(text("SELECT 1"))
        db_ok = True
    except Exception:  # noqa: BLE001
        db_ok = False
    return JSONResponse({"status": "ok", "db": db_ok})


@app.get("/files")
async def list_files(
    db: Annotated[Session, Depends(get_db)],
) -> List[dict]:
    """返回按系列分组的可下载文件列表."""
    records = db.query(FileRecord).order_by(FileRecord.filename).all()
    series_names = {s.name for s in db.query(Series).all()}

    groups: dict[str, list[dict]] = {}
    for record in records:
        # 优先显示原始上传的文件名，若没有则使用 version + 扩展名
        display_name = record.original_filename if record.original_filename else f"{record.version}{Path(record.filename).suffix}"
        groups.setdefault(record.series, []).append({
            "name": record.filename,
            "version": display_name,
            "size": _format_size(record.size),
            "description": record.description or "",
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

    object_key = _build_object_key(series, filename)

    record = FileRecord(
        series=series,
        filename=filename,
        original_filename=file.filename,
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

    db.delete(record)
    db.commit()
    return JSONResponse({"message": f"文件 {filename} 已删除"})


@app.put("/api/series/{series}/files/{filename}/description")
async def update_file_description(
    series: str,
    filename: str,
    body: dict,
    current_user: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> JSONResponse:
    """管理员更新文件简介（仅管理员可用）."""
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

    new_desc = (body.get("description") or "").strip()[:512]
    record.description = new_desc
    db.commit()
    return JSONResponse({"ok": True, "description": record.description})


def require_behavior_ok(
    current_user: Annotated[User, Depends(get_current_user)],
) -> User:
    """行为式人机认证守卫：被标记异常的用户需先完成二次验证.

    与 ``get_current_user`` 组合使用；命中则返回 401（detail 以 BEHAVIOR_REVERIFY
    开头），前端据此弹出轻量二次验证（ALTCHA）并在通过后清除标记、重试原请求。
    """
    if current_user.behavior_flagged:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="BEHAVIOR_REVERIFY: 检测到异常操作，请完成人机验证",
        )
    return current_user


def require_behavior_ok_admin(
    current_user: Annotated[User, Depends(require_admin)],
) -> User:
    """行为守卫的管理员版本（先校验管理员，再校验行为标记）."""
    if current_user.behavior_flagged:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="BEHAVIOR_REVERIFY: 检测到异常操作，请完成人机验证",
        )
    return current_user


@app.post("/api/behavior/report")
async def behavior_report(
    payload: Annotated[BehaviorReport, Body()],
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> JSONResponse:
    """接收前端鼠标轨迹分析得出的风险评分，更新该用户的行为风险与标记.

    仅记录聚合特征（风险分 + 少量统计量），不保存任何原始鼠标坐标，兼顾性能与隐私。
    风险达到阈值即标记 ``behavior_flagged``，后续受保护操作会被守卫拦截并要求二次验证。
    """
    risk = float(payload.risk_score)
    flagged = risk >= BEHAVIOR_RISK_THRESHOLD or payload.verdict == "suspicious"
    current_user.behavior_risk = risk
    current_user.behavior_flagged = flagged
    db.commit()
    return JSONResponse({"flagged": flagged, "risk": round(risk, 3)})


@app.post("/api/behavior/reverify")
async def behavior_reverify(
    payload: Annotated[BehaviorReverify, Body()],
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> JSONResponse:
    """行为异常后的二次验证：通过 ALTCHA 即清除该用户的行为标记，恢复操作权限."""
    verify_altcha(payload.altcha)
    current_user.behavior_flagged = False
    current_user.behavior_risk = 0.0
    db.commit()
    return JSONResponse({"ok": True})


@app.post("/api/behavior/reverify_trajectory")
async def behavior_reverify_trajectory(
    payload: Annotated[TrajectoryVerdict, Body()],
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> JSONResponse:
    """行为异常后的二次验证（鼠标轨迹版）：前端完成轨迹分析判定 human 后调用本接口清标记.

    验证逻辑（轨迹连续性 / 随机性 / 自然抖动 / 人类置信度阈值）完全在前端完成，
    以取得最优的性能与响应速度。服务端仅做特征合理性复核（拒绝明显伪造的判定），
    再清除行为标记、恢复操作权限。
    """
    if payload.verdict != "human" or payload.confidence < 0.5:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="验证未通过：轨迹判定非真人",
        )
    feats = payload.features or {}
    samples = int(payload.samples or 0)
    speed_cv = float(feats.get("speed_cv", 0) or 0)
    jitter = float(feats.get("jitter_ratio", 0) or 0)
    dir_entropy = float(feats.get("dir_entropy", 0) or 0)
    # 合理性复核：要求具备人类轨迹的基本特征（足够样本，且速度有变化 / 存在自然抖动 / 方向多样）
    if samples < 25 or (speed_cv < 0.05 and jitter < 0.01 and dir_entropy < 0.5):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="轨迹特征不足，请重新验证",
        )
    current_user.behavior_flagged = False
    current_user.behavior_risk = 0.0
    db.commit()
    return JSONResponse({"ok": True})


@app.get("/api/session/status")
async def session_status(
    request: Request,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> JSONResponse:
    """会话状态探针（已登录用户定期轮询）.

    用于跨浏览器账号状态同步与实时异常推送：
    - 账号被管理员删除后，``get_current_user`` 因用户不存在而返回 401，
      前端轮询到 401 即弹出「异常行为检测」提示并强制登出（数秒内生效）。
    - 正常返回 ``{valid, flagged}``：``flagged`` 表示是否因行为异常需复核。
    - 每次轮询实时刷新用户 IP 归属地（切换 VPN 后数秒内即可在管理员界面看到变化）。
    """
    # 实时刷新 IP 归属地（内部带节流，不会频繁请求解析接口）
    try:
        refresh_user_location(current_user, request, db)
    except Exception:  # noqa: BLE001 - IP 刷新失败绝不影响主流程
        logger.exception("实时刷新 IP 归属地失败（已忽略）")

    return JSONResponse({
        "valid": True,
        "flagged": bool(current_user.behavior_flagged),
    })


@app.get("/download/{filename}")
async def download_file(
    filename: str,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
):
    """下载指定文件：从数据库读取二进制内容并直接返回文件流.

    需登录才能下载——未携带有效令牌将返回 401，防止未授权用户获取文件。
    """
    if not _is_safe_filename(filename):
        raise HTTPException(status_code=400, detail="非法文件名")

    record = db.query(FileRecord).filter(FileRecord.filename == filename).first()
    if not record:
        raise HTTPException(status_code=404, detail="文件不存在")

    if not record.file_data:
        # 历史遗留记录（R2 时代 / 部署崩溃期上传）可能未存储内容
        raise HTTPException(
            status_code=404,
            detail="文件内容不存在（可能是历史旧记录，请重新上传该文件）",
        )

    # 累加下载量（用于数据记录统计）
    record.download_count = (record.download_count or 0) + 1
    # 累计该账号的下载次数（>0 即视为「已下载过」，豁免于不活跃自动注销）
    current_user.download_count = (current_user.download_count or 0) + 1
    db.commit()

    # 兼容 PostgreSQL BYTEA 读回的 memoryview，统一转为 bytes 避免 500
    content = bytes(record.file_data)

    # 下载保存名优先使用原始文件名（如 123.zip / 实例.zip），而非内部版本名
    download_name = record.original_filename or filename
    ascii_name = re.sub(r'[^\x20-\x7e]', '_', download_name)
    disp = (
        f'attachment; filename="{ascii_name}"; '
        f"filename*=UTF-8''{quote(download_name)}"
    )

    return Response(
        content=content,
        media_type=record.file_mime or "application/octet-stream",
        headers={"Content-Disposition": disp},
    )


@app.post("/api/download-log/{filename}")
async def log_download(
    filename: str,
    current_user: Annotated[User, Depends(require_behavior_ok)],
    db: Annotated[Session, Depends(get_db)],
) -> JSONResponse:
    """记录一次「已登录用户」的下载行为（用于账号历史下载统计）.

    前端在用户点击下载按钮时，会随原生下载（GET /download）一并异步发起本请求，
    仅用于归属统计，不重复累加 file_records.download_count（总量由 GET /download 处理）。
    匿名下载不会调用本接口，因此账号历史仅反映登录后的下载行为。
    """
    if not _is_safe_filename(filename):
        raise HTTPException(status_code=400, detail="非法文件名")

    record = db.query(FileRecord).filter(FileRecord.filename == filename).first()
    if not record:
        raise HTTPException(status_code=404, detail="文件不存在")

    db.add(DownloadLog(user_id=current_user.id, file_record_id=record.id))
    db.commit()
    return JSONResponse({"ok": True})


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


@app.get("/api/health")
async def health_check() -> JSONResponse:
    """健康检查端点：用于探测服务是否就绪（使页面打开时即可预热后端）.

    免费实例在闲置后会休眠，首个请求需等待冷启动（容器启动 + 初始化）。
    前端在页面打开时先请求本端点，让冷启动的等待发生在页面加载阶段，
    而不是用户点击登录之后，从而改善登录体感速度。
    """
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        db_ok = True
    except Exception:
        db_ok = False
    return JSONResponse({"status": "ok", "database": db_ok})


@app.get("/api/altcha/challenge")
async def altcha_challenge() -> JSONResponse:
    """返回一个新的 ALTCHA 人机验证挑战（Proof-of-Work）。

    挑战包含一次性 HMAC 签名，并设置 10 分钟有效期。前端 ``<altcha-widget>``
    拉取后在浏览器端完成算力证明，提交时仅回传一段 base64 凭证；服务端只需
    做一次 HMAC 校验即可判定真伪，对服务器几乎零负担（自托管、无需第三方 API）。
    """
    expires = datetime.now(timezone.utc) + timedelta(minutes=10)
    challenge = create_challenge_v1(
        hmac_key=ALTCHA_HMAC_KEY,
        algorithm="SHA-256",
        max_number=1000000,
        expires=expires,
    )
    return JSONResponse(challenge.to_dict())


@app.post("/api/active-ping")
async def active_ping(
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    session_id: str = Form(...),
) -> JSONResponse:
    """记录一次访问活动心跳，用于统计当前在线访问数（所有访客均可调用）.

    前端在打开页面时及之后定时调用本接口，携带一个本机唯一的 session_id。
    - 在线统计：仅记录该会话最近活动时间到内存（实时、非累计）。
    - 若请求携带有效 JWT Authorization，则同时记录该会话对应的登录用户名。
    - 累计访问人数：首次出现的 session_id 写入 unique_visitors 表（去重，持久化）。
    """
    sid = (session_id or "").strip()
    if not sid or len(sid) > 64:
        raise HTTPException(status_code=400, detail="非法的 session_id")

    # 尝试从 Authorization 头提取登录用户名（静默失败：匿名访客不报错）
    username = None
    auth_header = request.headers.get("authorization", "")
    if auth_header.startswith("Bearer "):
        from auth.security import decode_access_token, JWTError
        try:
            payload = decode_access_token(auth_header[7:])
            username = payload.get("sub")
        except (JWTError, Exception):
            pass

    with ACTIVE_SESSIONS_LOCK:
        ACTIVE_SESSIONS[sid] = {"ts": time.time(), "username": username}
    # 控制内存规模：每次心跳顺手清理过期会话
    _prune_active_sessions()

    # 累计独立访客：每个 session_id 仅记录一次
    try:
        existing = db.query(UniqueVisitor).filter_by(session_id=sid).first()
        if not existing:
            db.add(UniqueVisitor(session_id=sid))
            db.commit()
    except Exception:
        db.rollback()

    return JSONResponse({"ok": True})


@app.get("/api/admin/active-users")
async def admin_active_users(
    current_user: Annotated[User, Depends(require_admin)],
) -> JSONResponse:
    """管理员专用：返回当前在线用户列表（含用户名与最后活跃时间）.

    统计所有在 ``ACTIVE_WINDOW_SECONDS`` 窗口内仍有心跳的访问会话。
    """
    online = _get_active_users_list()
    return JSONResponse({
        "active_users": len(ACTIVE_SESSIONS),
        "online_list": online,
    })


@app.get("/api/admin/stats")
async def admin_stats(
    current_user: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> JSONResponse:
    """管理员专用：返回数据记录统计（含 monitor 全量数据）.

    包含：
    - 每个文件的下载量与下载占比
    - 总下载量
    - 总访问人数（累计独立访客，去重）
    - 当前在线人数（实时窗口）
    - 已注册账号列表（含角色 / 高危标记 / 累计下载 / 归属地）
    - 数据库已用空间与额度（`db_size_bytes` / `db_quota_bytes`）
    - ``user_downloads``：每个用户的下载历史（用于矩阵 / 事件流 / 用户下钻）
    - ``matrix``：用户 × 文件 的下载次数映射
    - ``recent_events``：跨所有用户、按时间倒序的下载事件流
    - ``total_files_site``：站点文件总数（供前端补全比例）
    """
    records = db.query(FileRecord).all()
    total_downloads = sum(r.download_count or 0 for r in records)
    total_files_site = len(records)

    files = []
    for record in records:
        display_name = record.original_filename or f"{record.version}{Path(record.filename).suffix}"
        downloads = record.download_count or 0
        ratio = (downloads / total_downloads * 100) if total_downloads else 0
        files.append({
            "series": record.series,
            "name": display_name,
            "downloads": downloads,
            "ratio": round(ratio, 1),
        })
    # 按下载量降序排列，便于阅读
    files.sort(key=lambda x: x["downloads"], reverse=True)

    total_visitors = db.query(UniqueVisitor).count()

    users = [
        {
            "username": u.username,
            "role": u.role,
            "high_risk": bool(u.high_risk),
            "download_count": u.download_count or 0,
            "last_login": u.last_login.isoformat() if u.last_login else None,
            "ip_location": u.last_login_location or "",
        }
        for u in db.query(User).order_by(User.id).all()
    ]

    db_size_bytes = get_database_size_bytes(db)
    db_quota_bytes = DATABASE_QUOTA_BYTES
    active_users = _count_active_sessions()

    # ---- 用户下载历史（一次性聚合，供前端矩阵 / 事件流 / 下钻复用） ----
    user_downloads: dict[str, dict] = {}
    matrix: dict[str, dict[str, int]] = {}
    events: list[dict] = []

    all_logs = (
        db.query(DownloadLog, FileRecord, User)
        .join(FileRecord, DownloadLog.file_record_id == FileRecord.id)
        .join(User, DownloadLog.user_id == User.id)
        .order_by(DownloadLog.downloaded_at.asc())
        .all()
    )
    for log, record, owner in all_logs:
        uname = owner.username
        fname = (
            record.original_filename
            or f"{record.version}{Path(record.filename).suffix}"
        )
        dl_at = log.downloaded_at.isoformat()
        ud = user_downloads.setdefault(uname, {
            "username": uname,
            "total_files": total_files_site,
            "downloaded_files": 0,
            "ratio": 0,
            "history": [],
        })
        ud["history"].append({
            "file_name": fname,
            "series": record.series,
            "downloaded_at": dl_at,
        })
        # 矩阵累计
        m = matrix.setdefault(uname, {})
        m[fname] = m.get(fname, 0) + 1
        # 事件流
        events.append({
            "username": uname,
            "file_name": fname,
            "series": record.series or "",
            "downloaded_at": dl_at,
        })

    # 补全每用户 downloaded_files / ratio，并按时间倒序排序历史
    for uname, ud in user_downloads.items():
        distinct = {h["file_name"] for h in ud["history"]}
        ud["downloaded_files"] = len(distinct)
        ud["ratio"] = round(len(distinct) / total_files_site * 100, 1) if total_files_site else 0
        ud["history"].sort(key=lambda h: h["downloaded_at"], reverse=True)

    # 事件流整体按时间倒序，取最近 100 条
    events.sort(key=lambda e: e["downloaded_at"], reverse=True)
    recent_events = events[:100]

    return JSONResponse({
        "files": files,
        "total_downloads": total_downloads,
        "total_visitors": total_visitors,
        "active_users": active_users,
        "users": users,
        "db_size_bytes": db_size_bytes,
        "db_quota_bytes": db_quota_bytes,
        "total_files_site": total_files_site,
        "user_downloads": user_downloads,
        "matrix": matrix,
        "recent_events": recent_events,
    })


@app.post("/api/admin/analyze-risks")
async def admin_analyze_risks(
    current_user: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> JSONResponse:
    """管理员专用：调用英伟达 NIM AI 模型分析用户风险.

    收集所有用户的行为数据（注册时间、登录频率、下载模式、IP 归属地、
    行为风险分等），组装为结构化 JSON，发送给 deepseek-v4-flash 模型，
    由 AI 输出每人的风险评估结果（风险等级 + 原因）。

    返回格式::

        {
          "analysis": "AI 生成的整体分析文本",
          "users": [
            {"username": "...", "risk_level": "高/中/低", "reason": "..."},
            ...
          ],
          "model": "deepseek-ai/deepseek-v4-flash"
        }
    """
    api_key = _get_nvidia_api_key(db)
    if not api_key:
        raise HTTPException(
            status_code=500,
            detail="未配置英伟达 API Key，请在「系统设置」中填入 NVIDIA_API_KEY。",
        )

    # ---- 1. 收集全量用户数据 ----
    now = datetime.now(timezone.utc)
    all_users = db.query(User).order_by(User.id).all()

    user_data_list = []
    for u in all_users:
        # 该用户的下载历史
        logs = (
            db.query(DownloadLog, FileRecord)
            .join(FileRecord, DownloadLog.file_record_id == FileRecord.id)
            .filter(DownloadLog.user_id == u.id)
            .order_by(DownloadLog.downloaded_at.desc())
            .limit(50)
            .all()
        )
        dl_history = []
        for log, rec in logs:
            fn = rec.original_filename or f"{rec.version}{Path(rec.filename).suffix}"
            dl_history.append({
                "file": fn,
                "series": rec.series or "",
                "time": log.downloaded_at.isoformat(),
            })

        # 注：User 模型无独立 created_at，注册时间以 last_login 的初值近似
        # 数据库读回的 DateTime 为 naive（PG 无时区列），统一转 naive UTC 比较
        now_naive = now.replace(tzinfo=None)
        reg_ref = u.last_login or now_naive
        reg_age_days = (now_naive - reg_ref).total_seconds() / 86400
        login_age_days = (now_naive - u.last_login).total_seconds() / 86400 if u.last_login else reg_age_days

        user_data_list.append({
            "username": u.username,
            "role": u.role,
            "registered_at": reg_ref.isoformat(),
            "reg_age_days": round(reg_age_days, 1),
            "last_login": u.last_login.isoformat() if u.last_login else None,
            "days_since_login": round(login_age_days, 1),
            "download_count": u.download_count or 0,
            "high_risk_flag": bool(u.high_risk),
            "behavior_risk_score": round(u.behavior_risk, 3) if u.behavior_risk is not None else 0.0,
            "ip_location": u.last_login_location or "",
            "recent_downloads": dl_history[:20],
        })

    # 站点总体统计（供 AI 参考）
    total_dl = sum(r.download_count or 0 for r in db.query(FileRecord).all())
    total_visitors = db.query(UniqueVisitor).count()

    payload_json = {
        "site_stats": {
            "total_downloads": total_dl,
            "total_visitors": total_visitors,
            "total_users": len(all_users),
            "analysis_time": now.isoformat(),
        },
        "users": user_data_list,
    }

    # ---- 2. 构建 prompt ----
    system_prompt = (
        "你是一个专业的网络安全与用户行为分析师。"
        "以下是一个文件下载网站的全部用户行为数据（JSON 格式）。\n\n"
        "请分析每个用户的风险等级，判断依据包括但不限于：\n"
        "- 注册后长期不活跃或从未下载（可能是注册占位/恶意账号）\n"
        "- 短时间内大量下载所有文件（可能爬虫/批量盗取）\n"
        "- IP 归属地异常或不稳定\n"
        "- 行为风险分高（疑似机器人）\n"
        "- 登录频率异常（过于频繁或异常间隔）\n"
        "- 下载时间集中在非正常时段\n\n"
        "输出要求（严格 JSON 格式）：\n"
        "{\n"
        '  "analysis": "整体风险概况总结（100字以内中文）",\n'
        '  "users": [\n'
        '    {\n'
        '      "username": "用户名",\n'
        '      "risk_level": "高/中/低",\n'
        '      "reason": "一句话原因说明（中文，30字以内）"\n'
        '    }\n'
        "  ]\n"
        "}\n\n"
        "只输出上述 JSON，不要包含任何其他文字、markdown 标记或代码块。"
    )

    # ---- 3. 调用英伟达 NIM API ----
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{NVIDIA_API_BASE}/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": NVIDIA_RISK_MODEL,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {
                            "role": "user",
                            "content": json.dumps(payload_json, ensure_ascii=False, indent=2),
                        },
                    ],
                    "temperature": 0.1,
                    "max_tokens": 4096,
                    "top_p": 0.95,
                },
            )
            resp.raise_for_status()
            result = resp.json()

        ai_text = result["choices"][0]["message"]["content"].strip()

        # 清理可能的 markdown 代码块包裹
        if ai_text.startswith("```"):
            ai_text = ai_text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()

        analysis = json.loads(ai_text)

        return JSONResponse({
            "analysis": analysis.get("analysis", ""),
            "users": analysis.get("users", []),
            "model": NVIDIA_RISK_MODEL,
            "raw_payload": payload_json,
        })

    except httpx.HTTPStatusError as e:
        detail = ""
        try:
            err_body = e.response.json()
            detail = err_body.get("error", {}).get("message", str(err_body))
        except Exception:
            detail = e.response.text[:500]
        raise HTTPException(status_code=e.response.status_code, detail=f"AI API 错误: {detail}")
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="AI 返回了无法解析的响应，请重试。")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI 分析失败: {str(e)}")


@app.get("/api/admin/config")
async def get_site_config(
    current_user: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> JSONResponse:
    """管理员专用：读取站点配置（API Key 仅以掩码形式返回，不暴露明文）."""
    row = db.query(SiteConfig).filter(SiteConfig.key == "nvidia_api_key").first()
    raw = row.value if row else ""
    masked = ""
    if raw:
        masked = raw[:6] + "…" + raw[-4:] if len(raw) > 10 else "已设置"
    return JSONResponse({
        "nvidia_api_key_set": bool(raw),
        "nvidia_api_key_masked": masked,
        "model": NVIDIA_RISK_MODEL,
    })


@app.post("/api/admin/config")
async def set_site_config(
    body: dict,
    current_user: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> JSONResponse:
    """管理员专用：写入站点配置（当前支持设置 nvidia_api_key）.

    使用 upsert 语义：存在则更新，不存在则插入。
    """
    api_key = (body.get("nvidia_api_key") or "").strip()
    if api_key and not api_key.startswith("nvapi-"):
        raise HTTPException(status_code=400, detail="API Key 格式不正确，应以 nvapi- 开头")

    row = db.query(SiteConfig).filter(SiteConfig.key == "nvidia_api_key").first()
    if row:
        row.value = api_key
    else:
        row = SiteConfig(key="nvidia_api_key", value=api_key)
        db.add(row)
    db.commit()
    return JSONResponse({"ok": True, "nvidia_api_key_set": bool(api_key)})


@app.get("/api/admin/users/{username}/downloads")
async def user_download_history(
    username: str,
    current_user: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_db)],
    order: str = "desc",
) -> JSONResponse:
    """管理员专用：返回指定账号的历史下载记录.

    返回内容：
    - username / total_files（站点文件总数）/ downloaded_files（该用户下载过的不同文件数）
    - ratio：下载文件比例 = 已下载文件数 / 站点总文件数 * 100（百分比，保留 1 位小数）
    - history：按下载时间排序的下载事件列表（file_name / series / downloaded_at）
    """
    username = username.strip()
    target = db.query(User).filter(User.username == username).first()
    if not target:
        raise HTTPException(status_code=404, detail="用户不存在")

    total_files = db.query(FileRecord).count()

    sort_col = DownloadLog.downloaded_at
    logs = (
        db.query(DownloadLog, FileRecord)
        .join(FileRecord, DownloadLog.file_record_id == FileRecord.id)
        .filter(DownloadLog.user_id == target.id)
        .order_by(sort_col.asc() if order == "asc" else sort_col.desc())
        .all()
    )

    history = []
    distinct_files = set()
    for log, record in logs:
        distinct_files.add(record.id)
        display_name = (
            record.original_filename
            or f"{record.version}{Path(record.filename).suffix}"
        )
        history.append({
            "file_name": display_name,
            "series": record.series,
            "downloaded_at": log.downloaded_at.isoformat(),
        })

    downloaded_files = len(distinct_files)
    ratio = round(downloaded_files / total_files * 100, 1) if total_files else 0

    return JSONResponse({
        "username": target.username,
        "total_files": total_files,
        "downloaded_files": downloaded_files,
        "ratio": ratio,
        "history": history,
    })


@app.delete("/api/admin/users/{username}")
async def delete_user(
    username: str,
    current_user: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> JSONResponse:
    """管理员专用：删除指定用户（不可删除自己）."""
    username = username.strip()
    if not _is_safe_filename(username):
        raise HTTPException(status_code=400, detail="非法的用户名")

    if username == current_user.username:
        raise HTTPException(status_code=400, detail="不能删除自己的账号")

    target = db.query(User).filter(User.username == username).first()
    if not target:
        raise HTTPException(status_code=404, detail="用户不存在")

    # 清理该用户的下载日志（SQLite 默认不强制外键级联，故显式删除以保证两端一致）
    db.query(DownloadLog).filter(DownloadLog.user_id == target.id).delete()
    db.delete(target)
    db.commit()
    return JSONResponse({"message": f"用户 {username} 已删除"})


@app.delete("/api/account")
async def delete_my_account(
    auth_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> JSONResponse:
    """当前登录用户注销自己的账号（仅普通用户，管理员豁免）.

    彻底删除该用户记录、清除其全部账号信息。管理员账号不受此接口约束，
    调用时返回 403。
    """
    if auth_user.role == "admin":
        raise HTTPException(status_code=403, detail="管理员账号不可注销")

    username = auth_user.username
    # 清理该用户的下载日志
    db.query(DownloadLog).filter(DownloadLog.user_id == auth_user.id).delete()
    db.delete(auth_user)
    db.commit()
    return JSONResponse({"message": f"账号 {username} 已注销，全部信息已清除"})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "1234")))
