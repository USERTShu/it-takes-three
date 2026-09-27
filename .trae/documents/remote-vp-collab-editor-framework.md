# 远程 VP 协作编辑器 — 项目框架搭建方案

## Context（背景与目标）

为 3 名不在同一地点的 ACM 选手开发 Web 服务，用于远程虚拟参赛（VP）。痛点：三人各用一台电脑，线下比赛只有一台电脑、不方便看主机代码，且可能多人同时写代码。因此开发网页版 VSCode（Monaco Editor），三人同步读写同一目录，带光标同步（每人分配颜色 + 名字标签）。

本任务为**框架搭建**：搭建可运行的全流程骨架 —— 邀请码登录 → 创建/加入比赛 → 多人同步编辑 + 光标同步，符合 `.agent_dev.md` 的开发标准（venv 放项目目录、函数注明功能/API/依赖/可调参数、版本化目录名）。

## 已确认技术决策（用户拍板）

- **编辑器**：Monaco Editor（VS Code 编辑器组件）自建协作前端，不用 code-server/Theia
- **前端**：纯 HTML/JS 无构建步骤，静态文件 + 版本化目录（无需 Node）
- **后端**：Python 3.11（dnf 安装，不动系统 python3.6）+ FastAPI + uvicorn + SQLAlchemy + SQLite
- **协作同步**：Yjs CRDT，服务端用 `y_py`（0.6.2，有 cp311 wheel）在 FastAPI WebSocket 内自实现 y-websocket 协议（y-server npm 包已废弃，不可用）

## 环境事实（已验证）

- OS: Alibaba Cloud Linux 3，`dnf install python3.11` 可得 3.11.13（含 python3.11-devel）
- 系统 python3 为 3.6.8，不动它；venv 建在项目目录 `backend/venv`
- 无 Node；pypi.org、registry.npmjs.org、cdn.jsdelivr.net 均网络可达

## 最终目录树

```
/home/it-takes-three/
├── .agent_dev.md
├── .gitignore                     # 追加: backend/venv/ data/ __pycache__/ *.pyc
├── backend/
│   ├── venv/                      # python3.11 venv（放项目目录，符合标准）
│   ├── requirements.txt           # 锁版本
│   └── app/
│       ├── __init__.py
│       ├── main.py                # create_app、挂路由、挂静态目录、lifespan(init_db)
│       ├── config.py              # 可调参数集中管理（env 可覆盖）
│       ├── db.py                  # engine/SessionLocal/Base（SQLite WAL）
│       ├── models.py              # User/InviteCode/Contest/ContestMember/AuthSession
│       ├── schemas.py             # Pydantic 模型
│       ├── security.py            # 邀请码校验、token 签发/校验
│       ├── deps.py                # get_db / get_current_user
│       ├── seed.py                # CLI 预置用户+邀请码（python -m app.seed）
│       ├── yws/                   # y-websocket 协议实现
│       │   ├── codec.py           # lib0 varUint/varString 编解码（纯 Python）
│       │   ├── sync.py            # sync step1/step2/update 编解码
│       │   ├── awareness.py       # AwarenessHub：合并/重编码/广播（纯 Python）
│       │   └── room.py            # ContestRoom：每比赛一个 YDoc + 连接注册表 + 广播
│       └── routers/
│           ├── auth.py            # POST /api/auth/login、GET /api/me
│           ├── contests.py        # 创建/列表/详情/加入/开始(分配颜色)
│           ├── files.py           # 文件树/读/写（操作 YDoc 并广播）
│           └── ws.py              # WS /ws/contest/{slug}（Yjs sync + awareness）
├── frontend/
│   ├── login.html / lobby.html / editor.html
│   ├── css/app.css、css/cursors.css
│   └── js/api.js、auth.js、app-login.js、app-lobby.js、
│       app-editor.js、editor-setup.js、yjs-setup.js、cursors.js
├── vendor/                        # 全部版本化，提交进 git
│   ├── monaco-editor-0.52.2/      # min/vs 子集(4文件)+ monaco.worker.js
│   ├── yjs-13.6.33/、lib0-0.2.118/、y-protocols-1.0.6/、
│   ├── y-websocket-2.0.4/、y-monaco-0.1.6/(打1行补丁 + monaco-shim.js)
└── data/                          # gitignore，SQLite: app.db
```

