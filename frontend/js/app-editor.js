// app-editor.js — 编辑器页主逻辑（ES 模块入口）
// 功能：鉴权 → 加入/读取比赛 → 未开始则等待（创建者可就地开始）→
//       加载 Monaco + Yjs 连接 → 文件树/成员面板/倒计时 → 文件 CRUD（CRDT 广播）→ 光标同步。
// 依赖：auth.js、api.js（全局）、editor-setup.js、yjs-setup.js、cursors.js、y-monaco。
// 可调参数：无。
import { createEditor } from './editor-setup.js'
import { setupYjs, createFile, deleteFile } from './yjs-setup.js'
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
let current = null
let currentCursors = null // 当前文件的光标渲染器（供名称开关实时控制）
let namesVisible = true // 远端用户名标签显示开关（localStorage 持久化）
const bindings = new Map() // path → {model, binding, cursors}

// ---- 运行/调试状态 ----
let runPanel = null // 底部面板
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
  try {
    contest = await API.getContest(slug)
  } catch (e) {
    if (e.status === 403) {
      // 尚未加入：自动加入（仅 created 状态可加入）
      contest = await API.joinContest(slug)
    } else {
      throw e
    }
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
  y = setupYjs(slug, myToken, {
    display_name: me.display_name,
    username: me.username,
    color: myColor,
  })
  window.__vp = y // 调试

  const badge = document.getElementById('conn-badge')
  y.provider.on('status', ({ status }) => {
    badge.textContent = status === 'connected' ? '已连接' : status === 'disconnected' ? '已断开' : '连接中…'
    badge.className = 'conn-badge ' + (status || 'connecting')
  })
  y.provider.on('synced', () => maybeOpenFirst())

  // 远端用户名标签开关（localStorage 持久化，默认开）
  const toggleNames = document.getElementById('toggle-names')
  const saved = localStorage.getItem('vp_show_names')
  namesVisible = saved === null ? true : saved === '1'
  toggleNames.checked = namesVisible
  toggleNames.addEventListener('change', () => {
    namesVisible = toggleNames.checked
    localStorage.setItem('vp_show_names', namesVisible ? '1' : '0')
    if (currentCursors) currentCursors.setShowNames(namesVisible)
  })

  renderMembers()
  startTimer()
  renderFileTree()
  maybeOpenFirst()

  y.filesMap.observe(() => {
    renderFileTree()
    maybeOpenFirst()
    // 当前文件被远端删除时关闭
    if (current && !y.filesMap.has(current)) closeFile()
  })

  document.getElementById('btn-add-file').addEventListener('click', () => {
    const name = newFileInput.value.trim() || 'main.cpp'
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

// ---- 成员面板 / 倒计时 ----
function renderMembers() {
  memberListEl.innerHTML = (contest.members || []).map((m) => {
    const color = m.color || '#888'
    return `<div class="member"><span class="dot" style="background:${color}"></span><span>${esc(m.display_name || m.username || `#${m.user_id}`)}</span></div>`
  }).join('')
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
    fileListEl.innerHTML = '<div class="empty">（空目录，右侧新建一个文件）</div>'
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
    item.appendChild(del)
    item.addEventListener('click', () => openFile(path))
    fileListEl.appendChild(item)
  })
}

function maybeOpenFirst() {
  if (current || !y || y.filesMap.size === 0) return
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
  // 关闭文件：停止正在进行的运行/调试，清空断点与当前行高亮
  if (breakpointMgr) {
    breakpointMgr.clear()
    breakpointMgr.clearCurrentLine()
  }
  stopSession()
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
