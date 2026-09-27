# sync.py — Yjs sync 消息编解码（对齐 y-protocols/sync.js）
# 功能：服务端 YDoc 同步核心。消息结构 [syncSub: varUint][payload]：
#   sub0=step1(客户端发 stateVector) → 服务端回复 step2(encode_state_as_update(doc, clientSV))
#   sub1=step2 / sub2=update → 服务端 Y.apply_update 后广播给其他连接
# 依赖：y_py（Y.YDoc / Y.encode_state_vector / Y.encode_state_as_update / Y.apply_update）、codec
# 可调参数：无（协议常量对齐 y-protocols）
import y_py as Y

from .codec import read_varuint, read_varuint8array, write_varuint, write_varuint8array

SYNC_STEP1 = 0  # 客户端 → 服务端：我有哪些内容（stateVector）
SYNC_STEP2 = 1  # 服务端 → 客户端：你缺的内容（update）
SYNC_UPDATE = 2  # 增量 update 广播（服务端 → 其他客户端 / 客户端 → 服务端）

# 外层消息类型（与 codec.unpack_message 呼应）
MSG_SYNC = 0
MSG_AWARENESS = 1
MSG_AUTH = 2
MSG_QUERY_AWARENESS = 3


def encode_sync_step1(doc) -> bytes:
    """功能：编码 step1 消息（携带本地 stateVector）。
    API: encode_sync_step1(YDoc) → bytes
    依赖：Y.encode_state_vector。可调参数：无。"""
    out = bytearray()
    write_varuint(out, SYNC_STEP1)
    write_varuint8array(out, bytes(Y.encode_state_vector(doc)))
    return bytes(out)


def encode_sync_step2(doc, client_sv: bytes | None) -> bytes:
    """功能：编码 step2 消息（相对 client_sv 的缺失 update；sv=None 表示全量）。
    API: encode_sync_step2(YDoc, bytes|None) → bytes
    依赖：Y.encode_state_as_update。可调参数：无。"""
    out = bytearray()
    write_varuint(out, SYNC_STEP2)
    update = bytes(Y.encode_state_as_update(doc, client_sv))
    write_varuint8array(out, update)
    return bytes(out)


def encode_update_message(update: bytes) -> bytes:
    """功能：编码增量 update 广播消息（sub2）。
    API: encode_update_message(bytes) → bytes
    依赖：write_varuint / write_varuint8array。可调参数：无。"""
    out = bytearray()
    write_varuint(out, SYNC_UPDATE)
    write_varuint8array(out, update)
    return bytes(out)


def decode_sync_message(buf: bytes) -> tuple[int, bytes]:
    """功能：解析 sync 载荷，返回 (sub_type, payload)。
    API: decode_sync_message(bytes) → (int, bytes)
    依赖：read_varuint / read_varuint8array。可调参数：无。"""
    sub, pos = read_varuint(buf, 0)
    payload, _ = read_varuint8array(buf, pos)
    return sub, payload


def doc_diff(doc, sv: bytes | None) -> bytes:
    """功能：计算 doc 相对 sv 的增量 update（sv=None 返回全量）。
    API: doc_diff(YDoc, bytes|None) → bytes
    依赖：Y.encode_state_as_update。可调参数：无。"""
    return bytes(Y.encode_state_as_update(doc, sv))
