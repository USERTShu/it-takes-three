// app-editor.js — 编辑器页主逻辑（ES 模块入口）
// 功能：鉴权 → 加入/读取比赛 → 未开始则等待（创建者可就地开始）→
//       加载 Monaco + Yjs 连接 → 文件树/成员面板/倒计时 → 文件 CRUD（CRDT 广播）→ 光标同步。
//       队长权限：只有队长（contest.creator_id）能编辑代码/增删文件，其他成员只读；队长可交接身份。
// 依赖：auth.js、api.js（全局）、editor-setup.js、yjs-setup.js、cursors.js、y-monaco。
// 可调参数：无。
import { createEditor } from './editor-setup.js'
import { setupYjs, setupScratchYjs, createFile, deleteFile, renameFile } from './yjs-setup.js'
import { showContextMenu, inlineRename } from './context-menu.js'
import { setupRemoteCursors } from './cursors.js'
import { RunSession } from './runner.js'
import { DebugSession, BreakpointManager } from './debugger.js'
import { RunPanel } from './run-panel.js'
import { loadSettings, initSettingsPanel } from './settings.js'
import { defineSemanticThemes, registerCppSemanticProvider, enableSemantic } from './cpp-semantic.js'
// y-monaco 改为动态 import：其 monaco-shim 在模块顶层访问 globalThis.monaco，
// 而 Monaco 经 AMD 异步加载，静态 import 会在此刻拿到 undefined。

let MonacoBinding = null

const params = new URLSearchParams(location.search)
const slug = params.get('slug')
const me = Auth.getUser()
// 页面加载时即捕获 token：多标签页共享 localStorage，其他标签登录会覆盖它；
// 本页在加载后应始终用当时捕获的会话，避免连接身份被串改。
const myToken = Auth.getToken()
API.pinToken(myToken) // REST 请求同样固定用本页会话

const timerEl = document.getElementById('timer')
const memberListEl = document.getElementById('member-list')
const fileListEl = document.getElementById('file-list')
const newFileInput = document.getElementById('new-file-name')
const waitingOverlay = document.getElementById('waiting-overlay')
const startHereBtn = document.getElementById('btn-start-here')
const waitingErr = document.getElementById('waiting-error')

// ---- 工具 ----
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

const LANGS = {
  '.c': 'cpp', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.h': 'cpp', '.hpp': 'cpp',
  '.py': 'python', '.java': 'java', '.js': 'javascript', '.ts': 'typescript',
  '.json': 'json', '.md': 'markdown', '.txt': 'plaintext',
}
function detectLanguage(path) {
  for (const [ext, lang] of Object.entries(LANGS)) {
    if (path.endsWith(ext)) return lang
  }
  return 'plaintext'
}

// ---- 状态 ----
let contest = null
let myColor = null
let pollTimer = null
let editor = null
let y = null
let scratchY = null // 草稿纸独立连接（所有成员可写）
let current = null
let currentCursors = null // 当前文件的光标渲染器（供名称开关实时控制）
let namesVisible = true // 远端用户名标签显示开关（localStorage 持久化）
const bindings = new Map() // path → {model, binding, cursors}

// ---- 运行/调试状态 ----
let runPanel = null // 底部面板
let scratchpad = null // 草稿纸（协作画布，编辑器/草稿纸 视图切换）
let breakpointMgr = null // 断点/当前行装饰
let runSession = null // 运行会话客户端
let debugSession = null // 调试会话客户端
let activeKind = null // 'run' | 'debug' | null
let saveHintTimer = null // Ctrl+S “已保存”提示计时器
let lastWatchExprs = null // 上次已下发的监控表达式（脏检查：暂停时未变化则不重发，避免单步时反复触发 gdb 求值）

