# contests.py — 比赛管理接口
# 功能：创建比赛（创建者自动成为成员）、列出我的比赛、比赛详情、加入比赛（幂等）、
#       开始比赛（仅创建者，随机分配调色板颜色并记录 start_time）。
# 依赖：fastapi、sqlalchemy、config、models、schemas、deps
# 可调参数：DEFAULT_DURATION_MINUTES（config）、PALETTE 调色板（config，开始时取前 N 色）
import random

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..config import get_settings
from ..deps import get_current_user, get_db
from ..models import Contest, ContestMember, User
from ..schemas import ContestCreate, ContestOut, MemberOut

router = APIRouter()

_settings = get_settings()


def _member_out(db: Session, m: ContestMember) -> MemberOut:
    """功能：将 ContestMember 组装为 MemberOut（用户名/显示名从 User 表反查）。
    API: _member_out(Session, ContestMember) → MemberOut
    依赖：MemberOut、db。可调参数：无。"""
    u = db.query(User).filter(User.id == m.user_id).first()
    return MemberOut(
        id=m.id, user_id=m.user_id,
        username=u.username if u else None,
        display_name=u.display_name if u else None,
        color=m.color,
    )


def _contest_out(db: Session, contest: Contest) -> ContestOut:
    """功能：将 ORM Contest 组装为响应模型（成员附用户名/显示名）。
    API: _contest_out(Session, Contest) → ContestOut
    依赖：_member_out。可调参数：无。"""
    return ContestOut(
        id=contest.id, slug=contest.slug, name=contest.name, creator_id=contest.creator_id,
        duration_minutes=contest.duration_minutes, start_time=contest.start_time,
        status=contest.status, members=[_member_out(db, m) for m in contest.members],
    )


@router.post("", response_model=ContestOut)
def create_contest(body: ContestCreate, db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)) -> ContestOut:
    """功能：创建比赛。创建者自动加入成为成员；slug 全局唯一（分享链接的一部分）。
    请求：POST /api/contests  body: {"name","slug","duration_minutes"(默认300)}
    依赖：get_db、get_current_user。可调参数：duration_minutes。
    返回：ContestOut（members 含创建者）。"""
    slug = body.slug.strip()
    if db.query(Contest).filter(Contest.slug == slug).first():
        raise HTTPException(status_code=409, detail="slug 已被使用，请换一个")
    contest = Contest(
        slug=slug, name=body.name, creator_id=user.id,
        duration_minutes=body.duration_minutes,
    )
    db.add(contest)
    db.flush()
    db.add(ContestMember(contest_id=contest.id, user_id=user.id))
    db.commit()
    db.refresh(contest)
    return _contest_out(db, contest)


@router.get("", response_model=list[ContestOut])
def list_contests(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[ContestOut]:
    """功能：列出我参与的所有比赛（含已开始）。
    请求：GET /api/contests
    依赖：get_db、get_current_user。可调参数：无。"""
    rows = (
        db.query(Contest)
        .join(ContestMember, ContestMember.contest_id == Contest.id)
        .filter(ContestMember.user_id == user.id)
        .order_by(Contest.id.desc())
        .all()
    )
    return [_contest_out(db, c) for c in rows]


@router.get("/{slug}", response_model=ContestOut)
def get_contest(slug: str, db: Session = Depends(get_db),
                user: User = Depends(get_current_user)) -> ContestOut:
    """功能：比赛详情（用于大厅展示分享链接/成员/状态）。
    请求：GET /api/contests/{slug}
    依赖：get_db、get_current_user。可调参数：无。
    返回：ContestOut；未找到返回 404。"""
    contest = db.query(Contest).filter(Contest.slug == slug).first()
    if contest is None:
        raise HTTPException(status_code=404, detail="比赛不存在")
    return _contest_out(db, contest)


@router.post("/{slug}/join", response_model=ContestOut)
def join_contest(slug: str, db: Session = Depends(get_db),
                 user: User = Depends(get_current_user)) -> ContestOut:
    """功能：加入比赛（幂等：已是成员则直接返回）。已开始/已结束的比赛不可加入。
    请求：POST /api/contests/{slug}/join
    依赖：get_db、get_current_user。可调参数：无。"""
    contest = db.query(Contest).filter(Contest.slug == slug).first()
    if contest is None:
        raise HTTPException(status_code=404, detail="比赛不存在")
    if contest.status != "created":
        raise HTTPException(status_code=409, detail="比赛已开始，无法加入")
    member = (
        db.query(ContestMember)
        .filter(ContestMember.contest_id == contest.id, ContestMember.user_id == user.id)
        .first()
    )
    if member is None:
        db.add(ContestMember(contest_id=contest.id, user_id=user.id))
        db.commit()
        db.refresh(contest)
    return _contest_out(db, contest)


@router.post("/{slug}/start", response_model=ContestOut)
def start_contest(slug: str, db: Session = Depends(get_db),
                  user: User = Depends(get_current_user)) -> ContestOut:
    """功能：开始比赛。仅创建者可调用；为所有成员随机分配 PALETTE 中的不同颜色并写 start_time。
    请求：POST /api/contests/{slug}/start
    依赖：get_db、get_current_user、config.PALETTE。可调参数：PALETTE（config）。
    返回：ContestOut（members 带 color）。"""
    contest = db.query(Contest).filter(Contest.slug == slug).first()
    if contest is None:
        raise HTTPException(status_code=404, detail="比赛不存在")
    if contest.creator_id != user.id:
        raise HTTPException(status_code=403, detail="只有创建者可以开始比赛")
    if contest.status == "started":
        return _contest_out(db, contest)
    members = db.query(ContestMember).filter(ContestMember.contest_id == contest.id).all()
    if not members:
        raise HTTPException(status_code=400, detail="还没有成员")
    colors = random.sample(list(_settings.PALETTE), len(members))
    for m, color in zip(members, colors):
        m.color = color
    contest.status = "started"
    from datetime import datetime, timezone

    contest.start_time = datetime.now(timezone.utc)
    db.commit()
    db.refresh(contest)
    return _contest_out(db, contest)
