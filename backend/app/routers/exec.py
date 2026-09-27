# exec.py — 运行/调试 WebSocket 端点
# 功能：
#   /ws/contest/{slug}/run   交互式运行：编译(g++17 -O2) → 运行 → 流式 stdout/stderr → stdin 交互
#   /ws/contest/{slug}/debug  gdb 断点调试：编译(-g) → gdb MI 会话 → 断点/继续/单步/变量/调用栈
# 消息均为 JSON 文本帧（协议表见 .for_human_dev.md）。
# 依赖：fastapi、exec、yws.gdbmi、security、models、config
# 可调参数：RUN_COMPILE_TIMEOUT_SECONDS / RUN_TIME_LIMIT_SECONDS / RUN_DIR / GDB_BIN（config）
import asyncio
import json
import os
import uuid

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import SessionLocal
from ..exec import RunProcess, cleanup_workdir, compile_program, make_workdir, sanitize_path, sync_room_files
from ..models import Contest, ContestMember
from ..security import get_user_by_token
from ..state import rooms
from ..yws.gdbmi import GdbSession

router = APIRouter()

_settings = get_settings()


# ---- 会话注册表：同一 (slug, user_id) 同时只能有一个运行/调试会话 ----

class _Session:
    """功能：一个用户的运行/调试会话（process 或 gdb 二选一）。
    依赖：exec/GdbSession。可调参数：无。"""

    def __init__(self, kind: str) -> None:
        self.kind = kind  # "run" | "debug"
        self.workdir = ""
        self.proc: RunProcess | None = None
        self.gdb: GdbSession | None = None


_sessions: dict[tuple[str, int], _Session] = {}


def _kill_existing(key: tuple[str, int]) -> None:
    """功能：终止并清理该 key 已有的运行/调试会话（对齐 VS Code 再次启动即替换）。
    API: _kill_existing(tuple) → None
    依赖：asyncio。可调参数：无。"""
    prev = _sessions.pop(key, None)
    if prev is None:
        return
    if prev.proc is not None:
        try:
            prev.proc.terminate()
        except Exception:
            pass
    if prev.gdb is not None:
        prev.gdb.close()
    cleanup_workdir(prev.workdir)


async def _authorize(websocket: WebSocket, token: str, slug: str) -> int | None:
    """功能：鉴权（token 有效 + 是该比赛成员），失败关闭连接并返回 None。
    API: _authorize(WebSocket, str, str) → int|None
    依赖：security、models。可调参数：无。"""
    db: Session = SessionLocal()
    try:
        user = get_user_by_token(db, token)
        if user is None:
            await websocket.close(code=4001)
            return None
        contest = db.query(Contest).filter(Contest.slug == slug).first()
        if contest is None:
            await websocket.close(code=4004)
            return None
        member = (
            db.query(ContestMember)
            .filter(ContestMember.contest_id == contest.id, ContestMember.user_id == user.id)
            .first()
        )
        if member is None:
            await websocket.close(code=4003)
            return None
        return user.id
    finally:
        db.close()


# ---- 交互式运行 ----

@router.websocket("/ws/contest/{slug}/run")
async def ws_run(websocket: WebSocket, slug: str, token: str = Query(default="")) -> None:
    """功能：交互式运行会话。start 后台编译并执行，stdout/stderr 流式回传，stdin/kill 控制进程。
    依赖：exec。可调参数：RUN_COMPILE_TIMEOUT_SECONDS / RUN_TIME_LIMIT_SECONDS。"""
    user_id = await _authorize(websocket, token, slug)
    if user_id is None:
        return
    await websocket.accept()
    key = (slug, user_id)
    _kill_existing(key)
    evt_q: asyncio.Queue = asyncio.Queue()
    session = _Session("run")
    session.workdir = make_workdir(slug, f"run-{user_id}-{uuid.uuid4().hex[:6]}")
    _sessions[key] = session
    run_task: asyncio.Task | None = None
    try:
        while True:
            try:
                text = await asyncio.wait_for(websocket.receive_text(), timeout=0.1)
            except asyncio.TimeoutError:
                text = None
            except WebSocketDisconnect:
                break
            if text is not None:
                msg = json.loads(text)
                t = msg.get("t")
                if t == "start":
                    if run_task is not None and not run_task.done():
                        run_task.cancel()
                    path = sanitize_path(msg.get("path", ""))
                    if path is None:
                        evt_q.put_nowait({"t": "compile", "ok": False, "error": "非法文件路径"})
                    else:
                        room = rooms.get_or_create(slug)
                        run_task = asyncio.create_task(
                            _run_program(room, path, session, evt_q))
                elif t == "stdin":
                    if session.proc is not None:
                        await session.proc.write_stdin(msg.get("data", ""))
                elif t == "kill":
                    if session.proc is not None:
                        await session.proc.terminate()
            while True:
                try:
                    evt = evt_q.get_nowait()
                except asyncio.QueueEmpty:
                    break
                await websocket.send_text(json.dumps(evt))
    finally:
        if run_task is not None:
            run_task.cancel()
        if session.proc is not None:
            await session.proc.terminate()
        _sessions.pop(key, None)
        cleanup_workdir(session.workdir)


