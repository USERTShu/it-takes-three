# codec.py — lib0 变长编码（纯 Python）
# 功能：实现 y-websocket 协议所需的 lib0 编码原语：varUint（LEB128）、
#       varUint8Array（长度前缀 + 字节）、varString（UTF-8 长度前缀 + 字节）。
# 依赖：无（标准库）
# 可调参数：无
# 说明：与 lib0 的 encoding.js/decoding.js 逐字节对齐，yjs 前端可无缝互通。
import struct


def write_varuint(out: bytearray, value: int) -> None:
    """功能：LEB128 变长编码无符号整数（7 位/字节，低位在前）。
    API: write_varuint(bytearray, int) → None
    依赖：无。可调参数：无。"""
    assert value >= 0, "varUint 仅支持无符号整数"
    while True:
        b = value & 0x7F
        value >>= 7
        if value:
            out.append(b | 0x80)
        else:
            out.append(b)
            return


def read_varuint(buf: bytes, pos: int = 0) -> tuple[int, int]:
    """功能：从 buf 的 pos 起读取一个 LEB128 varUint。
    API: read_varuint(bytes, pos=0) → (value, next_pos)
    依赖：无。可调参数：无。"""
    result = 0
    shift = 0
    while True:
        if pos >= len(buf):
            raise ValueError("varUint 截断：缓冲区不足")
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            return result, pos
        shift += 7
        if shift > 35:
            raise ValueError("varUint 过长（超过 5 字节上限）")


def write_varuint8array(out: bytearray, data: bytes) -> None:
    """功能：写长度前缀 + 原始字节（varUint8Array）。
    API: write_varuint8array(bytearray, bytes) → None
    依赖：write_varuint。可调参数：无。"""
    write_varuint(out, len(data))
    out += data


def read_varuint8array(buf: bytes, pos: int = 0) -> tuple[bytes, int]:
    """功能：读长度前缀 + 原始字节。
    API: read_varuint8array(bytes, pos=0) → (bytes, next_pos)
    依赖：read_varuint。可调参数：无。"""
    length, pos = read_varuint(buf, pos)
    if pos + length > len(buf):
        raise ValueError("varUint8Array 截断：长度越界")
    return buf[pos:pos + length], pos + length


def write_varstring(out: bytearray, text: str) -> None:
    """功能：写 UTF-8 长度前缀 + 字节（varString）。
    API: write_varstring(bytearray, str) → None
    依赖：write_varuint。可调参数：无。"""
    encoded = text.encode("utf-8")
    write_varuint(out, len(encoded))
    out += encoded


def read_varstring(buf: bytes, pos: int = 0) -> tuple[str, int]:
    """功能：读 UTF-8 长度前缀 + 字节。
    API: read_varstring(bytes, pos=0) → (str, next_pos)
    依赖：read_varuint。可调参数：无。"""
    length, pos = read_varuint(buf, pos)
    if pos + length > len(buf):
        raise ValueError("varString 截断：长度越界")
    return buf[pos:pos + length].decode("utf-8"), pos + length


def read_message_type(buf: bytes) -> tuple[int, int]:
    """功能：读取外层消息类型（0=sync, 1=awareness, 2=auth, 3=queryAwareness）。
    API: read_message_type(bytes) → (type, next_pos)
    依赖：read_varuint。可调参数：无。"""
    return read_varuint(buf, 0)


def pack_message(msg_type: int, payload: bytes) -> bytes:
    """功能：封装外层消息：[type: varUint][payload]。
    API: pack_message(int, bytes) → bytes
    依赖：write_varuint。可调参数：无。"""
    out = bytearray()
    write_varuint(out, msg_type)
    out += payload
    return bytes(out)


def unpack_message(buf: bytes) -> tuple[int, bytes]:
    """功能：解包外层消息，返回 (type, payload)。
    API: unpack_message(bytes) → (int, bytes)
    依赖：read_message_type、read_varuint。可调参数：无。"""
    msg_type, pos = read_message_type(buf)
    return msg_type, buf[pos:]
