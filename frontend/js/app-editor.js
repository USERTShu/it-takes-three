// app-editor.js — 编辑器页主逻辑（ES 模块入口）
// 功能：鉴权 → 加入/读取比赛 → 未开始则等待（创建者可就地开始）→
//       加载 Monaco + Yjs 连接 → 文件树/成员面板/倒计时 → 文件 CRUD（CRDT 广播）→ 光标同步。
// 依赖：auth.js、api.js（全局）、editor-setup.js、yjs-setup.js、cursors.js、y-monaco。
// 可调参数：无。
import { createEditor } from './editor-setup.js'
import { setupYjs, createFile, deleteFile } from './yjs-setup.js'
import { setupRemoteCursors } from './cursors.js'
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
    if (y) y.provider.destroy()
  })
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
  const first = Array.from(y.filesMap.keys()).sort()[0]
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
