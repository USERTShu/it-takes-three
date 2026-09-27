// cursors.js — 远端光标/选区/名字标签渲染（ES 模块）
// 功能：选区高亮 + 光标竖条复用 y-monaco 的装饰（按 clientID 注入颜色 CSS）；
//       名字标签用像素级覆盖层（.yRemoteLabelLayer），经 editor.getTopForPosition/
//       getLeftForPosition 精确定位到光标 head（正/反向选区均跟随实际光标），
//       并在滚动/内容/窗口尺寸变化时重算——不再使用 changeViewZones（其按行定位、
//       不跟随横向滚动，且 0.5 行高的 zone 会推挤正文导致错位）。
// 依赖：yjs（createAbsolutePositionFromRelativePosition）、monaco（window.monaco）。
// 可调参数：setShowNames(bool) 控制是否显示名称标签（光标/选区高亮不受影响）。
import * as Y from 'yjs'

/**
 * 为一个 Monaco 编辑器+当前文件渲染所有远端用户的指针。
 * @param {*} editor monaco 编辑器实例
 * @param {Y.Text} ytext 当前文件对应的 Y.Text
 * @param {Y.Doc} doc
 * @param {*} awareness y-protocols Awareness
 * @returns {{setShowNames: Function, destroy: Function}}
 */
export function setupRemoteCursors(editor, ytext, doc, awareness) {
  let styleEl = null
  const styledCids = new Set()
  let layer = null
  const labelEls = new Map() // cid → div.yRemoteLabel
  let showNames = true

  // 选区高亮/光标竖条颜色：y-monaco 已按 cid 生成装饰类，这里仅注入对应颜色的 CSS
  const ensureStyle = (cid, color) => {
    if (styledCids.has(cid)) return
    styledCids.add(cid)
    if (!styleEl) {
      styleEl = document.createElement('style')
      document.head.appendChild(styleEl)
    }
    styleEl.textContent = Array.from(styledCids).map((c) => `
.yRemoteSelection-${c} { background-color: ${color}; opacity: .30; }
.yRemoteSelectionHead-${c} { border-left-color: ${color}; }
`).join('\n')
  }

  // 标签覆盖层：绝对定位在编辑器内部，指针穿透，不占布局
  const ensureLayer = () => {
    if (layer) return
    const domNode = editor.getDomNode()
    if (!domNode) return
    layer = document.createElement('div')
    layer.className = 'yRemoteLabelLayer'
    domNode.appendChild(layer)
  }

  const render = () => {
    const model = editor.getModel()
    if (!model || !layer) return
    const seen = new Set()
    awareness.getStates().forEach((state, cid) => {
      if (cid === doc.clientID) return
      const color = (state.user && state.user.color) || '#888888'
      const sel = state.selection
      if (!sel || sel.anchor == null || sel.head == null) return
      const anchorAbs = Y.createAbsolutePositionFromRelativePosition(sel.anchor, doc)
      const headAbs = Y.createAbsolutePositionFromRelativePosition(sel.head, doc)
      if (anchorAbs === null || headAbs === null) return
      if (anchorAbs.type !== ytext || headAbs.type !== ytext) return
      ensureStyle(cid, color)
      seen.add(cid)
      // 光标在 selection.head（正向/反向选区均取 head 才是活动光标端）
      const headPos = model.getPositionAt(headAbs.index)
      const coords = editor.getScrolledVisiblePosition(headPos)
      if (!coords) return
      let el = labelEls.get(cid)
      if (!el) {
        el = document.createElement('div')
        el.className = 'yRemoteLabel'
        layer.appendChild(el)
        labelEls.set(cid, el)
      }
      const name = (state.user && state.user.name) || `用户${cid}`
      el.textContent = name
      el.style.color = color
      el.style.display = showNames ? '' : 'none'
      // 精确贴到光标列；translateY(-100%) 让标签浮在光标行上方，不遮挡文字/光标
      el.style.top = coords.top + 'px'
      el.style.left = coords.left + 'px'
    })
    // 清理已离线/选区失效的标签
    labelEls.forEach((el, cid) => {
      if (!seen.has(cid)) {
        el.remove()
        labelEls.delete(cid)
      }
    })
  }

  const onAwareness = () => render()
  const onUpdate = () => render()
  const onScroll = () => render()
  const onResize = () => render()

  awareness.on('change', onAwareness)
  doc.on('update', onUpdate)
  const scrollDisposable = editor.onDidScrollChange(onScroll)
  window.addEventListener('resize', onResize)

  ensureLayer()
  render()

  return {
    setShowNames(v) {
      showNames = !!v
      render()
    },
    destroy() {
      awareness.off('change', onAwareness)
      doc.off('update', onUpdate)
      try {
        scrollDisposable.dispose()
      } catch (e) { /* 旧版本可能直接返回 void */ }
      window.removeEventListener('resize', onResize)
      labelEls.forEach((el) => el.remove())
      labelEls.clear()
      if (layer) {
        layer.remove()
        layer = null
      }
      if (styleEl) {
        styleEl.remove()
        styleEl = null
      }
      styledCids.clear()
    },
  }
}
