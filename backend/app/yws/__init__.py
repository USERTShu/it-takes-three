# yws 包 — y-websocket 服务端协议实现
# 功能：为 FastAPI WebSocket 提供 Yjs CRDT 同步 + Awareness 状态同步能力，
#       自实现 y-websocket 协议（y-server npm 包已废弃，此处用纯 Python 实现）。
# 依赖：codec（lib0 变长编码）、sync（同步消息编解码）、awareness（状态合并）、room（房间管理）
