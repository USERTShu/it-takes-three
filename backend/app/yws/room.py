# room.py — 比赛房间（每比赛一个 YDoc + 连接注册表 + 广播）
# 功能：ContestRoom 持有该比赛的 Yjs 文档（files 存于 doc.get_map("files")）、
#       已连接 WebSocket 列表与 AwarenessHub；broadcast 向除 exclude 外所有连接推送 bytes。
#       RoomManager 按 key（"contest/{slug}"）复用房间实例。
# 依赖：y_py、awareness.AwarenessHub、asyncio（桥接线程池改动的广播）
# 可调参数：无
import asyncio

import y_py as Y

from .awareness import AwarenessHub


class ContestRoom:
    """功能：单个比赛的实时协作房间。
    API: broadcast(bytes, exclude=None)；add_connection(conn)；remove_connection(conn)；
         get_map("files")；update_from_diff(bytes)  # 应用 REST 改动并返回增量
    依赖：y_py、AwarenessHub、asyncio。可调参数：无。"""

    def __init__(self, slug: str) -> None:
        # 比赛 slug（room key 的一部分，便于日志/调试）
        self.slug = slug
        # 唯一的 YDoc：文件内容 = doc.get_map("files") 下的 Y.Text；比赛生命周期内为唯一事实源
        self.doc = Y.YDoc()
        self.hub = AwarenessHub()
        # WebSocket 连接注册表（保证线程安全的广播在 ws 路由的 asyncio 环内执行）
        self.connections: set = set()

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
            asyncio.create_task(conn.send_bytes(message))

    def apply_update(self, update: bytes) -> None:
        """功能：应用一条 Yjs update 到 doc。
        API: apply_update(bytes) → None
        依赖：y_py。可调参数：无。"""
        Y.apply_update(self.doc, update)


class RoomManager:
    """功能：全局房间注册表（FastAPI app.state.rooms）。
    API: get_or_create(slug) → ContestRoom；get(slug) → ContestRoom|None；all_keys() → list[str]
    依赖：ContestRoom。可调参数：无。"""

    def __init__(self) -> None:
        self.rooms: dict[str, ContestRoom] = {}

    def key_for(self, slug: str) -> str:
        """功能：房间 key 规约（对齐前端 WebsocketProvider 的 roomname）。
        API: key_for(str) → str
        依赖：无。可调参数：无。"""
        return f"contest/{slug}"

    def get_or_create(self, slug: str) -> ContestRoom:
        """功能：按 slug 获取房间，不存在则创建（并发安全由 GIL + 单事件循环保证）。
        API: get_or_create(str) → ContestRoom
        依赖：ContestRoom。可调参数：无。"""
        key = self.key_for(slug)
        if key not in self.rooms:
            self.rooms[key] = ContestRoom(slug)
        return self.rooms[key]

    def get(self, slug: str) -> ContestRoom | None:
        """功能：按 slug 获取房间，不存在返回 None。
        API: get(str) → ContestRoom|None
        依赖：无。可调参数：无。"""
        return self.rooms.get(self.key_for(slug))
