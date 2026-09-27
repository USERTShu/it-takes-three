# security.py — 登录会话签发与校验
# 功能：邀请码登录后签发随机 token 会话；根据 token 解析当前用户。
# 依赖：secrets（随机 token）、models、config
# 可调参数：token 长度（TOKEN_BYTES=32）、会话有效期（SESSION_TTL_DAYS，config 可调）
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from .config import get_settings
from .models import AuthSession, User

TOKEN_BYTES = 32  # 可调：token 随机字节数（32 字节 ≈ 43 字符 base64url）


def create_session(db: Session, user: User) -> AuthSession:
    """功能：为用户签发一个新的登录会话（token + 过期时间）。
    调用的 API：secrets.token_urlsafe、AuthSession。依赖：db 会话、config.SESSION_TTL_DAYS。
    可调参数：SESSION_TTL_DAYS（config，默认 7 天）。返回：AuthSession（未 commit，调用方负责提交）。"""
    token = secrets.token_urlsafe(TOKEN_BYTES)
    session = AuthSession(
        token=token,
        user_id=user.id,
        expires_at=datetime.now(timezone.utc) + timedelta(days=get_settings().SESSION_TTL_DAYS),
    )
    db.add(session)
    db.flush()
    return session


def get_user_by_token(db: Session, token: str) -> User | None:
    """功能：校验 token 是否有效且未过期，返回对应用户。
    调用的 API：db.query(AuthSession)。依赖：db 会话。
    可调参数：无（过期时间在签发时按 SESSION_TTL_DAYS 设定）。返回：User 或 None。"""
    if not token:
        return None
    session = db.query(AuthSession).filter(AuthSession.token == token).first()
    if session is None:
        return None
    if session.expires_at.replace(tzinfo=timezone.utc) < datetime.now(timezone.utc):
        return None
    return db.query(User).filter(User.id == session.user_id).first()
