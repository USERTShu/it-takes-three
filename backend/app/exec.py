# exec.py — 编译与程序执行核心（运行/调试共用）
# 功能：从比赛 YDoc 取源码写入工作目录 → g++17 编译（run/debug 两套 flags）→
#       以 asyncio 子进程运行程序：流式转发 stdout/stderr、写入 stdin、时限 kill。
# 依赖：asyncio、y_py（YDoc 源码）、config
# 可调参数：RUN_COMPILE_TIMEOUT_SECONDS / RUN_TIME_LIMIT_SECONDS / RUN_DIR / GDB_BIN（config）
import asyncio
import os
import re
import shutil
import time

from .config import get_settings
from .yws.room import ContestRoom

_settings = get_settings()

# 编译 flags：run 用 -O2；debug 用 -g（断点/单步需要符号信息）
FLAGS_RUN = ("-std=c++17", "-O2", "-Wall")
FLAGS_DEBUG = ("-std=c++17", "-g", "-O0", "-fno-omit-frame-pointer")

# 路径安全校验：只允许普通文件名/相对子目录，禁止绝对路径与 .. 穿越
_PATH_RE = re.compile(r"^[\w.\-]+(?:/[\w.\-]+)*$")


def sanitize_path(path: str) -> str | None:
    """功能：校验并规整文件路径，非法（绝对/..穿越/特殊字符）返回 None。
    API: sanitize_path(str) → str|None
    依赖：re。可调参数：无。"""
    p = (path or "").strip().lstrip("/")
    if not p or p == "." or ".." in p.split("/") or not _PATH_RE.match(p):
        return None
    return p


def _source_from_room(room: ContestRoom, path: str) -> str | None:
    """功能：从房间 YDoc 的 files map 读取文件源码。
    API: _source_from_room(ContestRoom, str) → str|None
    依赖：y_py。可调参数：无。"""
    ytext = room.get_map("files").get(path)
    if ytext is None:
        return None
    return str(ytext)


def make_workdir(slug: str, session_id: str) -> str:
    """功能：创建本次运行/调试的工作目录（data/run/<slug>/<session_id>）。
    API: make_workdir(str, str) → str
    依赖：os。可调参数：RUN_DIR（config）。"""
    d = os.path.join(_settings.RUN_DIR, slug, session_id)
    os.makedirs(d, exist_ok=True)
    return d


def cleanup_workdir(d: str) -> None:
    """功能：删除工作目录（会话结束时清理二进制与源码）。
    API: cleanup_workdir(str) → None
    依赖：shutil。可调参数：无。"""
    try:
        shutil.rmtree(d, ignore_errors=True)
    except Exception:
        pass


def sync_room_files(room: ContestRoom, workdir: str) -> None:
    """功能：把房间 YDoc 的全部文件写入工作目录（含数据文件，
    支持 freopen("in", "r", stdin) 读取项目内文件）。
    API: sync_room_files(ContestRoom, str) → None
    依赖：y_py、sanitize_path。可调参数：无。"""
    files_map = room.get_map("files")
    for path in (files_map.keys() or []):
        p = sanitize_path(str(path))
        if p is None:
            continue
        dst = os.path.join(workdir, p)
        os.makedirs(os.path.dirname(dst) or workdir, exist_ok=True)
        with open(dst, "w", encoding="utf-8") as f:
            f.write(str(files_map.get(p)))


def _clean_env() -> dict:
    """功能：返回去除沙箱注入的子进程环境（移除 LD_PRELOAD 的 sbox.so）。
    环境约束：本机沙箱把 sbox.so 注入所有进程（LD_PRELOAD），它拦截 exec/errno 等
    系统调用，会破坏 g++ 子进程（确定性 SIGSEGV）并干扰运行程序 stdin 交互。
    API: _clean_env() → dict
    依赖：os。可调参数：无。"""
    env = dict(os.environ)
    env.pop("LD_PRELOAD", None)
    return env


