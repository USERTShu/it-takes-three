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


class _StaticNoCache(StaticFiles):
    """功能：静态文件服务并强制每次重新验证（Cache-Control: no-cache）。
    原因：前端 ES module 的 import 子资源（如 ./run-panel.js）不带 ?v= 版本号，
    浏览器会按 HTTP 缓存策略长期缓存旧 JS，导致部署新代码后仍加载到旧文件。
    配合 StaticFiles 的 ETag/Last-Modified，未变化的文件返回 304，开销极小。
    依赖：fastapi.staticfiles。可调参数：无。"""

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await super().__call__(scope, receive, send)
            return

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                headers = [
                    (k, v) for k, v in message.get("headers", [])
                    if k.lower() != b"cache-control"
                ]
                headers.append((b"cache-control", b"no-cache"))
                message = {**message, "headers": headers}
            await send(message)

        await super().__call__(scope, receive, send_wrapper)


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
    app.mount("/vendor", _StaticNoCache(directory=_settings.VENDOR_DIR), name="vendor")
    app.mount("/", _StaticNoCache(directory=_settings.FRONTEND_DIR, html=True), name="frontend")
    return app


app = create_app()