function arraysEqual(a, b) {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// ---- 比赛加载 ----
async function loadContest() {
  contest = await API.getContest(slug)
  // 经分享链接进入但尚未加入：自动加入（支持比赛开始后中途加入，后端会分配颜色）
  if (!(contest.members || []).some((x) => x.user_id === me.id)) {
    contest = await API.joinContest(slug)
  }
  if (contest.status !== 'started') return false
  const m = (contest.members || []).find((x) => x.user_id === me.id)
  myColor = m ? m.color : null
  return true
}

// ---- 等待/致命错误 ----
function showWaiting() {
  waitingOverlay.classList.remove('hidden')
}
function hideWaiting() {
  waitingOverlay.classList.add('hidden')
}
function fatal(msg) {
  waitingErr.textContent = msg
  waitingErr.classList.remove('hidden')
  waitingOverlay.classList.remove('hidden')
  startHereBtn.classList.add('hidden')
}

// ---- 编辑器初始化 ----
async function initEditor() {
  document.getElementById('contest-name').textContent = contest.name
  if (!myColor) {
    fatal('你还没有被分配颜色，请让创建者重新开始比赛')
    return
  }
  editor = await createEditor(document.getElementById('editor-container'))
  // 语义令牌高亮（VSCode 风格：函数/变量/类型/命名空间/宏/成员着色）
  const monaco = window.monaco
  await defineSemanticThemes(monaco)
  registerCppSemanticProvider(monaco)
  enableSemantic(editor)
  // 编辑器设置（字号/行高/主题/制表符，localStorage 持久化）
  applySettings(editor, loadSettings())
  initSettingsPanel(editor, applySettings)
  runPanel = new RunPanel()
  breakpointMgr = new BreakpointManager(editor, (line, enabled) => {
    // 调试会话进行中即时下发断点增删
    if (debugSession) {
      if (enabled) debugSession.break(line)
      else debugSession.breakDel(line)
    }
  })
  window.__dbg = breakpointMgr // 调试
  initRunDebug()
  const mod = await import('y-monaco')
  MonacoBinding = mod.MonacoBinding
  const localUser = {
    id: me.id,
    display_name: me.display_name,
    username: me.username,
    color: myColor,
  }
  y = setupYjs(slug, myToken, localUser)
  window.__vp = y // 调试

  // ---- 草稿纸（编辑器/草稿纸 视图切换）----
  // 草稿纸使用独立 Y.Doc（/ws/scratch/{slug}）：代码房间只有队长可写，草稿纸所有成员都可写。
  scratchY = setupScratchYjs(slug, myToken, localUser)
  window.__scratch = scratchY // 调试
  const scratchpadMod = await import('./scratchpad.js')
  scratchpad = scratchpadMod.initScratchpad({
    doc: scratchY.doc,
    awareness: scratchY.awareness,
    provider: scratchY.provider,
    getShowNames: () => namesVisible,
  })
  // 视图切换：显示草稿纸 → 隐藏编辑器区（顺带收起运行面板与运行/调试按钮）；
  // 切回编辑器 → 重新布局 Monaco + 重算光标标签坐标。
  const viewButtons = document.querySelectorAll('.view-toggle button')
  const editorLayoutEl = document.querySelector('.editor-layout')
  const scratchpadEl = document.getElementById('scratchpad-container')
  const runBarEl = document.querySelector('.run-bar')
  function switchView(view) {
    const isScratch = view === 'scratchpad'
    viewButtons.forEach((b) => b.classList.toggle('active', b.dataset.view === view))
    editorLayoutEl.classList.toggle('hidden', isScratch)
    scratchpadEl.classList.toggle('hidden', !isScratch)
    runBarEl.classList.toggle('hidden', isScratch)
    if (isScratch) {
      if (runPanel) runPanel.hide()
    } else if (editor) {
      editor.layout() // display:none 期间 Monaco 未重新布局，切回时强制重排
      window.dispatchEvent(new Event('resize'))
    }
  }
  viewButtons.forEach((b) => {
    b.addEventListener('click', () => switchView(b.dataset.view))
  })

  const badge = document.getElementById('conn-badge')
  y.provider.on('status', ({ status }) => {
    badge.textContent = status === 'connected' ? '已连接' : status === 'disconnected' ? '已断开' : '连接中…'
    badge.className = 'conn-badge ' + (status || 'connecting')
  })
  y.provider.on('synced', () => maybeOpenFirst())

  // 远端用户名标签开关（localStorage 持久化，默认开；草稿纸名称框与之一致）
  const toggleNames = document.getElementById('toggle-names')
  const saved = localStorage.getItem('vp_show_names')
  namesVisible = saved === null ? true : saved === '1'
  toggleNames.checked = namesVisible
  toggleNames.addEventListener('change', () => {
    namesVisible = toggleNames.checked
    localStorage.setItem('vp_show_names', namesVisible ? '1' : '0')
    if (currentCursors) currentCursors.setShowNames(namesVisible)
    if (scratchpad) scratchpad.setShowNames(namesVisible)
  })
  if (scratchpad) scratchpad.setShowNames(namesVisible)

  renderMembers()
  applyPermission()
  initHandover()
  // 在线状态来自代码房间 awareness（user.id），成员上下线时刷新成员面板；
  // 队长切换文件（awareness.file）时队员跟随
  y.awareness.on('change', () => {
    renderMembers()
    followCaptain()
  })
  startMembersPoll()
  startTimer()
  renderFileTree()
  maybeOpenFirst()

  y.filesMap.observe(() => {
    renderFileTree()
    followCaptain() // 队长新建并打开的文件可能刚同步到
    maybeOpenFirst()
    // 当前文件被远端删除时关闭
    if (current && !y.filesMap.has(current)) closeFile()
  })

  document.getElementById('btn-add-file').addEventListener('click', () => {
    if (!isCaptain()) return
    const name = newFileInput.value.trim() || 'main.cpp'
    const err = checkFileName(name)
    if (err) {
      alert(err)
      return
    }
    if (createFile(y.filesMap, name)) {
      newFileInput.value = ''
      openFile(name)
    } else {
      alert(`文件 ${name} 已存在`)
    }
  })

  window.addEventListener('beforeunload', () => {
    if (runSession) runSession.close()
    if (debugSession) debugSession.close()
    if (y) y.provider.destroy()
    if (scratchY) scratchY.provider.destroy()
  })
}

// ---- 编辑器设置应用 ----
function applySettings(ed, s) {
  ed.updateOptions({
    fontSize: s.fontSize,
    lineHeight: s.lineHeight,
    tabSize: s.tabSize,
    theme: s.theme === 'light' ? 'vp-light' : 'vp-dark',
  })
  // 字号/行高变化后重算远端光标标签坐标（cursors.js 监听 window resize）
  window.dispatchEvent(new Event('resize'))
}

// ---- 成员面板 / 队长权限 / 倒计时 ----
function isCaptain() {
  return !!contest && contest.creator_id === me.id
}

function memberName(m) {
  return m.display_name || m.username || `#${m.user_id}`
}

// 当前在线成员 user_id 集合（代码房间 awareness 中的 user.id，含自己）
function onlineUserIds() {
  const ids = new Set([me.id])
  if (y) {
    y.awareness.getStates().forEach((state) => {
      if (state.user && state.user.id != null) ids.add(state.user.id)
    })
  }
  return ids
}

function renderMembers() {
  const online = onlineUserIds()
  memberListEl.innerHTML = (contest.members || []).map((m) => {
    const color = m.color || '#888'
    const isOnline = online.has(m.user_id)
    const badge = m.user_id === contest.creator_id ? '<span class="captain-badge">队长</span>' : ''
    return `<div class="member${isOnline ? '' : ' offline'}" title="${isOnline ? '在线' : '离线'}"><span class="dot" style="background:${color}"></span><span>${esc(memberName(m))}</span>${badge}</div>`
  }).join('')
}

// 按队长身份切换只读：编辑器 readOnly、隐藏新建/删除文件、显示交接按钮
function applyPermission() {
  const cap = isCaptain()
  if (editor) {
    editor.updateOptions({ readOnly: !cap, readOnlyMessage: { value: '只有队长可以编辑代码' } })
  }
  document.querySelector('.file-actions').classList.toggle('hidden', !cap)
  document.getElementById('readonly-hint').classList.toggle('hidden', cap)
  document.getElementById('btn-handover').classList.toggle('hidden', !cap)
  fileListEl.classList.toggle('follow', !cap)
  if (!cap) document.getElementById('handover-menu').classList.add('hidden')
  // 队长广播自己正在看的文件；队员改为跟随队长
  if (y) y.awareness.setLocalStateField('file', cap ? current : null)
  renderFileTree()
  followCaptain()
}

// 队长当前打开的文件（来自队长 awareness 的 file 字段；队长离线/未打开文件时为 null）
function captainFile() {
  if (!y || !contest) return null
  let file = null
  y.awareness.getStates().forEach((state) => {
    if (!file && state.user && state.user.id === contest.creator_id && state.file) file = state.file
  })
  return file
}

// 打开的代码文件统一：队员只能看到队长正在看的文件
function followCaptain() {
  if (isCaptain()) return
  // 调试中暂不跟随（断点/当前行绑定在当前文件，切走会中断调试），调试结束后再跟上
  if (activeKind === 'debug') return
  const file = captainFile()
  if (file && file !== current && y.filesMap.has(file)) openFile(file)
}

// 刷新比赛信息：队长变化时立即切换权限
async function refreshContest() {
  const prevCaptain = contest.creator_id
  contest = await API.getContest(slug)
  renderMembers()
  if (contest.creator_id !== prevCaptain) applyPermission()
}

// 定时刷新成员列表：有人中途加入/队长交接时其他成员能看到（成员信息只在 REST 中，Yjs 不承载）
function startMembersPoll() {
  setInterval(async () => {
    try {
      await refreshContest()
    } catch (e) { /* 网络抖动，下次再试 */ }
  }, 3000)
}

// 交接队长：按钮弹出成员菜单（不含自己），确认后调用接口
function initHandover() {
  const btn = document.getElementById('btn-handover')
  const menu = document.getElementById('handover-menu')
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    if (!menu.classList.contains('hidden')) {
      menu.classList.add('hidden')
      return
    }
    const online = onlineUserIds()
    const others = (contest.members || []).filter((m) => m.user_id !== me.id)
    menu.innerHTML = '<div class="menu-title">选择新的队长</div>' + (others.length
      ? others.map((m) => `<div class="menu-item" data-uid="${m.user_id}"><span class="dot" style="background:${m.color || '#888'}"></span><span>${esc(memberName(m))}</span>${online.has(m.user_id) ? '' : '<span class="readonly-hint">离线</span>'}</div>`).join('')
      : '<div class="menu-empty">比赛里还没有其他成员</div>')
    menu.classList.remove('hidden')
  })
  menu.addEventListener('click', async (e) => {
    const item = e.target.closest('.menu-item')
    if (!item) return
    e.stopPropagation()
    const uid = Number(item.dataset.uid)
    const target = (contest.members || []).find((m) => m.user_id === uid)
    menu.classList.add('hidden')
    if (!target || !window.confirm(`把队长交接给 ${memberName(target)}？交接后你将只能查看代码。`)) return
    try {
      contest = await API.transferCaptain(slug, uid)
      renderMembers()
      applyPermission()
    } catch (err) {
      alert(err.message || '交接失败')
    }
  })
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target)) menu.classList.add('hidden')
  })
}

