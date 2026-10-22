// context-menu.js — 右键菜单与就地重命名（ES 模块）
// 功能：showContextMenu 在鼠标处弹出菜单（点击外部/Esc/滚动关闭）；
//       inlineRename 把一个名称元素临时替换为输入框（回车/失焦确认、Esc 取消）。
// 依赖：app.css（.ctx-menu / .ctx-item / .inline-rename）。
// 可调参数：无。

let menuEl = null

function closeMenu() {
  if (menuEl) {
    menuEl.remove()
    menuEl = null
  }
}

/**
 * 在 (x, y) 处弹出右键菜单。
 * @param {number} x clientX
 * @param {number} y clientY
 * @param {{label:string, danger?:boolean, onClick:Function}[]} items
 */
export function showContextMenu(x, y, items) {
  closeMenu()
  menuEl = document.createElement('div')
  menuEl.className = 'ctx-menu'
  items.forEach((it) => {
    const row = document.createElement('div')
    row.className = 'ctx-item' + (it.danger ? ' danger' : '')
    row.textContent = it.label
    row.addEventListener('click', (e) => {
      e.stopPropagation()
      closeMenu()
      it.onClick()
    })
    menuEl.appendChild(row)
  })
  document.body.appendChild(menuEl)
  // 贴边时向内收，避免菜单超出窗口
  const r = menuEl.getBoundingClientRect()
  menuEl.style.left = Math.min(x, window.innerWidth - r.width - 4) + 'px'
  menuEl.style.top = Math.min(y, window.innerHeight - r.height - 4) + 'px'
}

document.addEventListener('mousedown', (e) => {
  if (menuEl && !menuEl.contains(e.target)) closeMenu()
}, true)
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu() })
window.addEventListener('blur', closeMenu)
window.addEventListener('resize', closeMenu)

/**
 * 就地重命名：用输入框替换 nameEl 的文字。
 * @param {HTMLElement} nameEl 显示名称的元素
 * @param {string} initial 初始值
 * @param {(value:string) => (string|void)} onCommit 确认回调；返回字符串表示校验失败
 *   （回车时提示并保持编辑；失焦时直接放弃）
 */
export function inlineRename(nameEl, initial, onCommit) {
  const input = document.createElement('input')
  input.className = 'inline-rename'
  input.value = initial
  input.spellcheck = false
  const original = nameEl.textContent
  nameEl.textContent = ''
  nameEl.appendChild(input)
  input.focus()
  // 文件名默认只选中扩展名前的部分（VS Code 行为）
  const dot = initial.lastIndexOf('.')
  input.setSelectionRange(0, dot > 0 ? dot : initial.length)

  let done = false
  let busy = false // 校验/提示期间（alert 会触发 blur）忽略重入
  // silent=true（失焦）：校验失败时直接放弃，不弹提示
  const finish = (commit, silent = false) => {
    if (done || busy) return
    const value = input.value.trim()
    if (commit && value && value !== initial) {
      busy = true
      const err = onCommit(value)
      busy = false
      if (typeof err === 'string' && !silent) {
        busy = true
        alert(err)
        busy = false
        input.focus()
        return
      }
    }
    done = true
    input.remove()
    nameEl.textContent = original
  }
  input.addEventListener('keydown', (e) => {
    e.stopPropagation() // 不触发编辑器/页面快捷键
    if (e.key === 'Enter') finish(true)
    else if (e.key === 'Escape') finish(false)
  })
  input.addEventListener('blur', () => finish(true, true))
  input.addEventListener('click', (e) => e.stopPropagation())
  input.addEventListener('mousedown', (e) => e.stopPropagation())
}
