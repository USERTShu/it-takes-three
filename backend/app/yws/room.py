# room.py — 比赛房间（每比赛一个 YDoc + 连接注册表 + 广播）
# 功能：ContestRoom 持有该比赛的 Yjs 文档（files 存于 doc.get_map("files")）、
#       已连接 WebSocket 列表与 AwarenessHub；broadcast 向除 exclude 外所有连接推送 bytes。
#       RoomManager 按 key（"contest/{slug}"）复用房间实例；创建时经 loader 恢复持久化快照，
#       doc 有实际改动时置 dirty，由 persist.autosave_loop 定期落盘。
# 依赖：y_py、awareness.AwarenessHub、asyncio（桥接线程池改动的广播）
# 可调参数：无
import asyncio
from typing import Callable

import y_py as Y

from .awareness import AwarenessHub

# 空事务（只读/无改动）编码出的 update
_EMPTY_UPDATE = b"\x00\x00"

# 广播发送任务的强引用（asyncio 只弱引用任务，未完成的任务可能被回收）
_send_tasks: set = set()


async def _safe_send(conn, message: bytes) -> None:
    """功能：发送一条消息；连接已断开时静默忽略（由该连接自己的接收循环负责清理），
    避免 "Task exception was never retrieved" 刷屏。
    依赖：无。可调参数：无。"""
    try:
        await conn.send_bytes(message)
    except Exception:
        pass


class ContestRoom:
    """功能：单个比赛的实时协作房间。
    API: broadcast(bytes, exclude=None)；add_connection(conn)；remove_connection(conn)；
         get_map("files")；update_from_diff(bytes)  # 应用 REST 改动并返回增量
    依赖：y_py、AwarenessHub、asyncio。可调参数：无。"""

    def __init__(self, slug: str, key: str | None = None, initial: bytes | None = None) -> None:
        # 比赛 slug（room key 的一部分，便于日志/调试）
        self.slug = slug
        # 房间 key（持久化快照的主键）
        self.key = key
        # 唯一的 YDoc：文件内容 = doc.get_map("files") 下的 Y.Text；比赛生命周期内为唯一事实源
        self.doc = Y.YDoc()
        if initial:
            Y.apply_update(self.doc, initial)
        # 有未落盘的改动（只读事务不算）
        self.dirty = False
        self.doc.observe_after_transaction(self._on_transaction)
        self.hub = AwarenessHub()
        # WebSocket 连接注册表（保证线程安全的广播在 ws 路由的 asyncio 环内执行）
        self.connections: set = set()
        # 当前队长 user_id（仅代码房间使用：只有队长的 update 会被接受）；
        # 连接建立时从数据库刷新，交接队长接口会同步更新
        self.captain_id: int | None = None

    def _on_transaction(self, event) -> None:
        """功能：事务提交回调：产生实际改动（含删除）时标记 dirty。
        依赖：y_py AfterTransactionEvent.get_update。可调参数：无。"""
        if bytes(event.get_update()) != _EMPTY_UPDATE:
            self.dirty = True

    def get_map(self, key: str) -> Y.YMap:
        """功能：取 doc 下的 YMap（如 "files"）。
        API: get_map(str) → YMap
        依赖：y_py。可调参数：无。"""
        return self.doc.get_map(key)

    def add_connection(self, conn) -> None:
        """功能：登记一条 WebSocket 连接。
        API: add_connection(conn) → None
        依赖：无。可调参数：无。"""
        self.connections.add(conn)

    def remove_connection(self, conn) -> None:
        """功能：移除一条 WebSocket 连接。
        API: remove_connection(conn) → None
        依赖：无。可调参数：无。"""
        self.connections.discard(conn)

    def broadcast(self, message: bytes, exclude=None) -> None:
        """功能：向房间内所有（除 exclude 外）连接发送 bytes 消息。
        注意：必须在 asyncio 事件循环线程内调用（REST 线程池改动需用 loop.create_task 桥接）。
        API: broadcast(bytes, exclude=set) → None
        依赖：asyncio。可调参数：exclude=排除的连接集合（默认空）。"""
        for conn in list(self.connections):
            if conn is exclude:
                continue
            task = asyncio.create_task(_safe_send(conn, message))
            _send_tasks.add(task)
            task.add_done_callback(_send_tasks.discard)

    def apply_update(self, update: bytes) -> None:
        """功能：应用一条 Yjs update 到 doc。
        API: apply_update(bytes) → None
        依赖：y_py。可调参数：无。"""
        Y.apply_update(self.doc, update)


class RoomManager:
    """功能：全局房间注册表（FastAPI app.state.rooms）。
    API: get_or_create(slug) → ContestRoom；get(slug) → ContestRoom|None；all_keys() → list[str]
    依赖：ContestRoom。可调参数：loader=按 key 读取持久化快照的函数（返回 bytes|None）。"""

    def __init__(self, loader: Callable[[str], bytes | None] | None = None) -> None:
        self.rooms: dict[str, ContestRoom] = {}
        self.loader = loader

    def key_for(self, slug: str, kind: str = "contest") -> str:
        """功能：房间 key 规约（对齐前端 WebsocketProvider 的 roomname）。
        kind="contest" 为代码文件房间（仅队长可写），kind="scratch" 为草稿纸房间（成员均可写）。
        API: key_for(str, kind="contest") → str
        依赖：无。可调参数：kind。"""
        return f"{kind}/{slug}"

    def get_or_create(self, slug: str, kind: str = "contest") -> ContestRoom:
        """功能：按 slug 获取房间，不存在则创建（并发安全由 GIL + 单事件循环保证）。
        API: get_or_create(str, kind="contest") → ContestRoom
        依赖：ContestRoom。可调参数：kind。"""
        key = self.key_for(slug, kind)
        if key not in self.rooms:
            initial = self.loader(key) if self.loader else None
            self.rooms[key] = ContestRoom(slug, key, initial)
        return self.rooms[key]

    def get(self, slug: str, kind: str = "contest") -> ContestRoom | None:
        """功能：按 slug 获取房间，不存在返回 None。
        API: get(str, kind="contest") → ContestRoom|None
        依赖：无。可调参数：kind。"""
        return self.rooms.get(self.key_for(slug, kind))
