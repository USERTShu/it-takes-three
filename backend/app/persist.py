# persist.py — 协作文档持久化（YDoc 快照存 SQLite room_docs 表）
# 功能：load_state 在房间创建时读取快照；autosave_loop 定期把 dirty 房间的全量 update 落盘；
#       flush_all 在应用关闭时做最后一次保存。服务重启后代码/草稿纸据此恢复。
# 依赖：y_py、db.SessionLocal、models.RoomDoc、asyncio
# 可调参数：DOC_SAVE_INTERVAL_SECONDS（config，落盘间隔）
import asyncio
import logging

import y_py as Y

from .config import get_settings
from .db import SessionLocal
from .models import RoomDoc

_settings = get_settings()
_log = logging.getLogger(__name__)


def load_state(key: str) -> bytes | None:
    """功能：读取房间快照，不存在返回 None。
    API: load_state(str) → bytes|None
    依赖：SessionLocal、RoomDoc。可调参数：无。"""
    db = SessionLocal()
    try:
        row = db.get(RoomDoc, key)
        return bytes(row.state) if row else None
    finally:
        db.close()


def _write_state(key: str, state: bytes) -> None:
    """功能：写入（覆盖）房间快照。在线程池中执行，避免阻塞事件循环。
    依赖：SessionLocal、RoomDoc。可调参数：无。"""
    db = SessionLocal()
    try:
        row = db.get(RoomDoc, key)
        if row is None:
            db.add(RoomDoc(key=key, state=state))
        else:
            row.state = state
        db.commit()
    finally:
        db.close()


async def flush_all(rooms) -> None:
    """功能：保存所有 dirty 房间。编码在事件循环线程内完成（YDoc 只在该线程读写），写库放线程池。
    写库失败时恢复 dirty，下一轮重试。
    API: flush_all(RoomManager) → None
    依赖：y_py、_write_state。可调参数：无。"""
    for room in list(rooms.rooms.values()):
        if not room.dirty or not room.key:
            continue
        room.dirty = False
        state = bytes(Y.encode_state_as_update(room.doc))
        try:
            await asyncio.to_thread(_write_state, room.key, state)
        except Exception:
            room.dirty = True
            _log.exception("save room doc failed: %s", room.key)


async def autosave_loop(rooms) -> None:
    """功能：后台循环，每 DOC_SAVE_INTERVAL_SECONDS 秒调用一次 flush_all（随 lifespan 启停）。
    API: autosave_loop(RoomManager) → None
    依赖：flush_all。可调参数：DOC_SAVE_INTERVAL_SECONDS。"""
    while True:
        await asyncio.sleep(_settings.DOC_SAVE_INTERVAL_SECONDS)
        await flush_all(rooms)