async def compile_program(room: ContestRoom, path: str, debug: bool,
                          workdir: str) -> tuple[bool, str | None, str | None]:
    """功能：从 YDoc 取源码并 g++17 编译。
    API: compile_program(ContestRoom, str, bool, str) → (ok, err_msg, bin_path)
    依赖：asyncio、y_py、config.RUN_COMPILE_TIMEOUT_SECONDS。可调参数：无。
    返回：(True, None, bin) 成功；(False, 错误文本, None) 失败。"""
    source = _source_from_room(room, path)
    if source is None:
        return False, "文件不存在（可能已被删除）", None
    src = os.path.join(workdir, path)
    os.makedirs(os.path.dirname(src) or workdir, exist_ok=True)
    with open(src, "w", encoding="utf-8") as f:
        f.write(source)
    bin_path = os.path.join(workdir, "a.out")
    flags = FLAGS_DEBUG if debug else FLAGS_RUN
    cmd = ["g++", *flags, "-o", bin_path, src]
    # 受限环境（沙箱 sbox.so 经 LD_PRELOAD 注入）下，由 uvicorn 直接派生 g++ 会
    # 确定性 SIGSEGV；因此改经 python3 的 subprocess 中间层派生并去除 LD_PRELOAD。
    # 崩溃型失败（rc<0、stderr 空）再重试 1-2 次，正常机器不会触发。
    for attempt in range(3):
        try:
            _env = _clean_env()
            # 中间层必须把 g++ 的退出码透传出来（sys.exit），否则 python 进程恒返回 0，
            # 编译失败（如漏写 std::）会被误判为成功，随后启动不存在的 a.out 而静默卡死。
            _py = "import subprocess,sys;sys.exit(subprocess.run(sys.argv[1:]).returncode)"
            _spawn = ["/usr/bin/python3.11", "-u", "-c", _py, *cmd]
            proc = await asyncio.create_subprocess_exec(
                *_spawn, env=_env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            try:
                _, stderr = await asyncio.wait_for(
                    proc.communicate(), timeout=_settings.RUN_COMPILE_TIMEOUT_SECONDS)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.communicate()
                return False, "编译超时（>%ds）" % _settings.RUN_COMPILE_TIMEOUT_SECONDS, None
            # 兜底：退出码 0 且目标二进制确实产出才判定成功（防任何中间层误报）
            if proc.returncode == 0 and os.path.exists(bin_path):
                return True, None, bin_path
        except FileNotFoundError:
            return False, "g++ 未安装或不在 PATH 中", None
        if proc.returncode < 0 and attempt < 2:
            await asyncio.sleep(1.0)
            continue
        return False, (stderr or b"").decode("utf-8", "replace"), None
    return False, "编译失败", None  # 不可达（保险）


class RunProcess:
    """功能：一个正在运行的程序（asyncio 子进程 + 流式管道 + 时限控制）。
    API: start() 启动并开始读输出；write_stdin(str)；terminate()；
         wait() 等待退出返回码；elapsed_ms()；timed_out()。
    依赖：asyncio、config.RUN_TIME_LIMIT_SECONDS。可调参数：无。"""

    def __init__(self, bin_path: str, cwd: str, time_limit_s: float,
                 on_stdout, on_stderr) -> None:
        self.bin_path = bin_path
        self.cwd = cwd
        self.time_limit_s = time_limit_s
        self.on_stdout = on_stdout
        self.on_stderr = on_stderr
        self.proc: asyncio.subprocess.Process | None = None
        self._readers: list[asyncio.Task] = []
        self._timeout_task: asyncio.Task | None = None
        self._timed_out = False
        self.start_time = 0.0

    async def start(self) -> None:
        """功能：启动子进程并挂起输出读取与时限任务。
        API: start() → None
        依赖：asyncio。可调参数：无。"""
        self.proc = await asyncio.create_subprocess_exec(
            self.bin_path,
            env=_clean_env(),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self.cwd,
        )
        self.start_time = time.monotonic()
        self._readers = [
            asyncio.create_task(self._read(self.proc.stdout, self.on_stdout)),
            asyncio.create_task(self._read(self.proc.stderr, self.on_stderr)),
        ]
        self._timeout_task = asyncio.create_task(self._enforce_timeout())

    async def _read(self, stream, callback) -> None:
        """功能：逐行读取管道并回调（utf-8 容错解码）。
        API: _read(StreamReader, callable) → None
        依赖：asyncio。可调参数：无。"""
        try:
            while True:
                line = await stream.readline()
                if not line:
                    break
                callback(line.decode("utf-8", "replace"))
        except Exception:
            pass

    async def _enforce_timeout(self) -> None:
        """功能：到时强制 kill 并标记 TLE。
        API: _enforce_timeout() → None
        依赖：asyncio。可调参数：无。"""
        await asyncio.sleep(self.time_limit_s)
        if self.proc and self.proc.returncode is None:
            self._timed_out = True
            self.proc.kill()

    async def write_stdin(self, data: str) -> None:
        """功能：向程序 stdin 写入文本（交互输入）。
        API: write_stdin(str) → None
        依赖：asyncio。可调参数：无。"""
        if self.proc and self.proc.stdin and not self.proc.stdin.is_closing():
            try:
                self.proc.stdin.write(data.encode("utf-8"))
                await self.proc.stdin.drain()
            except Exception:
                pass

    async def terminate(self) -> None:
        """功能：终止程序（先 SIGTERM，1s 后未退则 SIGKILL）。
        API: terminate() → None
        依赖：asyncio。可调参数：无。"""
        if self.proc and self.proc.returncode is None:
            try:
                self.proc.terminate()
                try:
                    await asyncio.wait_for(self.proc.wait(), timeout=1)
                except asyncio.TimeoutError:
                    self.proc.kill()
            except Exception:
                pass

    async def wait(self) -> int:
        """功能：等待程序退出，返回退出码（已被 kill 返回 -1）。
        API: wait() → int
        依赖：asyncio。可调参数：无。"""
        if self.proc is None:
            return -1
        await self.proc.wait()
        for t in self._readers:
            try:
                await t
            except Exception:
                pass
        if self._timeout_task:
            self._timeout_task.cancel()
        return self.proc.returncode if self.proc.returncode is not None else -1

    def elapsed_ms(self) -> int:
        """功能：已运行毫秒数。
        API: elapsed_ms() → int
        依赖：time。可调参数：无。"""
        if not self.start_time:
            return 0
        return int((time.monotonic() - self.start_time) * 1000)

    def timed_out(self) -> bool:
        """功能：是否因超时被 kill。
        API: timed_out() → bool
        依赖：无。可调参数：无。"""
        return self._timed_out
