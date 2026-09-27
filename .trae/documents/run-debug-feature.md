# 运行 + 调试功能（VS Code 风格，g++17 / gdb 断点调试）

## Context

需求：编辑器加入「运行」与「调试」，交互方式完全对标 VS Code——编辑器右上角 ▶ 运行 / 🐞 调试按钮，底部可交互终端面板（运行中输入样例、程序运行中可持续输入），完整 gdb 断点调试（行号旁断点、继续/单步、变量与调用栈视图）。编译器 g++，标准 C++17。

关键现状（决定设计）：
- 文件内容唯一事实源是**后端内存 YDoc**（`RoomManager` 按 `contest/{slug}` 缓存，`room.get_map("files")[path]` 是 Y.Text）。编译无需前端上传源码，后端直接从 YDoc 取最新协作态。
- 已有 WebSocket 鉴权模式可复用（[routers/ws.py](file:///home/it-takes-three/backend/app/routers/ws.py)：token query + 成员校验 + close 码 4001/4003/4004）。
- 环境：`g++ 10.2.1` 已装 ✅（支持 C++17）；**gdb 未装** ❌、venv 无 pygdbmi ❌，需安装。
- OS：Alibaba Cloud Linux 3（yum/dnf）。

## 0. 环境准备（一次性）

1. `dnf install -y gdb`（系统级，需 sudo/root）
2. [requirements.txt](file:///home/it-takes-three/backend/requirements.txt) 追加 `pygdbmi==0.11.0.0`，然后 `backend/venv/bin/pip install -r backend/requirements.txt`
   - pygdbmi = gdb 机器接口（MI）的纯 Python 驱动，处理 `^done/*stopped/~` 等记录解析，避免手写 MI 状态机。
   - 若 pygdbmi 安装失败，退路是手写最小 MI 解析器（同文件内 `gdbmi.py` 实现，约 150 行）。

## 1. 后端

### 1.1 [config.py](file:///home/it-takes-three/backend/app/config.py) 新增可调项
- `RUN_COMPILE_TIMEOUT_SECONDS=20`（编译超时）
- `RUN_TIME_LIMIT_SECONDS=10`（程序运行时限，超时 kill + 标记 TLE）
- `RUN_DIR=data/run`（编译工作目录，按 slug/session 隔离）
- `GDB_BIN=gdb`

### 1.2 新增 `backend/app/exec.py` —— 编译与进程执行
- `compile_program(room, path, flags, out_dir, timeout_s) -> (ok, err, bin_path)`
  - 从 `room.get_map("files").get(path)` 取源码，写入 `out_dir/<path>`（保留扩展名）
  - 子进程 `g++ -std=c++17 <flags> -o a.out <src>`，编译超时由线程定时 kill；失败返回 stderr 全文
  - flags：run 用 `-O2 -Wall`；debug 用 `-g -O0 -fno-omit-frame-pointer`
- `RunProcess`（asyncio）：`loop.create_subprocess_exec` + stdin/stdout/stderr 管道
  - `write_stdin(data)`、`terminate()`、运行时限定时 kill、耗时统计、异步输出回调

### 1.3 新增 `backend/app/yws/gdbmi.py` —— gdb MI 会话封装
- 基于 pygdbmi `GdbController`：
  - `GdbSession(bin_path)`：`gdb --nx -q -i mi3 <bin>`（`--nx` 跳过 .gdbinit，防环境干扰）
  - 命令封装：`break <abs_path>:<line>`、`continue`、`next`、`step`、`finish`、`run`（重启）、`quit`
  - 查询：`stack-list-frames`、`stack-list-variables --simple-values --frame 0`
  - 事件映射：`*stopped`（reason=breakpoint-hit / end-stepping-range / exited-normally / signalled）→ 提取 `frame{fullname, line}`；`~"..."` 输出 → 程序 stdout；`^error` → 错误上报
  - 程序 stdin：debug 会话下 stdin 行经 `controller.write(行)` 交给 gdb 控制台，inferior 等待输入时 gdb 会转发（对齐 VS Code 调试控制台行为）

### 1.4 新增 `backend/app/routers/exec.py` —— 两个 WS 端点（JSON text 帧）
鉴权照抄 [routers/ws.py](file:///home/it-takes-three/backend/app/routers/ws.py) 模式（token query → get_user_by_token → 成员校验 → accept；失败 close 4001/4003/4004）。

- `/ws/contest/{slug}/run?token=`（交互式运行）
  - 客户端→服务端：`{"t":"start","path"}`、`{"t":"stdin","data":"..."}`、`{"t":"kill"}`
  - 服务端→客户端：`{"t":"compile","ok":true}` / `{"t":"compile","ok":false,"error":"..."}`；`{"t":"stdout"|"stderr","data":"..."}`（流式）；`{"t":"exit","code":N,"time_ms":N,"killed":bool}`
- `/ws/contest/{slug}/debug?token=`（gdb 断点调试）
  - 客户端→服务端：`{"t":"start","path"}`、`{"t":"break","line":N}`、`{"t":"breakDel","line":N}`、`{"t":"continue"|"next"|"step"|"finish"|"restart"|"stop"}`、`{"t":"stack"}`、`{"t":"vars"}`、`{"t":"stdin","data":...}`
  - 服务端→客户端：`{"t":"state","state":"running|stopped|exited","reason":"breakpoint-hit|step|exited|signalled","file":..,"line":N,"stack":[...],"vars":[...]}`（自动在 stop 后附带 stack/vars）；`{"t":"breakpoints","list":[{line,enabled}]}`（断点增删后同步）；`{"t":"stdout"|"stderr","data"}`；`{"t":"exit",...}`
- 会话单例按 `(slug, user_id)` 管理（`state.rooms` 旁再加 `exec_sessions` 注册表）：同一用户同时只有一个运行/调试会话，再次 start 先终止旧的（对齐 VS Code 行为）。

### 1.5 [main.py](file:///home/it-takes-three/backend/app/main.py)
`app.include_router(exec.router, tags=["exec"])`（ws 路由 prefix 为空，与现有 ws 路由并列）。

## 2. 前端

### 2.1 [editor-setup.js](file:///home/it-takes-three/frontend/js/editor-setup.js)
`createEditor` 选项加 `glyphMargin: true`（断点红点显示在行号旁的字形边距）。

### 2.2 [editor.html](file:///home/it-takes-three/frontend/editor.html) —— 布局与 UI
- 编辑器区右上角浮动操作条（VS Code 风格，绝对定位在 editor-container 右上）：`▶ 运行`、`🐞 调试`；运行/调试中显示 `■ 停止`。
- `.editor-layout` 改为纵向 flex：上部（sidebar + editor）`flex:1`、下部**面板区**（可拖拽手柄调节高度）：
  - 标签条：`终端`（运行）、`调试控制台`（gdb 输出）、`变量`、`调用堆栈`（后两者 debug 时激活）
  - 终端视图：`<pre id="term-output">`（stdout 白、stderr 红、状态行灰）+ 底部输入行 `<input id="term-input">`（程序运行中可输入，Enter → `{"t":"stdin"}`）
  - 调试视图：工具栏（继续 ▶ / 单步 / 步入 / 步出 / 重启 / 停止）+ 变量树 + 调用堆栈列表
- 新增 `<script type="module">` 引入 runner.js / debugger.js / run-panel.js。

### 2.3 新增 `js/runner.js` —— WS 客户端
- `connect(kind: 'run'|'debug')` 连对应端点；`start(path)`、`sendStdin(text)`、`kill()`、`debugCmd(cmd)`、`toggleBreak(line)`。
- 回调注册：onCompile/onStdout/onStderr/onState/onBreakpoints/onExit/onError；断线自动提示「连接已断开」。

### 2.4 新增 `js/debugger.js` —— 断点与调试态渲染
- 断点：`editor.createDecorationsCollection`，glyph 红点 class `.bp`；监听 `editor.onMouseDown` 且 `target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN` 时切换该行断点 → 发 toggleBreak；收到服务端 `breakpoints` 全量同步（含删除清理）。
- 当前行高亮：独立 `createDecorationsCollection`，class `.dbg-current`；收到 `state`（stopped）移动高亮到 `line`；切文件/会话结束时清空。
- 调试工具栏按钮全部委托到 runner。

### 2.5 新增 `js/run-panel.js` —— 面板逻辑
- 终端输出渲染：append 到 `<pre>`、自动滚底、stderr/状态行上色；退出后状态行显示 `退出码 N · 耗时 Xms` 或 `超时 TLE`。
- 输入行仅程序/会话活跃时可输入；面板标签切换与拖拽调高。
- 复用 app-editor.js 的模块变量 `current` 决定运行/调试的文件。

### 2.6 [app-editor.js](file:///home/it-takes-three/frontend/js/app-editor.js) 集成
- `initEditor()` 后初始化操作条按钮与面板；点运行/调试时校验 `current` 非空。
- 切文件（`openFile`/`closeFile`）时：清空调试高亮与断点装饰（断点列表按需重新同步）。
- 原有名称开关/光标同步逻辑不受影响。

### 2.7 样式
新增 `css/run-panel.css`（或并入 app.css）：`.editor-actions`（浮动操作条）、`.panel/.panel-tabs/.panel-tab.active`、`.term-output`（等宽、overflow auto）、`.term-input`、`.term-line.stderr`、`.dbg-toolbar .dbg-btn`、`.bp`（断点红点）、`.bp-disabled`、`.dbg-current`。

## 3. 实施顺序

1. 环境：`dnf install -y gdb`；requirements + `pip install`
2. 后端：config 项 → exec.py → yws/gdbmi.py → routers/exec.py → main.py 注册
3. 前端：editor.html/css → runner.js → debugger.js → run-panel.js → app-editor.js/editor-setup.js 接线
4. E2E 验证（见下）

## 4. E2E 验证

准备：重启后端（uvicorn 已绑 127.0.0.1:8000，nginx 已配公网 http://8.148.202.88/）。种子账号 alice=ACM-7V4C / bob=ACM-N4U7。

1. **运行**：alice 登录建比赛并开始，新建 `a.cpp` 写 `cin>>n; cout<<n*2`。点 ▶ 运行 → 底部终端出现编译+程序输出；输入行输入 `21` 回车 → 输出 `42`；状态行显示退出码/耗时。
2. **交互输入**：程序含 `while(cin>>x)` 循环时，运行中可多次在输入行回车喂数，实时看到输出。
3. **调试**：建 `b.cpp`（有循环+变量），点 🐞 调试 → 行号旁点红点 → 工具栏 ▶ 继续 → 命中行黄色高亮 → 单步 → 变量/调用堆栈面板出现当前值 → 停止。
4. **断点同步**：多设/删断点，glyph 红点增删正确。
5. **双端**：bob 同比赛另一标签页，确认运行/调试不干扰光标同步与名称开关。
6. **回归**：编译错误文件 → 终端显示 g++ 报错全文；超时程序 → TLE 提示。

## 5. 已知限制（写入 .for_human_dev.md）

- stdin 为**行式交互**（非 raw TTY）：`cin>>` / `getline` / `scanf` 可用；方向键等特殊终端键不支持。
- 断点按 Monaco 行号映射到 gdb 文件行；设断点后再编辑文件上方代码会使行号漂移（MVP 接受，可重设）。
- 服务端直接编译/执行任意代码：仅限受信队友（邀请制 + 成员校验），有编译/运行超时兜底，**无容器隔离**。
- 同用户同时只能有一个运行或调试会话；再次启动自动终止旧的。
- gdb 为部署期安装项；运行/调试依赖 `data/run/` 目录可写。
