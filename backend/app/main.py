# main.py — FastAPI 应用装配
# 功能：create_app() 组装路由/静态目录/lifespan（init_db），并提供 ASGI 入口 app。
# 依赖：fastapi、config、db、routers
# 可调参数：静态目录见 config（VENDOR_DIR/FRONTEND_DIR）
from contextlib import asynccontextmanager
import mimetypes

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .config import get_settings
from .db import init_db
from .routers import auth, contests, exec as exec_router, files, ws

_settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """功能：应用生命周期——启动时建表（幂等）。
    API: lifespan(FastAPI) → AsyncGenerator
    依赖：init_db。可调参数：无。"""
    init_db()
    yield


def create_app() -> FastAPI:
    """功能：组装并返回 FastAPI 应用（挂载 API 路由 + /vendor + 前端静态目录）。
    API: create_app() → FastAPI
    依赖：auth/contests/files/ws 路由、StaticFiles。可调参数：无。"""
    app = FastAPI(title="Remote VP Editor", lifespan=lifespan)
    app.include_router(auth.router, prefix="/api/auth", tags=["auth"])
    app.include_router(contests.router, prefix="/api/contests", tags=["contests"])
    app.include_router(files.router, prefix="/api/contests", tags=["files"])
    app.include_router(ws.router, tags=["ws"])
    app.include_router(exec_router.router, tags=["exec"])
    # 静态资源挂载须在 API 路由之后，避免吞掉 /api、/ws 路径
    # 注册 .ttf 字体 MIME（否则 uvicorn 以 application/octet-stream 提供，Chrome 拒绝 @font-face）
    mimetypes.add_type("font/ttf", ".ttf")
    app.mount("/vendor", StaticFiles(directory=_settings.VENDOR_DIR), name="vendor")
    app.mount("/", StaticFiles(directory=_settings.FRONTEND_DIR, html=True), name="frontend")
    return app


app = create_app()