## 数据库表结构（SQLAlchemy + SQLite WAL）

| 表 | 字段 |
|---|---|
| User | id PK, username UNIQUE, display_name, created_at |
| InviteCode | id PK, code UNIQUE, user_id FK, created_at, used_at NULL |
| Contest | id PK, slug UNIQUE, name, creator_id FK, duration_minutes INT DEFAULT 300, start_time NULL, status TEXT DEFAULT 'created' |
| ContestMember | id PK, contest_id FK, user_id FK, color TEXT NULL（开始时分配）, joined_at, UNIQUE(contest_id, user_id) |
| AuthSession | id PK, token UNIQUE(secrets.token_urlsafe(32)), user_id FK, expires_at（默认 7 天，可调） |

**关键设计**：比赛内代码内容不存 SQLite（Yjs doc 内存是唯一事实源，比赛短生命周期可接受；重启丢内容为已知风险，Phase 2 可追加持久化）。颜色分配：`start_contest` 时 `random.sample(PALETTE, len(members))`，调色板在 config 可调。

## 后端模块职责（函数需注明功能/API/依赖/可调参数）

- **config.py**：`get_settings()` 集中管理 DB_PATH、SESSION_TTL_DAYS=7、PALETTE(8色)、静态目录映射、WS 消息上限 16MB（全部 env 可覆盖）
- **db.py**：`init_db()`（create_all）、`engine`（`check_same_thread=False` + `PRAGMA journal_mode=WAL`）
- **yws/codec.py**：lib0 变长编码 `read_varuint/write_varuint/write_varuint8array/read_varuint8array/write_varstring/read_varstring`，无依赖
- **yws/sync.py**：`encode_sync_step1/step2`、`encode_update_broadcast`、`decode_sync_message`、`doc_diff`（= `Y.encode_state_as_update`）
- **yws/awareness.py**：AwarenessHub（y_py 无 awareness API，纯 Python 实现，编码逐字节对齐 y-protocols）。`apply(update, origin_conn)` 合并重编码、`encode_states`、`remove_client`（断连清理）、`snapshot`（新连接握手下发）
- **yws/room.py**：`ContestRoom`（`doc`=`Y.YDoc`、`connections`、`hub`、`broadcast(msg, exclude=None)`，REST 线程池改动用 `app.state.loop.create_task` 桥接）；`RoomManager.get_or_create(slug)`，key=`contest/{slug}`
- **routers/ws.py**：y-websocket 服务端状态机（见下），token 走 query 参数鉴权 + 校验比赛成员
- **routers/auth.py**：邀请码精确匹配 → 建 AuthSession → 返回 token + user
- **routers/contests.py**：`create_contest`（创建者自动成成员）、`join_contest`（幂等）、`start_contest`（仅创建者，分配颜色+写 start_time）
- **routers/files.py**：`list_files/read_file/create_file/delete_file`，操作 `doc.get_map("files")` 内 Y.Text，事务内改完 `encode_state_as_update` 广播 diff；**主路径是前端直接 CRDT 增删文件**，REST 仅辅助/调试
- **seed.py**：CLI 生成用户+邀请码（如 `ACM-XXXX`）打印到控制台

## y-websocket 协议要点（服务端状态机）

```
外层消息: [type: varUint]（0=sync, 1=awareness, 3=queryAwareness）
sync(type=0): [syncSub: varUint] + payload
  sub0=step1(stateVector) → 回复 [0,1, encode_state_as_update(doc, clientSV)]
  sub1=step2 / sub2=update → Y.apply_update(doc, update) → 广播 [0,2,update]（排除自己）
awareness(type=1): [varUint8Array] → hub 合并 → 广播 [1, merged]（含发送者，同官方）
queryAwareness(type=3): 回复 [1, hub.snapshot()]
握手: 发 [0,0,SV]；若 hub 有状态发 [1,snapshot]；断连 → 删除该连接 clientID → 广播移除
awarenessUpdate = varUint(count) + count×[varUint(clientID), varUint(clock), varString(JSON或"null")]
```

## 前端集成要点

