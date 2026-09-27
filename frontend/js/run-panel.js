// run-panel.js — 底部面板（终端 / 调试控制台 / 变量 / 调用堆栈）管理
// 功能：标签切换、终端输出渲染（含 \r 覆盖）、stdin 输入行、拖拽调高度、变量/堆栈展示。
// 依赖：无。可调参数：无。

// 简单的行缓冲终端：\n 换行提交，\r 覆盖当前行（兼容进度条类输出）
class TermView {
  /**
   * @param {HTMLElement} el 输出容器
   */
  constructor(el) {
    this.el = el
    this._line = '' // 当前未提交的一行
  }

  append(data, cls) {
    for (const ch of data) {
      if (ch === '\n') {
        this._commit(cls)
      } else if (ch === '\r') {
        // 覆盖当前行：删除容器最后一个子节点，回到行首
        const last = this.el.lastElementChild
        if (last) last.remove()
        this._line = ''
      } else {
        this._line += ch
      }
    }
  }

  _commit(cls) {
    if (this._line.length || cls) {
      const div = document.createElement('div')
      div.className = 't-line' + (cls ? ' ' + cls : '')
      div.textContent = this._line
      this.el.appendChild(div)
    }
    this._line = ''
  }

  clear() {
    this._line = ''
    this.el.innerHTML = ''
  }

  /** 渲染完成后滚到底部 */
  scrollBottom() {
    this.el.scrollTop = this.el.scrollHeight
  }
}

export class RunPanel {
  constructor() {
    this.el = document.getElementById('run-panel')
    this.term = new TermView(document.getElementById('term-output'))
    this.console = new TermView(document.getElementById('console-output'))
    this.termInput = document.getElementById('term-input')
    this.consoleInput = document.getElementById('console-input')
    this._inputs = [this.termInput, this.consoleInput]
    this.varsBody = document.getElementById('vars-body')
    this.varsEmpty = document.getElementById('vars-empty')
    this.stackList = document.getElementById('stack-list')

    this.onInput = null // (data) => void  回车发送回调
    this.onClose = null // () => void      点击 ✕ 关闭面板回调

    this._activeTab = 'terminal'
    this._bindTabs()
    this._bindDrag()
    this._bindInput()
    this._bindClose()
  }

  // ---- 显示/隐藏 ----
  show(tab) {
    this.el.classList.remove('hidden')
    if (tab) this.setTab(tab)
    this.term.scrollBottom()
    this.console.scrollBottom()
  }
  hide() {
    this.el.classList.add('hidden')
  }
  get visible() { return !this.el.classList.contains('hidden') }
  /** 切换面板显隐（Ctrl+J / VS Code 控制台快捷键） */
  toggle() {
    if (this.visible) this.hide()
    else this.show(this._activeTab)
  }

  // ---- 标签 ----
  setTab(tab) {
    if (!document.querySelector(`.run-tab[data-tab="${tab}"]`)) tab = 'terminal'
    this._activeTab = tab
    this.el.querySelectorAll('.run-tab').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === tab)
    })
    this.el.querySelectorAll('.run-tabpane').forEach((p) => {
      p.classList.toggle('active', p.id === `tab-${tab}`)
    })
  }

  _bindTabs() {
    this.el.querySelectorAll('.run-tab').forEach((b) => {
      b.addEventListener('click', () => this.setTab(b.dataset.tab))
    })
  }

  // ---- 拖拽调整面板高度 ----
  _bindDrag() {
    const header = this.el.querySelector('.run-panel-header')
    let dragging = null
    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('.run-tab') || e.target.closest('.panel-close')) return
      dragging = { startY: e.clientY, startH: this.el.offsetHeight }
      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
    })
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return
      const h = Math.max(90, Math.min(window.innerHeight * 0.6,
        dragging.startH - (e.clientY - dragging.startY)))
      this.el.style.height = h + 'px'
    })
    window.addEventListener('mouseup', () => {
      if (!dragging) return
      dragging = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    })
  }

  // ---- 输入行（终端 / 调试控制台共用同一输入回调） ----
  _bindInput() {
    for (const input of this._inputs) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const val = input.value
          if (val && this.onInput) this.onInput(val + '\n')
          input.value = ''
        }
      })
    }
  }
  setInputEnabled(on, placeholder) {
    for (const input of this._inputs) {
      input.disabled = !on
      input.placeholder = on && placeholder ? placeholder : input.placeholder
    }
  }

  _bindClose() {
    document.getElementById('btn-panel-close').addEventListener('click', () => {
      this.hide()
      if (this.onClose) this.onClose()
    })
  }

  // ---- 终端 / 控制台输出 ----
  termPrint(data, kind) {
    // kind: '' | 'err' | 'info' | 'muted'
    this.term.append(data, kind ? `t-${kind}` : '')
    this.term.scrollBottom()
  }
  consolePrint(data, kind) {
    this.console.append(data, kind ? `t-${kind}` : '')
    this.console.scrollBottom()
  }
  clearTerm() { this.term.clear() }
  clearConsole() { this.console.clear() }

  // ---- 变量 / 调用堆栈 ----
  setVars(list) {
    const rows = (list || [])
      .filter((v) => v.name)
      .map((v) => `<tr><td class="v-name">${escapeHtml(v.name)}</td><td>${escapeHtml(v.value)}</td><td class="v-type">${escapeHtml(v.type)}</td></tr>`)
      .join('')
    this.varsBody.innerHTML = rows
    this.varsEmpty.classList.toggle('hidden', rows.length > 0)
  }
  setStack(list) {
    const items = (list || []).map((f) => {
      const loc = (f.file ? `${escapeHtml(f.file)}:${f.line ?? '?'}` : '') + (f.level != null ? ` (${f.level})` : '')
      return `<div class="stack-frame"><span class="sf-fn">${escapeHtml(f.func || '?')}</span><span class="sf-loc">${loc}</span></div>`
    }).join('')
    this.stackList.innerHTML = items || '<div class="tab-empty">（调用栈为空）</div>'
  }
  clearVars() {
    this.varsBody.innerHTML = ''
    this.varsEmpty.classList.remove('hidden')
    this.stackList.innerHTML = '<div class="tab-empty">（调用栈为空）</div>'
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