function startTimer() {
  // SQLite 返回的 start_time 丢失时区（实际为 UTC），补 'Z' 按 UTC 解析
  const end = new Date((contest.start_time || '').replace(/ /, 'T') + 'Z').getTime() + contest.duration_minutes * 60000
  const tick = () => {
    const remain = Math.max(0, end - Date.now())
    if (remain <= 0) {
      timerEl.textContent = '已结束'
      return
    }
    const h = Math.floor(remain / 3600000)
    const m = Math.floor((remain % 3600000) / 60000)
    const s = Math.floor((remain % 60000) / 1000)
    const p = (n) => String(n).padStart(2, '0')
    timerEl.textContent = `${p(h)}:${p(m)}:${p(s)}`
  }
  tick()
  setInterval(tick, 1000)
}

// ---- 文件树 / 编辑绑定 ----
function renderFileTree() {
  if (!y) return
  fileListEl.innerHTML = ''
  const paths = Array.from(y.filesMap.keys()).sort()
  if (paths.length === 0) {
    fileListEl.innerHTML = isCaptain()
      ? '<div class="empty">（空目录，下方新建一个文件）</div>'
      : '<div class="empty">（空目录，等待队长新建文件）</div>'
    return
  }
  paths.forEach((path) => {
    const item = document.createElement('div')
    item.className = 'file-item' + (path === current ? ' active' : '')
    const nameSpan = document.createElement('span')
    nameSpan.textContent = path
    const del = document.createElement('span')
    del.className = 'file-del'
    del.textContent = '✕'
    del.title = '删除文件'
    del.addEventListener('click', (e) => {
      e.stopPropagation()
      if (window.confirm(`删除 ${path}？`)) {
        deleteFile(y.filesMap, path)
      }
    })
    item.appendChild(nameSpan)
    if (isCaptain()) item.appendChild(del) // 只有队长能删除文件
    // 队员的文件跟随队长切换，不能自行打开其他文件
    item.addEventListener('click', () => { if (isCaptain()) openFile(path) })
    // 右键菜单：重命名 / 删除（仅队长）
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      if (!isCaptain()) return
      showContextMenu(e.clientX, e.clientY, [
        { label: '重命名', onClick: () => inlineRename(nameSpan, path, (to) => doRenameFile(path, to)) },
        { label: '删除', danger: true, onClick: () => { if (window.confirm(`删除 ${path}？`)) deleteFile(y.filesMap, path) } },
      ])
    })
    fileListEl.appendChild(item)
  })
}

