# config.py — 集中管理可调参数
# 功能：所有可调配置项集中于此，环境变量可覆盖（KEY=VALUE 形式）。
# 依赖：os（读环境变量）
# 可调参数：
#   DB_PATH                SQLite 数据库路径（默认 data/app.db，相对项目根目录）
#   SESSION_TTL_DAYS       登录会话有效期天数（默认 7）
#   PALETTE                比赛开始时为成员分配的颜色池（默认 8 色，取前 N 个）
#   DEFAULT_DURATION_MINUTES 创建比赛默认时长（默认 300 = ICPC 5 小时）
#   WS_MAX_MESSAGE_BYTES   WebSocket 单条消息大小上限（默认 16MB，防滥用）
#   VENDOR_DIR / FRONTEND_DIR 静态资源目录（默认 vendor/、frontend/，相对项目根目录）
import os
from dataclasses import dataclass, field

# 项目根目录 = backend/ 的上级目录
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _env(key: str, default: str) -> str:
    return os.environ.get(key, default)


@dataclass(frozen=True)
class Settings:
    DB_PATH: str = field(default_factory=lambda: _env("DB_PATH", os.path.join(PROJECT_ROOT, "data", "app.db")))
    SESSION_TTL_DAYS: int = field(default_factory=lambda: int(_env("SESSION_TTL_DAYS", "7")))
    PALETTE: tuple = field(default_factory=lambda: tuple(
        _env("PALETTE", "#e6194B,#3cb44b,#4363d8,#f58231,#911eb4,#42d4f4,#f032e6,#008080").split(",")
    ))
    DEFAULT_DURATION_MINUTES: int = field(default_factory=lambda: int(_env("DEFAULT_DURATION_MINUTES", "300")))
    WS_MAX_MESSAGE_BYTES: int = field(default_factory=lambda: int(_env("WS_MAX_MESSAGE_BYTES", str(16 * 1024 * 1024))))
    VENDOR_DIR: str = field(default_factory=lambda: _env("VENDOR_DIR", os.path.join(PROJECT_ROOT, "vendor")))
    FRONTEND_DIR: str = field(default_factory=lambda: _env("FRONTEND_DIR", os.path.join(PROJECT_ROOT, "frontend")))


# 模块级单例，import 时构造一次
_settings = Settings()


def get_settings() -> Settings:
    """功能：获取全局配置单例。依赖：无。可调参数：见 Settings 字段（env 覆盖）。"""
    return _settings
