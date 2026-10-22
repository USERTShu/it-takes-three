# state.py — 应用级共享状态（避免路由与 main 之间的循环导入）
# 功能：持有全局房间注册表（RoomManager），供 ws/files 路由与 main 装配共用；
#       房间创建时从持久化快照恢复（persist.load_state）。
# 依赖：yws.room.RoomManager、persist
# 可调参数：无
from .persist import load_state
from .yws.room import RoomManager

rooms = RoomManager(loader=load_state)
