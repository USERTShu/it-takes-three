# 编辑器设置面板 + C++ 语义高亮（VSCode 风格）

## Context（背景）

用户反馈两个需求：
1. 增加设置面板，可调节字号等（用户已确认范围：**字号、行高、主题、制表符宽度**，即时生效并持久化）。
2. 现有 C++ 高亮是 Monaco 基础 Monarch 语法，只认关键字/类型/数字/注释，标识符（`freopen`、`std`、`a`、`cout`）全部无颜色。用户已确认采用**语义令牌（semantic tokens）**方案，实现类 VS Code dark+ 的标识符着色。

## 关键技术结论（已在 vendor bundle 核实）

- `monaco.languages.registerDocumentSemanticTokensProvider` 在 0.52.2 min 构建可用。
- **上色机制**：颜色来自 `monaco.editor.defineTheme` 的 `rules`，`token` 名必须与 legend 类型名**完全一致**（如 `{ token:'function', foreground:'dcdcaa' }`）。主题的 `semanticHighlighting:true` 字段在此版本被忽略（硬编码 false）。
- **启用门禁（关键）**：语义着色开关只认配置键 `editor.semanticHighlighting.enabled`。因 `updateOptions` 走 schema 键校验，`editor.updateOptions({'semanticHighlighting.enabled': true})`（**点号键**）可以合法打开。
- **令牌编码**：`monaco.languages` **不导出**编码 helper。provider 直接返回 `{ data: Uint32Array }`，格式为 5 元组相对编码 `[deltaLine, deltaStartChar, length, tokenTypeIndex, modifierBitmask]`：同行相对列、跨行为绝对列，列 0 基 UTF-16；`getLegend()` 返回 `{ tokenTypes: [...], tokenModifiers: [] }`。
- **字号变更后远端标签重算**：cursors.js 只监听 `onDidScrollChange` + window resize；设置应用后 `window.dispatchEvent(new Event('resize'))` 即可触发重排（automaticLayout 同时重排）。

## 文件改动

### 新增 `/home/it-takes-three/frontend/js/settings.js`
- `DEFAULTS = { fontSize: 14, lineHeight: 20, tabSize: 4, theme: 'dark' }`
- `loadSettings()`：读 `localStorage.vp_settings`（JSON），merge + 数值消毒（fontSize 10–28、lineHeight 14–36、tabSize 2/4/8、theme 'dark'|'light'）
- `saveSettings(s)`：写回 localStorage
- `initSettingsPanel(editor, applyFn)`：⚙ 点击开合 `#settings-pop`、外部点击/Esc 关闭、四个控件 `change` 事件 → 组装 settings → `applyFn(s)` + `saveSettings(s)`

### 新增 `/home/it-takes-three/frontend/js/cpp-semantic.js`
- `TOKEN_TYPES = ['namespace','type','function','variable','member','macro']`
- `defineSemanticThemes(monaco)`：
  - `vp-dark`（base 'vs-dark', inherit）rules：function #dcdcaa、variable #9cdcfe、type #4ec9b0、namespace #4ec9b0、macro #c586c0、member #9cdcfe
  - `vp-light`（base 'vs'）rules：function #795E26、type/namespace #267f99、variable/member #001188、macro #AF00DB
- `registerCppSemanticProvider(monaco)`：`registerDocumentSemanticTokensProvider('cpp', { getLegend, provideDocumentSemanticTokens })`。返回 `{ data: Uint32Array }`（可带 `resultId`）。
- `enableSemantic(editor)`：`editor.updateOptions({ 'semanticHighlighting.enabled': true })`
- `analyzeCpp(text)`：逐字符扫描 + 状态机（跳过 `/* */`、`//`、`"…"`、`'…'`），对每个标识符 `[A-Za-z_]\w*` 判定类型：
  - 后接 `::` → **namespace**（`std`）
  - 后接 `(` 且非控制关键字（if/for/while/switch/catch/return/sizeof 等）→ **function**（`freopen`）
  - `class/struct/enum X`、`using X=…`、`typedef … X;` 登记 X 到类型集合；原始类型（int/char/…/size_t）+ 声明上下文（`int a=…`、`for(int i`、`,` 连续声明）→ 下一标识符为 **variable**（`a`）；类型上下文（`std::vector<int> a`、`>` 后、`T x;`）→ 下一标识符 variable
  - 后接 `.`/`->` 或 `::` 后 → **member**（`cout`、`p->next`）
  - 全大写+下划线 → **macro**（`MAXN`、`INF`）
  - 兜底标识符 → **variable**
  - 避免与 Monarch 已覆盖的 token（关键字/字符串/注释）重叠（重叠时语义优先，编辑器会忽略重复）
