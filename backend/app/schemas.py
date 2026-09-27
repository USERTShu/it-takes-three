# schemas.py — Pydantic 请求/响应模型
# 功能：定义 API 出入参结构（登录、用户、比赛、成员、文件）。
# 依赖：pydantic（随 fastapi 安装）
# 可调参数：无
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class LoginRequest(BaseModel):
    """功能：登录请求体。invite_code 为数据库预设的邀请码。"""
    model_config = ConfigDict(extra="forbid")
    invite_code: str


class UserOut(BaseModel):
    """功能：用户公开信息响应。"""
    model_config = ConfigDict(from_attributes=True)
    id: int
    username: str
    display_name: str


class LoginResponse(BaseModel):
    """功能：登录成功响应。token 存入 localStorage，请求时放入 Authorization: Bearer <token>。"""
    token: str
    user: UserOut


class ContestCreate(BaseModel):
    """功能：创建比赛请求体。slug 将作为分享链接的一部分，需全局唯一。
    duration_minutes 默认 300（ICPC 5 小时，可调）。"""
    model_config = ConfigDict(extra="forbid")
    name: str
    slug: str
    duration_minutes: int = 300


class MemberOut(BaseModel):
    """功能：比赛成员响应（含比赛开始时分配的颜色）。"""
    model_config = ConfigDict(from_attributes=True)
    id: int
    user_id: int
    username: str | None = None
    display_name: str | None = None
    color: str | None = None


class ContestOut(BaseModel):
    """功能：比赛详情响应。start_time/color 在开始比赛后填充。"""
    model_config = ConfigDict(from_attributes=True)
    id: int
    slug: str
    name: str
    creator_id: int
    duration_minutes: int
    start_time: datetime | None
    status: str
    members: list[MemberOut] = []


class FileOut(BaseModel):
    """功能：文件响应（list 用文件名数组，单文件用 path/content）。"""
    path: str
    content: str | None = None


class FileCreate(BaseModel):
    """功能：创建文件请求体。content 可空（默认空文件）。"""
    model_config = ConfigDict(extra="forbid")
    content: str = ""
