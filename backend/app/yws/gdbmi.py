# gdbmi.py — gdb MI（机器接口）调试会话封装
# 功能：在独立工作线程内运行 pygdbmi（gdb -i mi3），解析 *stopped/=breakpoint-* 等事件，
#       提供断点增删/继续/单步/查询等命令封装，事件经 call_soon_threadsafe 桥接回 asyncio。
# 依赖：pygdbmi（GdbController）、threading、config.GDB_BIN
# 可调参数：GDB_BIN（config）
import json
import os
import queue
import threading

from pygdbmi.gdbcontroller import GdbController

from ..config import get_settings

_settings = get_settings()

# MI 结果码 → 事件 type（前端语义）
_STATE_BY_REASON = {
    "breakpoint-hit": "breakpoint",
    "end-stepping-range": "step",
    "function-finished": "step",
    "signal-received": "signal",
    "signalled": "signal",
    "exited": "exit",
    "exited-normally": "exit",
}


class GdbSession:
    """功能：一次断点调试会话（gdb 子进程 + 线程事件循环）。
    API: send(dict)；drain() 取已发生事件；close() 退出 gdb。
    依赖：pygdbmi、threading。可调参数：无。
    线程模型：worker 线程持有 GdbController（其 write/get 均为阻塞），
    命令经命令队列进入，事件经 emit 回调（loop.call_soon_threadsafe）出。"""

    def __init__(self, bin_path: str, source_path: str, emit) -> None:
        self.source_path = source_path
        self.emit = emit  # callable(evt_dict)：线程安全地把事件交给 asyncio 队列
        self.controller = GdbController(
            command=["env", "-u", "LD_PRELOAD",
                     _settings.GDB_BIN, "--nx", "--quiet", "--interpreter=mi3", bin_path])
        self.breakpoints: dict[int, str] = {}  # line -> gdb bkpt number
        self._cmd_q: queue.Queue = queue.Queue()
        self._alive = True
        self._thread = threading.Thread(target=self._run, daemon=True, name="gdbmi")
        self._started = False

    def start(self) -> None:
        """功能：启动工作线程。
        API: start() → None
        依赖：threading。可调参数：无。"""
        self._started = True
        self._thread.start()

    def send(self, cmd: dict) -> None:
        """功能：向 gdb 投递一条命令（线程安全，立即返回）。
        API: send(dict) → None
        依赖：queue。可调参数：无。"""
        if self._alive:
            self._cmd_q.put(cmd)

    def close(self) -> None:
        """功能：结束会话（发 quit 并退出线程）。
        API: close() → None
        依赖：queue。可调参数：无。"""
        if not self._alive:
            return
        self._alive = False
        self.send({"t": "__exit__"})
        # 给 worker 一点时间处理 quit
        self._thread.join(timeout=2)

    # ---- 命令处理（worker 线程内执行，可阻塞） ----

    def _write(self, mi_cmd: str, timeout_sec: float = 3) -> list:
        """功能：向 gdb 写 MI 命令，返回全部响应消息；响应里的异步事件
        （*stopped 等）也会转发给 _on_message，避免被 write() 返回值吞掉。
        API: _write(str, float) → list
        依赖：pygdbmi。可调参数：无。"""
        try:
            resp = self.controller.write(mi_cmd, timeout_sec=timeout_sec)
            for m in resp:
                self._on_message(m)
            return resp
        except Exception:
            return []

    def _handle_command(self, cmd: dict) -> None:
        t = cmd.get("t")
        if t == "__exit__":
            try:
                self.controller.exit()
            except Exception:
                pass
            self.emit({"t": "closed"})
            return
        if t == "break":
            line = cmd["line"]
            if line in self.breakpoints:
                return
            resp = self._write(f"-break-insert {self.source_path}:{line}", timeout_sec=5)
            for m in resp:
                if m.get("type") == "result" and m.get("message") == "done" and m.get("payload"):
                    bkpt = m["payload"].get("bkpt") or {}
                    num = str(bkpt.get("number", line))
                    self.breakpoints[line] = num
            self._emit_breakpoints()
        elif t == "breakDel":
            line = cmd["line"]
            num = self.breakpoints.pop(line, None)
            if num is not None:
                self._write(f"-break-delete {num}", timeout_sec=5)
            self._emit_breakpoints()
        elif t == "continue":
            self._write("-exec-continue")
        elif t == "next":
            self._write("-exec-next")
        elif t == "step":
            self._write("-exec-step")
        elif t == "finish":
            self._write("-exec-finish")
        elif t == "restart":
            self._write("-exec-run")
        elif t == "stop":
            # 终止调试：中断执行后退出 gdb
            try:
                self.controller.write("-exec-abort", timeout_sec=2)
            except Exception:
                pass
            self._alive = False
            try:
                self.controller.exit()
            except Exception:
                pass
            self.emit({"t": "closed"})
        elif t == "stack":
            self._emit_stack()
        elif t == "vars":
            self._emit_vars()
        elif t == "watch":
            # 自定义监控：对表达式列表逐个求值（程序需处于 stopped 状态）
            results = []
            for expr in cmd.get("exprs", []):
                results.append(self._evaluate(expr))
            self.emit({"t": "watch", "results": results})
        elif t == "stdin":
            # 程序 stdin：以 gdb 控制台输入转发（inferior 运行中等待输入时 gdb 会透传）。
            # 必须经 _write 回喂响应：write() 的返回值里夹带 inferior 对该输入的回显
            # （如 "got 42"）以及 *stopped 退出事件，直接丢弃会导致输出/退出丢失。
            data = cmd.get("data", "")
            try:
                self._write(data.rstrip("\n"), timeout_sec=1)
            except Exception:
                pass

    # ---- 事件处理（worker 线程内） ----

    def _run(self) -> None:
        """功能：worker 主循环——轮询 gdb 响应与命令队列。
        API: _run() → None
        依赖：pygdbmi。可调参数：无。"""
        # 启动横幅（含程序路径提示），丢掉避免污染输出
        try:
            self.controller.get_gdb_response(timeout_sec=2)
        except Exception:
            pass
        while self._alive:
            # 1) 轮询 gdb 输出（短超时，不因超时抛异常）
            try:
                for m in self.controller.get_gdb_response(
                        timeout_sec=0.05, raise_error_on_timeout=False):
                    self._on_message(m)
            except Exception:
                # gdb 已退出等异常：若自认为存活则标记结束
                if self._alive:
                    self._alive = False
                    self.emit({"t": "closed"})
                break
            # 2) 取命令并执行
            try:
                cmd = self._cmd_q.get_nowait()
            except queue.Empty:
                cmd = None
            if cmd is not None:
                self._handle_command(cmd)
                if not self._alive:
                    break
        # 线程退出前兜底
        try:
            self.controller.exit()
        except Exception:
            pass

    def _on_message(self, m: dict) -> None:
        """功能：翻译一条 pygdbmi 消息为对外事件。
        API: _on_message(dict) → None
        依赖：无。可调参数：无。"""
        mtype = m.get("type")
        message = m.get("message", "")
        payload = m.get("payload")
        if mtype == "notify" and message == "stopped":
            self._on_stopped(payload or {})
        elif mtype == "notify" and message.startswith("breakpoint"):
            self._emit_breakpoints()
        elif mtype in ("output", "console"):
            text = payload if isinstance(payload, str) else (payload or "")
            if mtype == "output":
                # pygdbmi 把 inferior 程序的裸输出按 \n 切行并剥掉行尾换行
                # （_get_responses_list: split("\n") + 过滤空白行），这里补回 \n，
                # 否则前端行缓冲终端收不到换行、多行输出会被拼成一行（"换行失效"）。
                text += "\n"
            if text.strip():
                self.emit({"t": "stdout", "data": text})
        elif mtype == "log":
            text = payload if isinstance(payload, str) else (payload or "")
            if text.strip():
                self.emit({"t": "stderr", "data": text})

    def _on_stopped(self, payload: dict) -> None:
        """功能：处理 *stopped 事件（断点命中/单步结束/退出/信号）。
        API: _on_stopped(dict) → None
        依赖：无。可调参数：无。"""
        reason = payload.get("reason", "")
        frame = payload.get("frame") or {}
        state = _STATE_BY_REASON.get(reason, "stopped")
        line = None
        file = None
        try:
            line = int(frame.get("line", 0))
        except (TypeError, ValueError):
            line = None
        full = frame.get("fullname") or frame.get("file")
        if full:
            file = os.path.basename(full)
        evt = {
            "t": "state",
            "state": "stopped",
            "reason": state,
            "line": line,
            "file": file,
            "exit_code": payload.get("exit-code"),
            "signal": payload.get("sig-name"),
        }
        # 断点命中：gdb 报告的行号是相对源码的（含编译目录差异时可能 +1/-1，接受）
        self.emit(evt)
        if state == "exit":
            self.emit({"t": "exit", "code": payload.get("exit-code"), "time_ms": None})
        if state != "exit":
            self._emit_stack()
            self._emit_vars()

    def _emit_stack(self) -> None:
        """功能：查询并上报调用栈。
        API: _emit_stack() → None
        依赖：pygdbmi。可调参数：无。"""
        try:
            resp = self.controller.write("-stack-list-frames", timeout_sec=3)
            frames = []
            for m in resp:
                if m.get("type") == "result" and m.get("message") == "done" and m.get("payload"):
                    for f in (m["payload"].get("stack") or []):
                        fr = f.get("frame") or f
                        frames.append({
                            "level": fr.get("level"),
                            "func": fr.get("func"),
                            "file": os.path.basename(fr.get("fullname") or fr.get("file") or ""),
                            "line": fr.get("line"),
                        })
            self.emit({"t": "stack", "stack": frames})
        except Exception:
            self.emit({"t": "stack", "stack": []})

    def _emit_vars(self) -> None:
        """功能：查询并上报当前帧局部变量（simple-values）。
        API: _emit_vars() → None
        依赖：pygdbmi。可调参数：无。
        注意：不加 --frame 选项——老版本 gdb（9.x）不支持，且默认即为当前帧。"""
        try:
            resp = self.controller.write(
                "-stack-list-variables --simple-values", timeout_sec=3)
            variables = []
            for m in resp:
                if m.get("type") == "result" and m.get("message") == "done" and m.get("payload"):
                    for v in (m["payload"].get("variables") or []):
                        variables.append({
                            "name": v.get("name"),
                            "value": v.get("value"),
                            "type": v.get("type"),
                        })
            self.emit({"t": "vars", "vars": variables})
        except Exception:
            self.emit({"t": "vars", "vars": []})

    def _emit_breakpoints(self) -> None:
        """功能：上报当前断点列表（前端据此同步红点）。
        API: _emit_breakpoints() → None
        依赖：无。可调参数：无。"""
        self.emit({"t": "breakpoints",
                   "list": [{"line": ln, "enabled": True} for ln in self.breakpoints]})

    def _evaluate(self, expr: str) -> dict:
        """功能：对单个监控表达式求值，返回 {expr, value, ok}。
        API: _evaluate(str) → dict
        依赖：pygdbmi。可调参数：无。
        注意：gdb MI 的 -data-evaluate-expression 不支持带空格的表达式（会报
        usage 错误），实测给表达式加双引号包裹即可整体求值；表达式自身含
        引号时退回 CLI `print` 并解析 console 输出（格式 `$N = value`）。"""
        expr = (expr or "").strip()
        try:
            if '"' not in expr:
                quoted = f'"{expr}"' if (" " in expr or "\t" in expr) else expr
                resp = self.controller.write(f"-data-evaluate-expression {quoted}", timeout_sec=3)
                for m in resp:
                    if m.get("type") == "result":
                        payload = m.get("payload") or {}
                        if m.get("message") == "done":
                            return {"expr": expr, "value": payload.get("value"), "ok": True}
                        return {"expr": expr, "value": payload.get("msg"), "ok": False}
                return {"expr": expr, "value": None, "ok": False}
            # 表达式含引号：CLI print 方式（MI 无法安全传递）
            resp = self.controller.write(f"print {expr}", timeout_sec=3)
            for m in resp:
                if m.get("type") == "result" and m.get("message") == "error":
                    return {"expr": expr, "value": (m.get("payload") or {}).get("msg"),
                            "ok": False}
                if m.get("type") == "console" and isinstance(m.get("payload"), str):
                    import re
                    match = re.search(r"^\$\d+ = (.*)$", m["payload"].strip(), re.S)
                    if match:
                        return {"expr": expr, "value": match.group(1).strip(), "ok": True}
            return {"expr": expr, "value": None, "ok": False}
        except Exception:
            return {"expr": expr, "value": None, "ok": False}
