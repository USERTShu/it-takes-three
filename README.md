# 远程 VP 协作编辑器

为身处不同地点的 ACM 队伍打造的网页版远程 VP（虚拟参赛）编辑器：邀请码登录 → 创建/加入比赛 → 三人实时读写同一份代码目录。

## 功能特性

- **比赛流程**：创建比赛 → 分享 slug/链接 → 其他成员加入 → 创建者「开始比赛」时随机为每位成员分配调色板颜色。
- **多人实时编辑**：基于 CRDT（Yjs），三人同步读写同一目录下的文件，无冲突合并。
- **文件管理**：侧栏新建/删除文件，多人同时看到文件树变化。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | 纯 HTML/JS（无构建步骤），Monaco Editor 0.52.2（AMD loader）、Yjs 13.6.33（CRDT）、y-websocket 2.0.4、y-monaco 0.1.6、y-protocols 1.0.6、lib0 0.2.118 |
| 后端 | Python 3.11+，FastAPI 0.141.1、uvicorn 0.53.0、SQLAlchemy 2.0.54 + SQLite（WAL）、y-py 0.6.2（服务端 Yjs 文档） |
| 同步协议 | 自实现 Python y-websocket 协议（`backend/app/yws/`），与 y-protocols 逐字节对齐 |

## 目录结构

```
.
├── backend/                # FastAPI 后端（Python venv 位于 backend/venv）
│   ├── app/
│   │   ├── main.py         # 应用装配（API 路由 + /vendor + 前端静态目录）
│   │   ├── config.py       # 所有可调参数集中配置（env 可覆盖）
│   │   ├── db.py           # 引擎/会话/建表（SQLite WAL）
│   │   ├── models.py       # ORM：users / invite_codes / contests / contest_members / auth_sessions
│   │   ├── schemas.py      # Pydantic 请求/响应模型
│   │   ├── security.py     # 会话签发与 token 校验
│   │   ├── deps.py         # get_db / get_current_user 依赖
│   │   ├── seed.py         # CLI 预置用户与邀请码
│   │   ├── state.py        # 全局房间注册表（RoomManager）
│   │   ├── routers/
│   │   │   ├── auth.py     # 登录 / 当前用户
│   │   │   ├── contests.py # 比赛创建/列表/详情/加入/开始
│   │   │   ├── files.py    # 文件列表/读/写/删（REST 辅助路径）
│   │   │   └── ws.py       # Yjs 同步 WebSocket 端点
│   │   └── yws/            # 自实现 y-websocket 服务端
│   │       ├── codec.py    # lib0 变长编码（varUint/varUint8Array/varString）
│   │       ├── sync.py     # Yjs sync step1/step2/update 编解码
│   │       ├── awareness.py# Awareness 状态中枢
│   │       └── room.py     # 每比赛一个 YDoc + 连接注册表 + 广播
│   └── requirements.txt
├── frontend/               # 纯 HTML/JS 前端（无构建步骤）
│   ├── index.html          # 重定向入口 → /login.html
│   ├── login.html          # 邀请码登录
│   ├── lobby.html          # 大厅：创建/加入/我的比赛
│   ├── editor.html         # 编辑器：Monaco + 文件树 + 成员 + 倒计时 + 名称开关
│   ├── css/
│   │   ├── app.css         # 全局样式
│   │   └── cursors.css     # 远端光标装饰 + 名字标签覆盖层样式
│   └── js/
│       ├── auth.js         # token/user 的 localStorage 管理（全局 Auth）
│       ├── api.js          # REST API 封装（全局 API，自动带 Bearer）
│       ├── app-login.js    # 登录页逻辑
│       ├── app-lobby.js    # 大厅页逻辑
│       ├── app-editor.js   # 编辑器页主逻辑（ES 模块入口）
│       ├── editor-setup.js # Monaco AMD 引导 + 创建编辑器
│       ├── yjs-setup.js    # Y.Doc + WebsocketProvider + awareness 建立
│       └── cursors.js      # 远端光标/选区/名字标签渲染
├── vendor/                 # 版本化第三方依赖（目录名标注版本，防版本冲突）
├── data/                   # SQLite 数据库（app.db，WAL 模式）
└── .trae/documents/        # 框架 spec 文档
```

## 快速启动

### 1. 安装依赖

```bash
pip install -r backend/requirements.txt
```

### 2. 预置测试用户与邀请码

```bash
cd backend
python -m app.seed --users alice,bob,carol
```

会打印每个用户名对应的邀请码，例如：

```
alice: ACM-7V4C
bob: ACM-N4U7
carol: ACM-GJK9
```

### 3. 启动服务

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000 --app-dir backend
```

## 核心 API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/login` | 邀请码登录，返回 `{token, user}` |
| GET | `/api/auth/me` | 当前登录用户 |
| POST | `/api/contests` | 创建比赛（name / slug / duration_minutes） |
| GET | `/api/contests` | 我参与的比赛列表 |
| GET | `/api/contests/{slug}` | 比赛详情 |
| POST | `/api/contests/{slug}/join` | 加入比赛（幂等） |
| POST | `/api/contests/{slug}/start` | 开始比赛（仅创建者，分配颜色） |
| GET | `/api/contests/{slug}/files` | 文件列表 |
| GET/POST/DELETE | `/api/contests/{slug}/files/{path}` | 读/写/删文件 |
| WS | `/ws/contest/{slug}?token=` | 实时同步（Yjs sync + awareness） |
