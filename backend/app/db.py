# db.py — SQLAlchemy 引擎 / 会话 / 基类
# 功能：创建数据库引擎、会话工厂、声明式基类，并提供 init_db() 建表。
# 依赖：sqlalchemy（锁版本 2.0.54）
# 可调参数：连接参数 check_same_thread=False（FastAPI 多线程访问 SQLite）；
#           WAL 模式提升并发读写（3 用户场景绰绰有余）
import os

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import get_settings

_settings = get_settings()

# 确保数据库文件所在目录存在
os.makedirs(os.path.dirname(_settings.DB_PATH), exist_ok=True)

engine = create_engine(
    f"sqlite:///{_settings.DB_PATH}",
    connect_args={"check_same_thread": False},
)
# 功能：SQLite 开启 WAL 日志模式，允许并发读写
@event.listens_for(engine, "connect")
def _set_sqlite_pragma(dbapi_conn, _record):
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    """功能：所有 ORM 模型的声明式基类。依赖：sqlalchemy.orm.DeclarativeBase。"""


def init_db():
    """功能：根据 models 元数据创建全部数据表（幂等，已存在则跳过）。
    依赖：Base.metadata.create_all(engine)。可调参数：无。"""
    from . import models  # noqa: F401  确保模型已注册到元数据

    Base.metadata.create_all(engine)
