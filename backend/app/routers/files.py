# files.py — 文件读写接口（辅助/调试；主路径是前端直接 CRDT 增删文件）
# 功能：列表/读取/创建/删除比赛内的文件，均操作该比赛 YDoc 的 "files" map（Y.Text），
#       改动后计算增量 update 广播给房间内其他连接。
# 依赖：fastapi、sqlalchemy、y_py、yws.room/sync、state
# 可调参数：无（文件内容存于 YDoc 内存，比赛生命周期内为唯一事实源）
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

import y_py as Y

from ..deps import get_current_user, get_db
from ..models import Contest, ContestMember, User
from ..schemas import FileOut
from ..state import rooms
from ..yws.codec import pack_message
from ..yws.room import ContestRoom
from ..yws.sync import MSG_SYNC, encode_update_message

router = APIRouter()


async def _get_room(slug: str, db: Session, user: User) -> ContestRoom:
    """功能：校验用户是该比赛成员并返回对应房间；否则抛 403/404。
    API: _get_room(str, Session, User) → ContestRoom
    依赖：state.rooms、models。可调参数：无。"""
    contest = db.query(Contest).filter(Contest.slug == slug).first()
    if contest is None:
        raise HTTPException(status_code=404, detail="比赛不存在")
    member = (
        db.query(ContestMember)
        .filter(ContestMember.contest_id == contest.id, ContestMember.user_id == user.id)
        .first()
    )
    if member is None:
        raise HTTPException(status_code=403, detail="你不是该比赛成员")
    return rooms.get_or_create(slug)


def _broadcast_room_diff(room: ContestRoom, sv_before: bytes) -> None:
    """功能：计算相对 sv_before 的增量 update 并广播给房间内所有连接（REST 改动传播）。
    API: _broadcast_room_diff(ContestRoom, bytes) → None
    依赖：y_py、yws.sync。可调参数：无。"""
    diff = bytes(Y.encode_state_as_update(room.doc, sv_before))
    if diff:
        room.broadcast(pack_message(MSG_SYNC, encode_update_message(diff)))


@router.get("/{slug}/files", response_model=list[FileOut])
async def list_files(slug: str, db: Session = Depends(get_db),
                     user: User = Depends(get_current_user)) -> list[FileOut]:
    """功能：列出比赛目录下的全部文件名。
    请求：GET /api/contests/{slug}/files
    依赖：_get_room、y_py。可调参数：无。
    返回：[{"path": str}]"""
    room = await _get_room(slug, db, user)
    files_map = room.get_map("files")
    keys = sorted(files_map.keys() or [])
    return [FileOut(path=k) for k in keys]


@router.get("/{slug}/files/{path:path}", response_model=FileOut)
async def read_file(slug: str, path: str, db: Session = Depends(get_db),
                    user: User = Depends(get_current_user)) -> FileOut:
    """功能：读取单个文件内容。
    请求：GET /api/contests/{slug}/files/{path}
    依赖：_get_room、y_py。可调参数：无。
    返回：{"path": str, "content": str}；文件不存在返回 404。"""
    room = await _get_room(slug, db, user)
    ytext = room.get_map("files").get(path)
    if ytext is None:
        raise HTTPException(status_code=404, detail="文件不存在")
    return FileOut(path=path, content=str(ytext))


@router.post("/{slug}/files/{path:path}", response_model=FileOut)
async def write_file(slug: str, path: str, body: dict,
                     db: Session = Depends(get_db),
                     user: User = Depends(get_current_user)) -> FileOut:
    """功能：创建或覆盖文件（内容为空串则新建空文件）。
    请求：POST /api/contests/{slug}/files/{path}  body: {"content": str}
    依赖：_get_room、y_py。可调参数：无。
    返回：{"path": str, "content": str}。"""
    room = await _get_room(slug, db, user)
    content = body.get("content", "") if isinstance(body, dict) else ""
    files_map = room.get_map("files")
    sv_before = bytes(Y.encode_state_vector(room.doc))
    with room.doc.begin_transaction() as txn:
        files_map.set(txn, path, Y.YText(content))
    _broadcast_room_diff(room, sv_before)
    return FileOut(path=path, content=str(files_map.get(path)))


@router.delete("/{slug}/files/{path:path}", response_model=FileOut)
async def delete_file(slug: str, path: str, db: Session = Depends(get_db),
                      user: User = Depends(get_current_user)) -> FileOut:
    """功能：删除文件（Yjs 内实际是“删除该 Y.Text”，其它客户端 diff 同步）。
    请求：DELETE /api/contests/{slug}/files/{path}
    依赖：_get_room、y_py。可调参数：无。"""
    room = await _get_room(slug, db, user)
    files_map = room.get_map("files")
    sv_before = bytes(Y.encode_state_vector(room.doc))
    with room.doc.begin_transaction() as txn:
        files_map.pop(txn, path)
    _broadcast_room_diff(room, sv_before)
    return FileOut(path=path, content=None)
