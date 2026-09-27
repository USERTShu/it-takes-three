# deps.py — FastAPI 依赖注入
# 功能：提供数据库会话与当前登录用户两个通用依赖。
# 依赖：fastapi.Depends、sqlalchemy.orm.Session、models
# 可调参数：无
from fastapi import Depends, Header, HTTPException
from sqlalchemy.orm import Session

from .db import SessionLocal
from .models import User
from .security import get_user_by_token


def get_db():
    """功能：为每个请求提供一个独立的数据库会话（请求结束后关闭）。
    依赖：SessionLocal（SQLAlchemy sessionmaker）。可调参数：无。"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


async def get_current_user(
    authorization: str = Header(default=""),
    db: Session = Depends(get_db),
) -> User:
    """功能：从 Authorization 头解析 Bearer token 并返回当前登录用户；无效则 401。
    依赖：get_db、get_user_by_token。可调参数：无。"""
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="未登录：缺少 Bearer token")
    token = authorization.removeprefix("Bearer ").strip()
    user = get_user_by_token(db, token)
    if user is None:
        raise HTTPException(status_code=401, detail="登录已失效，请重新登录")
    return user