// 文件名校验（与后端 exec.sanitize_path 规则一致：字母数字下划线点横线，可含子目录，禁止 ..）
const FILE_NAME_RE = /^[\p{L}\p{N}_.-]+(?:\/[\p{L}\p{N}_.-]+)*$/u
function checkFileName(name) {
  if (!FILE_NAME_RE.test(name) || name.split('/').includes('..')) {
    return '文件名只能包含字母、数字、下划线、点和横线（可用 / 表示子目录）'
  }
  return null
}

// 重命名文件；返回字符串表示失败原因（inlineRename 会提示并保持编辑）
function doRenameFile(from, to) {
  const err = checkFileName(to)
  if (err) return err
  if (y.filesMap.has(to)) return `文件 ${to} 已存在`
  const wasCurrent = current === from
  if (!renameFile(y.filesMap, from, to)) return '重命名失败'
  if (wasCurrent) openFile(to) // 队员通过 awareness.file 跟随到新文件名
}

function maybeOpenFirst() {
  if (current || !y || y.filesMap.size === 0) return
  if (!isCaptain() && captainFile()) return // 队员优先跟随队长（followCaptain 负责打开）
  const paths = Array.from(y.filesMap.keys()).sort()
  // 优先打开 main.*（避免默认打开字母序第一个文件如 bad.cpp，点运行直接编译失败）
  const first = paths.find((p) => /(^|\/)(main|a)\.(cpp|c|cc|cxx)$/i.test(p)) || paths[0]
  if (first) openFile(first)
}

