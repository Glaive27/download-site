"""ORM 模型：用户、文件系列、文件记录."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import Boolean, Column, DateTime, Float, ForeignKey, Integer, LargeBinary, String

from auth.database import Base


def _utcnow() -> datetime:
    """返回带 UTC 时区的当前时间."""
    return datetime.now(timezone.utc)


class User(Base):  # noqa: D101
    """用户表，使用 ORM 参数化查询防止 SQL 注入."""

    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(64), unique=True, index=True, nullable=False)
    hashed_password = Column(String(255), nullable=False)
    role = Column(String(16), default="user", nullable=False)
    # 行为式人机认证（基于鼠标轨迹）：
    # behavior_risk  —— 最近一次上报的风险分（0~1，越高越疑似机器人）
    # behavior_flagged —— 是否因行为异常被要求二次验证 / 限制操作
    behavior_risk = Column(Float, nullable=True, default=0.0)
    behavior_flagged = Column(Boolean, nullable=False, default=False)
    # 不活跃账号自动管理：
    # last_login    —— 最近一次成功登录时间（注册时取注册时间）；用于判定「上线」间隔
    # download_count —— 该账号累计下载文件次数（0 表示从未下载过文件）
    # high_risk     —— 高危标记：注册后从未下载、且超过 ACCOUNT_RISK_DAYS 天未上线时被置位
    last_login = Column(DateTime, default=_utcnow, nullable=False)
    download_count = Column(Integer, default=0, nullable=True)
    high_risk = Column(Boolean, default=False, nullable=False)

    def __repr__(self) -> str:  # noqa: D105
        return f"<User(id={self.id}, username={self.username}, role={self.role})>"


class Series(Base):  # noqa: D101
    """文件系列表，持久化存储已创建的系列名."""

    __tablename__ = "series"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(128), unique=True, index=True, nullable=False)
    created_at = Column(DateTime, default=_utcnow, nullable=False)

    def __repr__(self) -> str:  # noqa: D105
        return f"<Series(id={self.id}, name={self.name})>"


class FileRecord(Base):  # noqa: D101
    """文件记录表，文件二进制内容直接存储在 PostgreSQL 数据库中.

    字段说明：
    - series: 所属系列名
    - filename: 下载时使用的文件名（如 series_v1.pdf）
    - original_filename: 用户上传时的原始文件名（如 123.zip、实例.zip）
    - version: 版本号（如 v1、v2）
    - size: 文件大小（字节）
    - mime_type: 文件 MIME 类型（用于 /files 列表展示）
    - object_key: 历史遗留字段（R2 时代使用），现填充占位符 "legacy"
    - file_data: 文件二进制内容（直接存入数据库）
    - file_mime: 下载时使用的 MIME 类型（与 mime_type 冗余但独立，便于精确控制下载响应头）
    - created_at: 上传时间
    """

    __tablename__ = "file_records"

    id = Column(Integer, primary_key=True, index=True)
    series = Column(String(128), nullable=False, index=True)
    filename = Column(String(255), nullable=False, index=True)
    original_filename = Column(String(255), nullable=True)
    version = Column(String(32), nullable=False)
    size = Column(Integer, nullable=False)
    mime_type = Column(String(128), nullable=False)
    object_key = Column(String(512), nullable=False, index=True)
    file_data = Column(LargeBinary, nullable=True)
    file_mime = Column(String(100), nullable=True)
    download_count = Column(Integer, default=0, nullable=False)
    created_at = Column(DateTime, default=_utcnow, nullable=False)

    def __repr__(self) -> str:  # noqa: D105
        return f"<FileRecord(id={self.id}, series={self.series}, filename={self.filename})>"


class UniqueVisitor(Base):  # noqa: D101
    """独立访客累计表.

    每个本机唯一的 session_id 仅记录一次（首次访问时写入），
    用于统计「总访问人数」（累计去重，与实时在线数区分）。
    """

    __tablename__ = "unique_visitors"

    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(String(64), unique=True, index=True, nullable=False)
    first_seen = Column(DateTime, default=_utcnow, nullable=False)

    def __repr__(self) -> str:  # noqa: D105
        return f"<UniqueVisitor(id={self.id}, session_id={self.session_id})>"


class DownloadLog(Base):  # noqa: D101
    """用户下载行为日志表.

    每次「已登录用户」成功下载一个文件都会写入一行，用于统计每个账号的
    历史下载记录（下载过哪些文件、何时下载）。与 file_records.download_count
    （全站聚合下载量）解耦：本表只记录「谁下载了什么」，不重复累加总量。

    字段说明：
    - user_id:        下载者（users.id 外键，级联删除）
    - file_record_id: 被下载的文件（file_records.id 外键，级联删除）
    - downloaded_at:  下载发生时间（UTC）
    """

    __tablename__ = "download_logs"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    file_record_id = Column(
        Integer,
        ForeignKey("file_records.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    downloaded_at = Column(DateTime, default=_utcnow, nullable=False)

    def __repr__(self) -> str:  # noqa: D105
        return f"<DownloadLog(id={self.id}, user_id={self.user_id}, file_record_id={self.file_record_id})>"
