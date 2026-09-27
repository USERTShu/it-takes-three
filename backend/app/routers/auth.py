# auth.py — 登录与当前用户接口
# 功能：邀请码精确匹配登录（预置用户）、返回当前登录用户信息。
# 依赖：fastapi、security、schemas、deps
# 可调参数：无（token 有效期见 config.SESSION_TTL_DAYS）
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..deps import get_current_user, get_db
from ..models import InviteCode, User
from ..schemas import LoginRequest, LoginResponse, UserOut
from ..security import create_session

router = APIRouter()


def _mark_invite_used(db: Session, invite: InviteCode, user: User) -> None:
    """功能：将邀请码标记为已使用（幂等：已使用则跳过）。
    API: _mark_invite_used(Session, InviteCode, User) → None
    依赖：db。可调参数：无。"""
    if invite.used_at is None:
        invite.used_at = datetime_now()
        db.commit()


def datetime_now():
    """功能：取当前 UTC 时间（避免文件顶部重复 import）。
    API: datetime_now() → datetime
    依赖：datetime。可调参数：无。"""
    from datetime import datetime, timezone

    return datetime.now(timezone.utc)


@router.post("/login", response_model=LoginResponse)
def login(body: LoginRequest, db: Session = Depends(get_db)) -> LoginResponse:
    """功能：邀请码登录。精确匹配 invite_codes.code，命中后签发 token 并返回用户。
    请求：POST /api/auth/login  body: {"invite_code": "ACM-XXXX"}
    依赖：get_db、create_session。可调参数：SESSION_TTL_DAYS（config）。
    返回：{"token": str, "user": {id, username, display_name}}"""
    invite = db.query(InviteCode).filter(InviteCode.code == body.invite_code.strip()).first()
    if invite is None:
        raise HTTPException(status_code=401, detail="邀请码无效")
    user = db.query(User).filter(User.id == invite.user_id).first()
    _mark_invite_used(db, invite, user)
    session = create_session(db, user)
    db.commit()
    return LoginResponse(token=session.token, user=UserOut.model_validate(user))


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)) -> UserOut:
    """功能：返回当前登录用户信息（token 有效即返回）。
    请求：GET /api/auth/me  头：Authorization: Bearer <token>
    依赖：get_current_user。可调参数：无。"""
    return UserOut.model_validate(user)
