# awareness.py — Awareness 状态中枢（纯 Python，对齐 y-protocols/awareness.js）
# 功能：合并各连接的 cursor/username 等瞬时状态，冲突规则与官方一致：
#   - 仅当 currClock < clock，或（currClock == clock 且 state 为 null 且该客户端存在）时生效
#   - 合并后整体重编码并广播（含发送者，同官方行为）
#   - 断连时保留 meta.clock，删除 state，仅把该客户端编码为 null 广播
# 依赖：codec（write_varuint/read_varuint/write_varstring/read_varstring）
# 可调参数：无（协议对齐 y-protocols 1.0.6）
import json
from dataclasses import dataclass, field

from .codec import read_varstring, read_varuint, write_varstring, write_varuint


@dataclass
class AwarenessHub:
    """功能：一个比赛房间的 awareness 状态容器。
    API: apply(update, origin)->bool；encode_states()→bytes；encode_client(client_id)→bytes；
         snapshot()→bytes；remove_client(client_id)；client_ids()→list[int]；is_empty()→bool
    依赖：codec。可调参数：无。"""
    # clientID → state(dict|None)；meta：clientID → clock
    states: dict[int, dict | None] = field(default_factory=dict)
    meta: dict[int, int] = field(default_factory=dict)

    def _encode(self, client_ids: list[int]) -> bytes:
        """功能：按 y-protocols 格式编码若干客户端的 awareness 状态。
        API: _encode(list[int]) → bytes
        依赖：codec。可调参数：无。"""
        out = bytearray()
        write_varuint(out, len(client_ids))
        for cid in client_ids:
            state = self.states.get(cid)
            write_varuint(out, cid)
            write_varuint(out, self.meta[cid])
            write_varstring(out, json.dumps(state))
        return bytes(out)

    def apply(self, update: bytes, origin) -> bool:
        """功能：应用一条客户端发来的 awareness 更新；有变化时返回 True（调用方广播）。
        API: apply(bytes, origin) → bool
        依赖：codec。可调参数：无。"""
        changed = False
        pos = 0
        length, pos = read_varuint(update, pos)
        for _ in range(length):
            cid, pos = read_varuint(update, pos)
            clock, pos = read_varuint(update, pos)
            state_str, pos = read_varstring(update, pos)
            state = json.loads(state_str)
            curr_clock = self.meta.get(cid, 0)
            prev_state = self.states.get(cid)
            if curr_clock < clock or (curr_clock == clock and state is None and cid in self.states):
                if state is None:
                    # 该客户端自报离线：删除状态（本地规则无“不可删自己”语义，服务端一律接受）
                    self.states.pop(cid, None)
                else:
                    self.states[cid] = state
                self.meta[cid] = clock
                changed = True
            _ = prev_state  # 对齐官方判断逻辑，prev_state 暂不参与决定
        return changed

    def encode_states(self) -> bytes:
        """功能：编码全部活跃客户端状态（合并广播用）。
        API: encode_states() → bytes
        依赖：_encode。可调参数：无。"""
        return self._encode(list(self.states.keys()))

    def encode_client(self, cid: int) -> bytes:
        """功能：编码单个客户端状态（断连广播移除用；若不存在则编码为 null）。
        API: encode_client(int) → bytes
        依赖：_encode。可调参数：无。"""
        return self._encode([cid])

    def snapshot(self) -> bytes:
        """功能：全量快照（新连接握手时下发）。
        API: snapshot() → bytes
        依赖：encode_states。可调参数：无。"""
        return self.encode_states()

    def remove_client(self, cid: int) -> None:
        """功能：客户端断连清理——保留 meta.clock、删除 state（为后续重连时钟连续性）。
        API: remove_client(int) → None
        依赖：无。可调参数：无。"""
        self.states.pop(cid, None)

    def client_ids(self) -> list[int]:
        """功能：当前活跃客户端 ID 列表。
        API: client_ids() → list[int]
        依赖：无。可调参数：无。"""
        return list(self.states.keys())

    def is_empty(self) -> bool:
        """功能：是否有活跃客户端。
        API: is_empty() → bool
        依赖：无。可调参数：无。"""
        return not self.states
