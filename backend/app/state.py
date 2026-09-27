# state.py — 应用级共享状态（避免路由与 main 之间的循环导入）
# 功能：持有全局房间注册表（RoomManager），供 ws/files 路由与 main 装配共用。
# 依赖：yws.room.RoomManager
# 可调参数：无
from .yws.room import RoomManager

rooms = RoomManager()