function openFile(path) {
  if (current === path) return
  closeFile()
  const ytext = y.filesMap.get(path)
  if (!ytext) return
  const monaco = window.monaco
  const model = monaco.editor.createModel('', detectLanguage(path), monaco.Uri.parse(`inmemory://${path}`))
  const binding = new MonacoBinding(ytext, model, new Set([editor]), y.awareness)
  editor.setModel(model)
  const cursors = setupRemoteCursors(editor, ytext, y.doc, y.awareness)
  currentCursors = cursors
  cursors.setShowNames(namesVisible)
  bindings.set(path, { model, binding, cursors })
  current = path
  if (isCaptain()) y.awareness.setLocalStateField('file', path) // 队员据此跟随
  renderFileTree()
  updateRunButtons()
}

function closeFile() {
  if (!current) return
  const entry = bindings.get(current)
  bindings.delete(current)
  currentCursors = null
  if (entry) {
    try { entry.cursors.destroy() } catch (e) { /* 忽略 */ }
    try { entry.binding.destroy() } catch (e) { /* 忽略 */ }
    try { entry.model.dispose() } catch (e) { /* 忽略 */ }
  }
  current = null
  if (isCaptain() && y) y.awareness.setLocalStateField('file', null)
  // 关闭文件：清空断点与当前行高亮；调试依赖当前文件，随之停止。
  // 运行不受影响（程序已编译在跑，输出在终端），切换文件不打断别人的运行
  if (breakpointMgr) {
    breakpointMgr.clear()
    breakpointMgr.clearCurrentLine()
  }
  if (activeKind === 'debug') stopSession()
  updateRunButtons()
}