- **editor.html**：importmap（映射 yjs/lib0/y-protocols/y-websocket/y-monaco 到 vendor 版本化路径）+ AMD `require={paths:{vs:'/vendor/monaco-editor-0.52.2/min/vs'}}` + loader.js + editor.main.js（4 个文件均从 jsdelivr 下载，共约 4.1MB，内含 cpp/python/java 高亮）
- **y-monaco 补丁**：源码运行时只用 `monaco.Range/Selection/SelectionDirection` 3 个公开 API，把其第 2 行 import 改为本地 `monaco-shim.js`（从 `globalThis.monaco` 导出这 3 个符号）即可适配 AMD 版
- **Yjs 绑定**：`Y.Doc` + `WebsocketProvider(ws://host/ws, 'contest/'+slug, doc, {params:{token}, awareness})`；文件内容 = `doc.getMap('files')` 的 Y.Text，映射到 Monaco model 用 `MonacoBinding`；文件树用 `filesMap.observe` 刷新
- **光标渲染（自研 cursors.js，满足"颜色=用户色、名字不遮挡代码"）**：awareness 的 selection（相对位置）→ `createAbsolutePositionFromRelativePosition` → 选区高亮 deltaDecorations + 光标 2px 彩色竖条 + `changeViewZones` 名字标签（字号 11px、半透明、贴合光标行；颜色取 `state.user.color`，比赛开始时服务端分配）
- **登录/大厅**：login.html 输邀请码 → 存 token(localStorage) → lobby.html 创建（名称+自定义 slug+时长默认 300 分钟）/加入（显示创建者设定的比赛链接）→ 开始比赛后进入 editor.html?slug=xxx

## 环境搭建命令序列

```bash
sudo dnf install -y python3.11 python3.11-devel          # 不动系统 python3.6
cd /home/it-takes-three && mkdir -p backend
/usr/bin/python3.11 -m venv backend/venv
backend/venv/bin/pip install -U pip
backend/venv/bin/pip install "fastapi>=0.115,<1" "uvicorn[standard]>=0.30,<1" \
    "sqlalchemy>=2.0,<3" "y-py==0.6.2"
# vendored 前端依赖（jsdelivr 4 个 Monaco 文件 + npm tarball 解包 5 个小包）
#   见 agent 调研：monaco-editor@0.52.2 min/vs/{loader.js,editor/editor.main.js,
#   editor/editor.main.css,base/worker/workerMain.js}；lib0@0.2.118、yjs@13.6.33、
#   y-protocols@1.0.6、y-websocket@2.0.4、y-monaco@0.1.6
# 打 y-monaco 补丁 + 写 monaco-shim.js + monaco.worker.js
backend/venv/bin/python -m app.seed --users alice,bob,carol
backend/venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 --app-dir backend
```

## 实施顺序

1. 环境：dnf 装 python3.11 → venv → pip 依赖
2. 下载 vendored 前端依赖（版本化目录 + 补丁）
3. 后端骨架：config/db/models/security/deps/seed（可登录）
4. yws 协议层 + ws 路由
5. contests/files REST
6. 前端：登录页/大厅页/编辑器页 + Yjs 绑定 + 光标渲染
7. 端到端验证

## 端到端验证

1. `seed` 输出 3 个邀请码；浏览器 A 登录 → 创建比赛（slug 如 `icpc-2026`，界面显示分享链接 `editor.html?slug=icpc-2026`）
2. 隐身窗口 B 用另一个邀请码登录 → 打开链接 → 加入比赛
3. A 开始比赛 → 双方看到各自颜色 + 倒计时
4. 双方打开同一文件同时编辑：内容双向实时同步、光标颜色=各自颜色、名字标签跟随不遮挡代码；增删文件双方文件树同步
5. 断线重连：B 断开重连后自动全量同步（step1/step2 握手）

## 风险与备选

- **y-monaco 0.1.6 年久失修**：运行时只用 3 个公开 API（已核对）；备选手写 ~100 行内容 binding（observer ↔ applyEdits + mutex）
- **import map 兼容**：现代浏览器可接受；备选 jsdelivr `+esm` 单文件
- **Monaco worker 路径**：自写 `monaco.worker.js` 固定 baseUrl，核心功能不依赖语言 worker
- **Yjs 仅内存、重启丢内容**：比赛短生命周期可接受；Phase 2 追加 SQLite 持久化
- **jsdelivr 不可用**：备选 unpkg.com 同路径