- `encodeTokens(tokens) → Uint32Array`：5 元组相对编码

### 编辑 `/home/it-takes-three/frontend/editor.html`
- `.run-bar` 前加 `<button id="btn-settings" title="设置">⚙</button>`
- 新增 `#settings-pop` 弹层（`hidden` 默认）：四行控件——字号 `<select>`（12/13/14/16/18/20/24）、行高 `<select>`（16/18/20/22/24/28/32）、主题 `<select>`（深色/浅色）、制表符宽度 `<select>`（2/4/8）
- 静态引用版本 `?v=4 → ?v=5`；新增 `<script type="module" src="/js/settings.js?v=5">`（或由 app-editor.js import）

### 编辑 `/home/it-takes-three/frontend/css/app.css`
- `.settings-pop`：绝对定位 topbar 右下、`position:absolute; right:16px; top:52px`，复用 `.card`/`.btn` 风格；`.settings-row` 行布局（label + 控件）

### 编辑 `/home/it-takes-three/frontend/js/app-editor.js`
- `initEditor()` 中 `editor = await createEditor(...)` 之后：
  1. `await defineSemanticThemes(monaco)`
  2. `registerCppSemanticProvider(monaco)`
  3. `enableSemantic(editor)`
  4. `const s = loadSettings(); applySettings(editor, s)`
  5. `initSettingsPanel(editor, applySettings)`
- `applySettings(editor, s)`：`editor.updateOptions({ fontSize: s.fontSize, lineHeight: s.lineHeight, tabSize: s.tabSize, theme: s.theme==='dark' ? 'vp-dark' : 'vp-light' })` + `window.dispatchEvent(new Event('resize'))`
- 在 `openFile`/`maybeOpenFirst` 之前完成注册（语义令牌对已打开模型即时生效，无需重建 model）

### 不动
- `editor-setup.js`（默认值兜底，实际值由 updateOptions 覆盖）
- `cursors.js`、后端

## 风险与回退

- 0.52.2 专属的「点号键开语义着色」若未来失效：回退用 `editor._configurationService.updateValues([['editor.semanticHighlighting.enabled', true]])`（pinned vendor 可用），或 AMD define 拦截补丁 `semanticTokensConfig.isSemanticColoringEnabled`。
- 分析器是全量重分析，竞赛文件规模无性能压力；若大文件卡顿可按 `model.getVersionId()` 缓存。
- 语义与 Monarch 重叠处语义优先——分析器只发标识符类 token，避免与关键字重叠。

## 验证（端到端）

1. 打开编辑器页，⚙ 弹层开关正常；调节字号/行高/主题/制表符即时生效，刷新后保持（localStorage `vp_settings`）。
2. 编辑代码 `freopen("in.txt","r",stdin); std::vector<int> a; std::cout<<a[0]<<std::endl;` 与 `#define MAXN 100`：确认 `freopen` 黄 #dcdcaa、`std`/`vector` 青 #4ec9b0、`a` 蓝 #9cdcfe、`cout` 蓝（member）、`MAXN` 紫 #c586c0，与 VS Code dark+ 一致；切浅色主题语义色跟随。
3. 双窗口验证：改字号后远端用户名标签不漂移。
4. 回归：折叠箭头、Ctrl+J 终端开关、F5 调试、名称开关均正常。
5. Console 无报错；`monaco.languages` 已注册 cpp 语义 provider。
