# 协作草稿纸（编辑器/草稿纸 可切换页面）

## Context

编辑器功能已齐全，现新增"草稿纸"页面：多人协作画笔批注，实时同步。核心约束：
- 画笔粗细可调、按用户颜色区分（复用现有 awareness `user.color` 配色）；
- 名称显示开启时，**绘制过程中**显示名称框（复用光标旁 `.yRemoteLabel` 样式），**已完成的线条永不显示名称框**；
- 擦除以**线条为单位**（非像素），支持一键清空。

架构结论（已核实）：协作走 y-websocket，服务端 `ContestRoom` 持有唯一 YDoc，sync step2 是全量 state diff——**在客户端 YDoc 上新增 `getMap('annotations')` 即随现有协议同步，后端零改动**。

## 文件改动

### 新增 /home/it-takes-three/frontend/js/scratchpad.js（核心）
导出 `initScratchpad({doc, awareness, getShowNames}) → {setShowNames(v), destroy()}`。
- `annotationsMap = doc.getMap('annotations')`，stroke 结构 `{id, u(绘制者名，仅存储不渲染), c(色), w(线宽), p:[[x,y]…]}`
- id 用 `${doc.clientID}-${seq}`；虚拟坐标系固定 **1200×800**
- 状态机 idle/pen/eraser；`pointerdown` 需 `preventDefault`
- 低频全量重绘：`annotationsMap.observe(() => redraw())`（提交/删除/清空都是低频事件），pointermove 只本地直画当前折线 + awareness 预览，不触发全量重绘；相邻点虚拟距离 <2px 丢弃采样
- 擦除 hit-test：点到折线最小距离（分线段求距离，垂足裁剪 [0,1]），阈值 12 虚拟 px，命中最近一条即 `map.delete(id)`；按住拖动连续擦除（节流）
- 一键清空：`map.clear()`
- 名称框：绘制中若 showNames 开启，在 `.scratchpad-label-layer` 追加 `div.yRemoteLabel`（文本/颜色取自 `awareness.getLocalState().user`，定位笔尖，`translateY(-100%)` 复用 cursors.css），pointerup 移除；**redraw 只画路径不画名字**
- 实时预览：绘制中 `awareness.setLocalStateField('scratch', {c,w,p})`（节流 ~30ms），pointerup 置 null；`awareness.on('change')` 渲染远端 scratch 为半透明线条（跳过 `cid===doc.clientID` 避免本端自叠）
- `destroy()`：移除 map observe / awareness 监听 / 事件与图层

### 新增 /home/it-takes-three/frontend/css/scratchpad.css
`.scratchpad-container`、`.scratchpad-toolbar`（线宽 2/4/8/16、橡皮、清空按钮）、`.scratchpad-canvas-wrap`（`aspect-ratio:1200/800`、`width:100%`、`max-width` 防超高、居中）、`.scratchpad-label-layer`（覆盖层，复用 `.yRemoteLabel`）。

### 改动 /home/it-takes-three/frontend/editor.html
- topbar 加分段控件（`toggle-names` 前）：`<div class="view-toggle"><button data-view="editor" class="active">编辑器</button><button data-view="scratchpad">草稿纸</button></div>`
- `.editor-layout` 之后加 `<section id="scratchpad-container" class="scratchpad-container hidden">`（工具栏 + 画布占位 + label-layer）
- `<link>` 引 scratchpad.css；`<script type="module" src="/js/scratchpad.js?v=13">`（仅注册模块，由 app-editor 动态 import）
- 全部静态资源 `?v=13 → ?v=14`

### 改动 /home/it-takes-three/frontend/js/app-editor.js
- `y = setupYjs(...)` 后动态 `import('./scratchpad.js')`，`initScratchpad({doc:y.doc, awareness:y.awareness, getShowNames:()=>namesVisible})`
- 名称开关 change 处理器追加 `scratchpad.setShowNames(namesVisible)`
- 视图切换：显示草稿纸 → 懒初始化 + 隐藏 `.editor-layout`、显示 `#scratchpad-container`（顺带 `runPanel.hide()`）；切回编辑器 → 反向 + `editor.layout()` + `dispatchEvent(new Event('resize'))`（重算光标标签）
- 草稿纸页面时隐藏 `.run-bar`（运行/调试仅对编辑器有意义）

## 不改动
- backend（sync step2 全量 diff，annotations 天然同步）
- yjs-setup.js（已导出 doc/awareness）
- cursors.js / cursors.css（直接复用 `.yRemoteLabel`）

## 风险与对策
- Monaco automaticLayout + `display:none` 会空白 → 切回时 `editor.layout()`
- 全量重绘仅低频；未来千级线条可改局部重绘（Y.Map event changes）
- 多人同时画/擦同线：CRDT 无冲突，delete 不存在 key 无副作用
- 房间重建/后端重启：annotations 内存态丢失（与 files 一致，可接受）

## 验证（8000 主服务，双浏览器窗口 A/B 同比赛）
1. A 切"草稿纸"，画 2/4/8/16 线宽；A/B 不同账号 → 颜色互异
2. B 实时看到 A 绘制中半透明预览 + 笔尖名称框（名称开关开时）；A 松手后 B 见实线、名称框消失，已完成线条永不再显示名称框
3. B 关名称开关 → A 绘制中 B 不显示名称框；A 本地开关互不串
4. 橡皮：A 点中一条即删、B 同步消失；点空白无效；一键清空全消
5. 同时画不同位置互不冲突；来回切换编辑器/草稿纸数次 Monaco 正常重排
6. 刷新页面已提交线条恢复；窗口缩放画布等比缩放不变形