// ---- 运行 / 调试（VS Code 风格） ----
// 协议表见 .for_human_dev.md「5. 运行/调试协议」。

function initRunDebug() {
  const btnRun = document.getElementById('btn-run')
  const btnDebug = document.getElementById('btn-debug')
  const btnStop = document.getElementById('btn-stop')
  const dbgBar = document.getElementById('debug-toolbar')

  btnRun.addEventListener('click', () => {
    if (!current) return
    if (activeKind) stopSession()
    startRun()
  })
  btnDebug.addEventListener('click', () => {
    if (!current) return
    if (activeKind) stopSession()
    startDebug()
  })
  btnStop.addEventListener('click', stopSession)

  dbgBar.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      const cmd = b.dataset.dbg
      if (cmd === 'stop' || !debugSession) { stopSession(); return }
      debugSession.cmd(cmd)
    })
  })

  // VS Code 快捷键：F5 调试 / Ctrl+F5 运行 / F10 单步跳过 / F11 单步进入 / Shift+F5 停止 /
  // Ctrl+` 切换终端（主用；VS Code 风格） / Ctrl+J 切换终端（兼容；部分浏览器会把它保留为下载页快捷键）/
  // Ctrl+S 拦截浏览器“保存网页”对话框（编辑为实时同步，仅提示，无需手动保存）。
  // 用捕获阶段（capture）监听：先于 Monaco/编辑器内部按键处理执行，避免快捷键被吞掉。
  window.addEventListener('keydown', (e) => {
    const key = (e.key || '').toLowerCase()
    if (e.key === 'F5') {
      if (e.shiftKey) { e.preventDefault(); stopSession(); return }
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); btnRun.click(); return }
      e.preventDefault(); btnDebug.click()
    } else if ((e.ctrlKey || e.metaKey) && (key === '`' || key === 'j')) {
      e.preventDefault()
      runPanel.toggle()
    } else if ((e.ctrlKey || e.metaKey) && key === 's') {
      e.preventDefault()
      showSaveHint()
    } else if (e.key === 'F10' && activeKind === 'debug' && debugSession) {
      e.preventDefault(); debugSession.cmd('next')
    } else if (e.key === 'F11' && activeKind === 'debug' && debugSession) {
      e.preventDefault(); debugSession.cmd('step')
    }
  }, true)

  // 输入行回调：按当前会话类型转发 stdin
  runPanel.onInput = (data) => {
    if (activeKind === 'debug' && debugSession) debugSession.sendStdin(data)
    else if (activeKind === 'run' && runSession) runSession.sendStdin(data)
  }
  // EOF：仅运行模式（调试时 stdin 经 gdb 转发，无法单独关闭）
  runPanel.onEof = () => {
    if (activeKind === 'run' && runSession) {
      runSession.eof()
      runPanel.termPrint('[已发送 EOF]\n', 'muted')
    }
  }

  initRunBarDrag()
  updateRunButtons()
}