async def _run_program(room, path: str, session: _Session, evt_q: asyncio.Queue) -> None:
    """功能：后台任务——编译并运行，事件全部入队由主循环转发。
    API: _run_program(ContestRoom, str, _Session, Queue) → None
    依赖：exec。可调参数：无。"""
    # 先把房间全部文件写入工作目录（数据文件 in 等，支持 freopen 模式）
    sync_room_files(room, session.workdir)
    ok, err, bin_path = await compile_program(room, path, debug=False, workdir=session.workdir)
    if not ok:
        evt_q.put_nowait({"t": "compile", "ok": False, "error": err or "编译失败"})
        evt_q.put_nowait({"t": "exit", "code": None, "time_ms": None, "killed": False})
        return
    evt_q.put_nowait({"t": "compile", "ok": True})

    def on_out(data: str) -> None:
        evt_q.put_nowait({"t": "stdout", "data": data})

    def on_err(data: str) -> None:
        evt_q.put_nowait({"t": "stderr", "data": data})

    proc = RunProcess(bin_path, session.workdir,
                      time_limit_s=_settings.RUN_TIME_LIMIT_SECONDS,
                      on_stdout=on_out, on_stderr=on_err)
    session.proc = proc
    try:
        await proc.start()
        code = await proc.wait()
        evt_q.put_nowait({
            "t": "exit", "code": code, "time_ms": proc.elapsed_ms(),
            "killed": proc.timed_out(),
        })
    except asyncio.CancelledError:
        await proc.terminate()
        raise


# ---- gdb 断点调试 ----

@router.websocket("/ws/contest/{slug}/debug")
async def ws_debug(websocket: WebSocket, slug: str, token: str = Query(default="")) -> None:
    """功能：gdb 断点调试会话。start 编译(-g)并启动 gdb 自动运行程序；
    命令（break/continue/next/step/finish/restart/stop/stack/vars/stdin）转给 gdb 工作线程。
    依赖：yws.gdbmi、exec。可调参数：RUN_COMPILE_TIMEOUT_SECONDS / GDB_BIN。"""
    user_id = await _authorize(websocket, token, slug)
    if user_id is None:
        return
    await websocket.accept()
    key = (slug, user_id)
    _kill_existing(key)
    evt_q: asyncio.Queue = asyncio.Queue()
    session = _Session("debug")
    session.workdir = make_workdir(slug, f"dbg-{user_id}-{uuid.uuid4().hex[:6]}")
    _sessions[key] = session
    loop = asyncio.get_running_loop()

    def emit(evt: dict) -> None:
        loop.call_soon_threadsafe(evt_q.put_nowait, evt)

    start_task: asyncio.Task | None = None
    try:
        while True:
            try:
                text = await asyncio.wait_for(websocket.receive_text(), timeout=0.1)
            except asyncio.TimeoutError:
                text = None
            except WebSocketDisconnect:
                break
            if text is not None:
                msg = json.loads(text)
                t = msg.get("t")
                if t == "start":
                    if start_task is not None and not start_task.done():
                        start_task.cancel()
                    path = sanitize_path(msg.get("path", ""))
                    if path is None:
                        evt_q.put_nowait({"t": "compile", "ok": False, "error": "非法文件路径"})
                    else:
                        room = rooms.get_or_create(slug)
                        start_task = asyncio.create_task(
                            _start_gdb(room, path, session, emit, evt_q))
                elif t in ("break", "breakDel", "continue", "next", "step", "finish",
                           "restart", "stop", "stack", "vars", "stdin"):
                    if session.gdb is not None:
                        cmd = {"t": t}
                        if t in ("break", "breakDel"):
                            line = msg.get("line")
                            if isinstance(line, int) and line > 0:
                                cmd["line"] = line
                        elif t == "stdin":
                            cmd["data"] = msg.get("data", "")
                        session.gdb.send(cmd)
            while True:
                try:
                    evt = evt_q.get_nowait()
                except asyncio.QueueEmpty:
                    break
                await websocket.send_text(json.dumps(evt))
    finally:
        if start_task is not None:
            start_task.cancel()
        if session.gdb is not None:
            session.gdb.close()
        _sessions.pop(key, None)
        cleanup_workdir(session.workdir)


async def _start_gdb(room, path: str, session: _Session, emit, evt_q: asyncio.Queue) -> None:
    """功能：后台任务——编译(-g)后启动 gdb 会话并自动运行程序。
    API: _start_gdb(ContestRoom, str, _Session, callable, Queue) → None
    依赖：exec、yws.gdbmi。可调参数：无。"""
    # 先把房间全部文件写入工作目录（数据文件 in 等，支持 freopen 模式）
    sync_room_files(room, session.workdir)
    ok, err, bin_path = await compile_program(room, path, debug=True, workdir=session.workdir)
    if not ok:
        evt_q.put_nowait({"t": "compile", "ok": False, "error": err or "编译失败"})
        evt_q.put_nowait({"t": "exit", "code": None, "time_ms": None})
        return
    evt_q.put_nowait({"t": "compile", "ok": True})
    src_path = os.path.join(session.workdir, path)
    gdb = GdbSession(bin_path, src_path, emit)
    session.gdb = gdb
    gdb.start()
    # 注意：不在此自动 -exec-run。前端在「编译成功」后先下发全部断点，
    # 再发 restart 启动程序（避免断点尚未设置程序就跑完的竞态）。
