# ws.py — Yjs 同步 WebSocket 端点
# 功能：/ws/contest/{slug}（代码文件，仅队长可写）与 /ws/scratch/{slug}（草稿纸，成员均可写）服务端状态机：
#   鉴权：token 走 query 参数 + 校验比赛成员；
#   sync(0)：step1 → 回 step2(服务端缺失客户端内容) + step1(服务端 stateVector，客户端回 step2)；
#            step2/update → apply_update 后广播 [0,2,update] 给其他连接；
#   awareness(1)：合并到 hub 后广播 [1, 全部状态]（含发送者，同官方）；
#   queryAwareness(3)：回复 [1, 快照]；
#   断连：移除该连接 clientID 状态，向其他连接广播 [1, 该客户端=null]。
# 依赖：fastapi.websocket、yws.*、security、models、config
# 可调参数：WS_MAX_MESSAGE_BYTES（config，防超大消息）
from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import SessionLocal
from ..models import Contest, ContestMember
from ..security import get_user_by_token
from ..state import rooms
from ..yws.awareness import AwarenessHub
from ..yws.codec import pack_message, read_varuint, read_varuint8array, read_varstring, unpack_message, write_varuint8array
from ..yws.room import ContestRoom
from ..yws.sync import MSG_AWARENESS, MSG_QUERY_AWARENESS, MSG_SYNC, SYNC_STEP1, SYNC_STEP2, SYNC_UPDATE, encode_sync_step1, encode_sync_step2, encode_update_message

router = APIRouter()

_settings = get_settings()


def _first_client_id(payload: bytes) -> int | None:
    """功能：从 awareness 更新中解析第一个 clientID（客户端每次只发自身状态）。
    API: _first_client_id(bytes) → int|None
    依赖：codec.read_varuint/read_varstring。可调参数：无。"""
    try:
        count, pos = read_varuint(payload, 0)
        if count == 0:
            return None
        cid, _ = read_varuint(payload, pos)
        return cid
    except (ValueError, IndexError):
        return None


def _awareness_message(update: bytes) -> bytes:
    """功能：封装下行 awareness 消息 [1][varUint8Array(awarenessUpdate)]。
    官方 y-websocket 客户端按 readVarUint8Array 解包，缺少长度前缀会解码失败
    （Unexpected end of array），远端光标/在线状态整条丢失。
    API: _awareness_message(bytes) → bytes
    依赖：codec.write_varuint8array/pack_message。可调参数：无。"""
    out = bytearray()
    write_varuint8array(out, update)
    return pack_message(MSG_AWARENESS, bytes(out))


def _decode_sync(payload: bytes) -> tuple[int, bytes]:
    """功能：解析 sync 内层（sub + 数据）。
    API: _decode_sync(bytes) → (int, bytes)
    依赖：codec.read_varuint/read_varuint8array。可调参数：无。"""
    sub, pos = read_varuint(payload, 0)
    inner, _ = read_varuint8array(payload, pos)
    return sub, inner


@router.websocket("/ws/contest/{slug}")
async def ws_contest(websocket: WebSocket, slug: str,
                     token: str = Query(default="")) -> None:
    """功能：代码文件实时同步端点（只有队长的修改会被接受，其他成员只读）。
    token 在 query 中携带（浏览器 WebSocket 无法设自定义头）。
    依赖：_serve_room。可调参数：无。"""
    await _serve_room(websocket, slug, token, "contest")


@router.websocket("/ws/scratch/{slug}")
async def ws_scratch(websocket: WebSocket, slug: str,
                     token: str = Query(default="")) -> None:
    """功能：草稿纸实时同步端点（独立 YDoc，所有成员可写）。
    依赖：_serve_room。可调参数：无。"""
    await _serve_room(websocket, slug, token, "scratch")


async def _serve_room(websocket: WebSocket, slug: str, token: str, kind: str) -> None:
    """功能：房间同步主流程：鉴权 → accept → 握手(非空则发 awareness 快照) → 消息循环 → 断连清理。
    kind="contest" 时丢弃非队长的 step2/update（只读成员的修改不入库、不广播）。
    API: _serve_room(WebSocket, str, str, str) → None
    依赖：get_user_by_token、state.rooms、AwarenessHub、y_py。可调参数：kind。"""
    db: Session = SessionLocal()
    try:
        user = get_user_by_token(db, token)
        if user is None:
            await websocket.close(code=4001)
            return
        contest = db.query(Contest).filter(Contest.slug == slug).first()
        if contest is None:
            await websocket.close(code=4004)
            return
        member = (
            db.query(ContestMember)
            .filter(ContestMember.contest_id == contest.id, ContestMember.user_id == user.id)
            .first()
        )
        if member is None:
            await websocket.close(code=4003)
            return

        await websocket.accept()
        room: ContestRoom = rooms.get_or_create(slug, kind)
        user_id = user.id
        captain_only = kind == "contest"
        if captain_only:
            room.captain_id = contest.creator_id  # creator_id 即当前队长（交接时会改写）
        room.add_connection(websocket)
        hub: AwarenessHub = room.hub
        conn_client_id: int | None = None
        try:
            # 握手：若房间已有其它用户状态，下发快照，让新连接立即看到在线者光标
            if not hub.is_empty():
                await websocket.send_bytes(_awareness_message(hub.snapshot()))

            while True:
                try:
                    data = await websocket.receive_bytes()
                except WebSocketDisconnect:
                    break
                if len(data) > _settings.WS_MAX_MESSAGE_BYTES:
                    continue
                msg_type, payload = unpack_message(data)
                if msg_type == MSG_SYNC:
                    sub, inner = _decode_sync(payload)
                    if sub == SYNC_STEP1:
                        # 服务端回复：step2（客户端缺失的内容）+ step1（服务端 stateVector）
                        await websocket.send_bytes(pack_message(MSG_SYNC, encode_sync_step2(room.doc, inner)))
                        await websocket.send_bytes(pack_message(MSG_SYNC, encode_sync_step1(room.doc)))
                    elif sub in (SYNC_STEP2, SYNC_UPDATE):
                        if captain_only and room.captain_id != user_id:
                            continue  # 非队长：代码只读，丢弃其修改
                        room.apply_update(inner)
                        room.broadcast(pack_message(MSG_SYNC, encode_update_message(inner)), exclude=websocket)
                elif msg_type == MSG_AWARENESS:
                    # 客户端(官方 y-websocket)把 awarenessUpdate 包在 varUint8Array 里发送，
                    # 须先解包得到原始 awarenessUpdate 再交给 hub 解析/合并。
                    raw, _ = read_varuint8array(payload, 0)
                    payload = raw
                    cid = _first_client_id(payload)
                    if cid is not None:
                        conn_client_id = cid
                    if hub.apply(payload, websocket):
                        room.broadcast(_awareness_message(hub.encode_states()))
                elif msg_type == MSG_QUERY_AWARENESS:
                    await websocket.send_bytes(_awareness_message(hub.snapshot()))
        finally:
            # 断连清理：移除连接注册；若该连接有 clientID 状态则从 hub 删除并广播给其他连接
            room.remove_connection(websocket)
            if conn_client_id is not None and conn_client_id in hub.states:
                hub.remove_client(conn_client_id)
                room.broadcast(
                    _awareness_message(hub.encode_client(conn_client_id)),
                    exclude=websocket,
                )
    finally:
        db.close()