// ---- 调试工具栏拖动（VS Code 调试工具条风格：按住空白处拖动，位置持久化） ----
function initRunBarDrag() {
  const bar = document.getElementById('debug-toolbar')
  const container = document.getElementById('editor-container')
  // 恢复上次拖动位置
  try {
    const saved = JSON.parse(localStorage.getItem('vp_dbgbar_pos') || 'null')
    if (saved && typeof saved.left === 'string') {
      bar.style.left = saved.left
      bar.style.top = saved.top
      bar.style.right = 'auto'
      bar.style.transform = 'none'
    }
  } catch (e) { /* 忽略 */ }

  let dragging = false
  let moved = false
  let startX = 0, startY = 0, origLeft = 0, origTop = 0

  bar.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return // 按钮点击不拖动
    dragging = true
    moved = false
    startX = e.clientX
    startY = e.clientY
    const cRect = container.getBoundingClientRect()
    const bRect = bar.getBoundingClientRect()
    origLeft = bRect.left - cRect.left
    origTop = bRect.top - cRect.top
    e.preventDefault()
  })
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return
    const dx = e.clientX - startX
    const dy = e.clientY - startY
    if (Math.abs(dx) + Math.abs(dy) > 4) moved = true
    const cRect = container.getBoundingClientRect()
    const maxX = Math.max(0, cRect.width - bar.offsetWidth)
    const maxY = Math.max(0, cRect.height - bar.offsetHeight)
    bar.style.left = Math.min(Math.max(0, origLeft + dx), maxX) + 'px'
    bar.style.top = Math.min(Math.max(0, origTop + dy), maxY) + 'px'
    bar.style.right = 'auto'
    bar.style.transform = 'none'
    bar.classList.add('dragging')
  })
  window.addEventListener('mouseup', () => {
    if (!dragging) return
    dragging = false
    bar.classList.remove('dragging')
    if (moved) {
      try {
        localStorage.setItem('vp_dbgbar_pos', JSON.stringify({ left: bar.style.left, top: bar.style.top }))
      } catch (e) { /* 忽略 */ }
    }
  })
}

// ---- 顶部栏“已保存”提示（Ctrl+S 反馈；编辑实时同步，无需手动保存） ----
function showSaveHint() {
  const el = document.getElementById('save-hint')
  if (!el) return
  el.textContent = '已保存（实时同步）'
  el.classList.remove('hidden')
  clearTimeout(saveHintTimer)
  saveHintTimer = setTimeout(() => el.classList.add('hidden'), 1600)
}

function updateRunButtons() {
  const hasFile = !!current
  document.getElementById('btn-run').disabled = !hasFile
  document.getElementById('btn-debug').disabled = !hasFile
  document.getElementById('btn-stop').classList.toggle('hidden', !activeKind)
  document.getElementById('debug-toolbar').classList.toggle('hidden', activeKind !== 'debug')
}

function startRun() {
  const path = current
  activeKind = 'run'
  updateRunButtons()
  runPanel.show('terminal')
  runPanel.clearTerm()
  runPanel.setInputEnabled(true)
  runSession = new RunSession(slug, myToken, {
    onCompile: (ok, error) => {
      if (ok) runPanel.termPrint('[编译成功，开始运行]\n', 'info')
      else runPanel.termPrint('[编译失败]\n' + (error || ''), 'err')
    },
    onStdout: (data) => runPanel.termPrint(data, ''),
    onStderr: (data) => runPanel.termPrint(data, 'err'),
    onExit: (info) => {
      runPanel.termPrint(
        info.killed
          ? `[已超出时间限制，程序被终止（耗时 ${info.time_ms} ms）]\n`
          : `[进程已退出，退出码 ${info.code}，耗时 ${info.time_ms} ms]\n`,
        'muted')
      runSession.close() // 关闭连接，避免每次运行都残留一个 WebSocket
      runSession = null
      endSession()
    },
    onError: () => { runPanel.termPrint('[运行连接出错]\n', 'err'); endSession() },
    onClose: () => endSession(),
  })
  runSession.connect()
  runSession.start(path)
}

