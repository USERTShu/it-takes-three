# models.py — ORM 数据表定义
# 功能：定义用户/邀请码/比赛/比赛成员/登录会话 5 张表。
# 依赖：sqlalchemy.orm、db.Base
# 可调参数：表名、字段约束（见各模型 docstring）
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def _utcnow() -> datetime:
    """功能：返回带时区的当前 UTC 时间。依赖：datetime。可调参数：无。"""
    return datetime.now(timezone.utc)


class User(Base):
    """功能：参赛用户表。username 全局唯一，登录后作为身份标识。"""
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    display_name: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    invite_codes: Mapped[list["InviteCode"]] = relationship(back_populates="user")


class InviteCode(Base):
    """功能：邀请码表。code 全局唯一，登录时精确匹配，used_at 记录首次使用时间。"""
    __tablename__ = "invite_codes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(32), unique=True, nullable=False, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    user: Mapped[User] = relationship(back_populates="invite_codes")


class Contest(Base):
    """功能：比赛表。slug 唯一且由创建者设定（分享链接用）；status 取 created/started/finished。"""
    __tablename__ = "contests"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    slug: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    creator_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    duration_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=300)
    start_time: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="created")

    members: Mapped[list["ContestMember"]] = relationship(back_populates="contest", cascade="all, delete-orphan")


class ContestMember(Base):
    """功能：比赛成员表。(contest_id, user_id) 唯一；color 在开始比赛时分配（可空表示未分配）。"""
    __tablename__ = "contest_members"
    __table_args__ = (UniqueConstraint("contest_id", "user_id", name="uq_contest_user"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    contest_id: Mapped[int] = mapped_column(ForeignKey("contests.id"), nullable=False)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    color: Mapped[str | None] = mapped_column(String(16), nullable=True)
    joined_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    contest: Mapped[Contest] = relationship(back_populates="members")


class AuthSession(Base):
    """功能：登录会话表。token 为随机值，客户端在 Authorization 头携带。"""
    __tablename__ = "auth_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    token: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