function startDebug() {
  const path = current
  activeKind = 'debug'
  lastWatchExprs = null // 新会话：清空脏检查状态
  updateRunButtons()
  runPanel.show('console')
  runPanel.clearConsole()
  runPanel.clearVars()
  runPanel.setInputEnabled(true, '调试时在此输入程序的标准输入')
  if (breakpointMgr) breakpointMgr.clearCurrentLine()
  debugSession = new DebugSession(slug, myToken, {
    onCompile: (ok, error) => {
      if (ok) {
        runPanel.consolePrint('[编译成功，正在启动调试…]\n', 'info')
        // 先下发全部断点，再启动程序（避免断点未设置程序就跑完）
        if (breakpointMgr) {
          for (const line of breakpointMgr.bps) debugSession.break(line)
        }
        debugSession.cmd('restart')
      } else {
        runPanel.consolePrint('[编译失败]\n' + (error || ''), 'err')
      }
    },
    onStdout: (data) => runPanel.consolePrint(data, ''),
    onStderr: (data) => runPanel.consolePrint(data, 'err'),
    onState: (st) => {
      const loc = (st.file ? st.file + ':' : '') + st.line
      debugSession.paused = st.reason !== 'exit'
      if (st.reason === 'breakpoint') runPanel.consolePrint(`[命中断点 ${loc}]\n`, 'info')
      else if (st.reason === 'step') runPanel.consolePrint(`[单步停在 ${loc}]\n`, 'info')
      else if (st.reason === 'signal') runPanel.consolePrint(`[程序收到信号 ${st.signal || ''}，已暂停]\n`, 'err')
      else if (st.reason === 'exit') runPanel.consolePrint('[程序运行结束]\n', 'muted')
      if (breakpointMgr) breakpointMgr.setCurrentLine(st.line)
      // 每次暂停（断点/单步）后刷新自定义监控表达式；
      // 表达式未变化则跳过（脏检查，避免反复单步时重复触发 gdb 求值）
      if (st.reason !== 'exit') {
        const exprs = runPanel.getWatchExprs()
        if (exprs.length) {
          if (!arraysEqual(exprs, lastWatchExprs)) {
            lastWatchExprs = exprs
            debugSession.watch(exprs)
          }
        } else {
          lastWatchExprs = null
        }
      }
    },
    onExit: (info) => {
      runPanel.consolePrint(`[调试会话结束，退出码 ${info.code}]\n`, 'muted')
      debugSession.close()
      debugSession = null
      endSession()
    },
    onStack: (list) => runPanel.setStack(list),
    onVars: (list) => runPanel.setVars(list),
    onWatch: (list) => runPanel.setWatchResults(list),
    onClosed: () => endSession(),
    onError: () => { runPanel.consolePrint('[调试连接出错]\n', 'err'); endSession() },
    onClose: () => endSession(),
  })
  // 新增监控表达式时立即求值（仅在程序暂停时发送，避免阻塞正在运行的 gdb）
  runPanel.onWatchChanged = (exprs) => {
    if (activeKind === 'debug' && debugSession && debugSession.paused) {
      lastWatchExprs = exprs
      debugSession.watch(exprs)
    }
  }
  debugSession.connect()
  debugSession.start(path)
}

function stopSession() {
  if (runSession) {
    runSession.kill()
    runSession.close()
    runSession = null
  }
  if (debugSession) {
    debugSession.cmd('stop')
    debugSession.close()
    debugSession = null
  }
  if (activeKind) {
    if (activeKind === 'debug') runPanel.consolePrint('[调试已停止]\n', 'muted')
    else runPanel.termPrint('[已停止]\n', 'muted')
  }
  endSession()
}

function endSession() {
  activeKind = null
  if (breakpointMgr) breakpointMgr.clearCurrentLine()
  if (runPanel) runPanel.setInputEnabled(false)
  updateRunButtons()
  // 调试期间暂停的跟随：结束后跟上队长当前文件（延后执行：endSession 可能在 closeFile 过程中被调用）
  if (y) setTimeout(followCaptain, 0)
}

// ---- 启动 ----
async function main() {
  document.getElementById('user-info').textContent = me ? me.display_name || me.username : ''
  if (!slug || !me || !myToken) {
    location.href = '/login.html'
    return
  }
  try {
    const started = await loadContest()
    if (!started) {
      showWaiting()
      if (contest.creator_id === me.id) {
        startHereBtn.classList.remove('hidden')
      }
      pollTimer = setInterval(async () => {
        try {
          if (await loadContest()) {
            clearInterval(pollTimer)
            hideWaiting()
            await initEditor()
          }
        } catch (e) { /* 暂不中断轮询 */ }
      }, 2000)
      return
    }
    hideWaiting()
    await initEditor()
  } catch (e) {
    fatal(e.message || '加载比赛失败')
  }
}

startHereBtn.addEventListener('click', async () => {
  startHereBtn.disabled = true
  try {
    await API.startContest(slug)
    if (await loadContest()) {
      clearInterval(pollTimer)
      hideWaiting()
      await initEditor()
    }
  } catch (e) {
    waitingErr.textContent = e.message
    waitingErr.classList.remove('hidden')
    startHereBtn.disabled = false
  }
})

main()
