// scratchpad.js — 协作草稿纸（多人画笔批注 + 多页 + 文本，实时同步）
// 功能：
//  - 画笔批注（默认用户颜色，可选色板/自定义颜色，粗细 2/4/8/16），绘制中名称框（复用 .yRemoteLabel），
//    以线条为单位的橡皮擦除（选中擦除时光标变为橡皮擦），一键清空当前页；
//  - 激光笔：按住拖动显示渐隐轨迹（只经 awareness 'laser' 同步，不落盘）；
//  - 多页：左侧页栏 新建/选择/删除/≡ 拖动排序（数据存 doc.getMap('scratchpages'): pageId -> Y.Map，
//    页名/顺序存 pagemeta）；
//  - 文本：文本工具点击画布生成文本框（字体黑色），拖右下角手柄调大小（文本随之缩放），
//    Delete 删除文本框（双击进入编辑改文字，暂不支持其他文本功能）。
// 渲染：已提交笔画画在离屏底图上，只在页内容变化时重画；awareness 变化只叠加预览/激光。
// 依赖：yjs（scratchpages Map）、y-protocols/awareness（scratch/laser/page 字段）、cursors.css（.yRemoteLabel）。
// 可调参数：initScratchpad({doc, awareness, provider, getShowNames}) → {setShowNames(v), destroy()}。

import * as Y from 'yjs'
import { showContextMenu, inlineRename } from './context-menu.js'

const W = 2400 // 虚拟坐标系：固定 2400×1600，画布按实际尺寸缩放，坐标始终在虚拟系运算
const H = 1600
// 画布显示尺寸 = 适配窗口的尺寸 × CANVAS_ZOOM（与虚拟坐标同步翻倍：原 1200×800 内容的
// 显示比例不变，只是多出右侧/下方空间），超出画布区的部分滚动查看
const CANVAS_ZOOM = 2
const ERASE_THRESHOLD = 12 // 擦除命中阈值（虚拟 px）：点到折线最小距离
const PREVIEW_ALPHA = 0.45 // 远端绘制中预览透明度
const TEXT_DEFAULT_W = 140 // 新建文本框默认宽（虚拟 px）
const TEXT_DEFAULT_H = 44 // 新建文本框默认高（虚拟 px，字号基准：fs = 16 * h / 44）
const TEXT_BASE_FS = 16
const LASER_LIFE = 700 // 激光轨迹点存活时间（ms）
const LASER_COLOR = '#ff2d2d'

// 橡皮擦光标（SVG data URI，热点在橡皮左下尖端）
const ERASER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><rect x="3" y="5" width="13" height="15" rx="2" fill="#f8bbd0" stroke="#ad1457" stroke-width="1"/><rect x="5" y="8" width="9" height="4" rx="1" fill="#ffffff"/><rect x="3" y="14" width="13" height="6" rx="1" fill="#ec407a"/></svg>'
const ERASER_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(ERASER_SVG)}") 4 5, crosshair`

/**
 * 初始化协作草稿纸。
 * @param {{doc: Y.Doc, awareness: import('y-protocols/awareness').Awareness, provider: any, getShowNames: Function}} opts
 *   provider：WebsocketProvider，首次同步完成后才检查/创建默认页（否则每次进入都会新建空 p1 覆盖他人数据）
 * @returns {{setShowNames: Function, destroy: Function}}
 */
export function initScratchpad({ doc, awareness, provider, getShowNames }) {
  const annotations = doc.getMap('annotations') // 旧数据（迁移到多页结构后不再使用）
  const scratchpages = doc.getMap('scratchpages') // pageId -> Y.Map（页内对象）
  const pagemeta = doc.getMap('pagemeta') // pageId -> Y.Map（页属性：name 自定义页名）
  const container = document.getElementById('scratchpad-container')
  const canvas = document.getElementById('scratch-canvas')
  const ctx = canvas.getContext('2d')
  const base = document.createElement('canvas') // 离屏底图：当前页已提交笔画
  const bctx = base.getContext('2d')
  const zone = container.querySelector('.scratchpad-canvas-zone')
  const wrap = container.querySelector('.scratchpad-canvas-wrap')
  const labelLayer = container.querySelector('.scratchpad-label-layer')
  const textLayer = document.getElementById('scratch-text-layer')
  const pageListEl = document.getElementById('scratch-page-list')

  let showNames = getShowNames ? getShowNames() : true // 名称框开关（与编辑器名称开关同步）
  let tool = 'pen' // 'pen' | 'eraser' | 'text'
  let width = 2 // 当前线宽
  let penColor = null // 画笔颜色；null = 用户颜色
  let laserPts = [] // 本端激光轨迹 [{x, y, t}]
  let laserDown = false
  let laserRaf = 0
  let lastLaserBroadcast = 0
  let baseDirty = true // 底图需重画（页内容/切页/尺寸变化）
  let dragId = null // 页栏拖动中的页 id
  let seq = 0 // 本地画笔序号（与 clientID 组成 id）
  let seqText = 0 // 本地文本序号
  let active = null // 绘制中的本地笔画 {id, u, c, w, p:[x0,y0,...]}
  let erasing = false // 橡皮是否处于按住拖动擦除
  let currentPage = null // 当前页 id（本端视图状态，存 awareness 'page'）
  let editingId = null // 本端正在编辑文字的对象 id
  let pendingSelectId = null // 等待 syncTexts 创建后选中的对象 id
  let lastBroadcast = 0 // 预览广播节流时间戳
  let lastErase = 0 // 橡皮擦除节流时间戳
  let lastTextSave = 0 // 文本输入保存节流时间戳
  let resizeObs = null
  let pendingPaint = false
  const textEls = new Map() // 对象 id -> div.scratch-text
  const pageObs = new Map() // 页 key -> 已监听的 Y.Map 实例（同 key 被并发覆盖后实例会变，需重新监听）

  // ---- 坐标换算：客户端 px → 虚拟坐标 ----
  function toV(e) {
    const r = canvas.getBoundingClientRect()
    return {
      x: ((e.clientX - r.left) / r.width) * W,
      y: ((e.clientY - r.top) / r.height) * H,
    }
  }

  // ---- 画布尺寸：按实际显示尺寸设分辨率（HiDPI 清晰），变换映射到虚拟坐标 ----
  function resize() {
    const r = wrap.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    const pxW = Math.max(1, Math.round(r.width * dpr))
    const pxH = Math.max(1, Math.round(r.height * dpr))
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW
      canvas.height = pxH
      base.width = pxW
      base.height = pxH
    }
    ctx.setTransform(pxW / W, 0, 0, pxH / H, 0, 0)
    bctx.setTransform(pxW / W, 0, 0, pxH / H, 0, 0)
    baseDirty = true
    paintFull()
  }

  // 画布区可用空间驱动缩放：等比（3:2）取能同时塞下宽高的最大尺寸，再放大 CANVAS_ZOOM 倍
  function fitWrap() {
    const z = zone.getBoundingClientRect()
    const availW = Math.max(0, z.width - 32)
    const availH = Math.max(0, z.height - 32)
    const w = Math.min(availW, availH * (W / H)) * CANVAS_ZOOM
    wrap.style.width = Math.max(400, w) + 'px'
    wrap.style.height = (wrap.clientWidth * H / W) + 'px'
  }

  // ---- 折线绘制（pts 为普通数组：length + 下标访问；c 为目标 context，默认可见画布） ----
  function drawPoints(pts, color, w, alpha, c = ctx) {
    const n = pts.length
    c.globalAlpha = alpha
    c.lineCap = 'round'
    c.lineJoin = 'round'
    if (n < 4) {
      if (n >= 2) { // 单点落笔：圆点，让"点一下"也有可见反馈
        c.fillStyle = color
        c.beginPath()
        c.arc(pts[0], pts[1], Math.max(1, w / 2), 0, Math.PI * 2)
        c.fill()
      }
      c.globalAlpha = 1
      return
    }
    c.strokeStyle = color
    c.lineWidth = w
    c.beginPath()
    c.moveTo(pts[0], pts[1])
    for (let i = 2; i < n; i += 2) c.lineTo(pts[i], pts[i + 1])
    c.stroke()
    c.globalAlpha = 1
  }

  // ---- 激光轨迹：越靠近笔尖越不透明越粗，笔尖画亮点（pts 为扁平数组 [x0,y0,x1,y1,...]） ----
  function drawLaser(pts) {
    const n = pts.length / 2
    if (n < 1) return
    ctx.lineCap = 'round'
    ctx.strokeStyle = LASER_COLOR
    for (let i = 1; i < n; i++) {
      const k = i / (n - 1 || 1)
      ctx.globalAlpha = 0.15 + 0.85 * k
      ctx.lineWidth = 2 + 4 * k
      ctx.beginPath()
      ctx.moveTo(pts[2 * i - 2], pts[2 * i - 1])
      ctx.lineTo(pts[2 * i], pts[2 * i + 1])
      ctx.stroke()
    }
    const hx = pts[2 * n - 2]
    const hy = pts[2 * n - 1]
    ctx.globalAlpha = 0.25
    ctx.fillStyle = LASER_COLOR
    ctx.beginPath()
    ctx.arc(hx, hy, 12, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalAlpha = 1
    ctx.beginPath()
    ctx.arc(hx, hy, 5, 0, Math.PI * 2)
    ctx.fill()
  }

  // 远端激光：awareness state.laser = {page, p}（仅当前页）
  function laserFor(state) {
    const l = state.laser
    if (!l || !l.p || l.p.length < 2) return null
    if (l.page !== currentPage) return null
    return l.p
  }

  function localLaserFlat() {
    const out = []
    laserPts.forEach((q) => out.push(q.x, q.y))
    return out
  }

  // ---- 远端实时预览：awareness state.scratch（半透明折线 + 笔尖名称框，仅当前页） ----
  function previewItemFor(cid, state) {
    const s = state.scratch
    if (!s || !s.p || s.p.length < 2) return null
    if (s.page && s.page !== currentPage) return null // 预览在其他页则跳过
    return {
      cid,
      color: s.c || '#888',
      w: s.w || 2,
      p: s.p, // 状态对象是普通对象，p 为普通数组
      name: (state.user && state.user.name) || `用户${cid}`,
    }
  }

  // 当前页 Y.Map（Yjs ContentType：scratchpages 存的是 Y.Map 实例，读回即 Y.Map）
  function currentMap() {
    return scratchpages.get(currentPage) || null
  }

  // ---- 底图：本页已提交笔画（只在页内容/切页/尺寸变化时重画） ----
  // 注意：页内对象经 Yjs ContentAny 原样存取（普通对象/数组），用 s.p / s.c 下标访问；
  //       文本对象由 syncTexts 渲染为 HTML 元素，不画在 canvas 上。
  function paintBase() {
    bctx.clearRect(0, 0, W, H)
    const page = currentMap()
    if (page) {
      page.forEach((obj) => {
        if (obj.type === 'text') return
        drawPoints(obj.p, obj.c, obj.w, 1, bctx)
      })
    }
  }

  // ---- 合成：底图 + 远端绘制中预览 + 激光 + 本端绘制中笔画（底图脏时顺带重画底图与文本层） ----
  function paintFull() {
    const contentChanged = baseDirty
    if (baseDirty) {
      baseDirty = false
      paintBase()
    }
    ctx.clearRect(0, 0, W, H)
    ctx.drawImage(base, 0, 0, W, H)
    if (awareness) {
      awareness.getStates().forEach((state, cid) => {
        if (cid === doc.clientID) return // 跳过本端预览（由 active 绘制）
        const item = previewItemFor(cid, state)
        if (item) drawPoints(item.p, item.color, item.w, PREVIEW_ALPHA)
        const lp = laserFor(state)
        if (lp) drawLaser(lp)
      })
    }
    if (laserPts.length) drawLaser(localLaserFlat())
    if (active && active.p.length >= 2) drawPoints(active.p, active.c, active.w, 1)
    if (contentChanged) syncTexts()
    syncLabels()
  }

  // ---- 文本层：按当前页 text 对象 diff 维护 HTML 文本框 ----
  function syncTexts() {
    if (!textLayer) return
    const page = currentMap()
    const r = canvas.getBoundingClientRect()
    const seen = new Set()
    if (page) {
      page.forEach((obj, id) => {
        if (obj.type !== 'text') return
        seen.add(id)
        let el = textEls.get(id)
        let content = null
        if (!el) {
          el = document.createElement('div')
          el.className = 'scratch-text'
          el.dataset.id = id
          el.tabIndex = 0 // 可聚焦：选中后能接收 Delete/Backspace 删除按键
          content = document.createElement('span')
          content.className = 'scratch-text-content'
          const h = document.createElement('span')
          h.className = 'scratch-text-handle'
          el.appendChild(content)
          el.appendChild(h)
          wireTextEvents(el, id)
          textEls.set(id, el)
          textLayer.appendChild(el)
        } else {
          content = el.querySelector('.scratch-text-content')
        }
        // 几何（虚拟 → px），文本随高度等比缩放字号
        const px = { x: (obj.x / W) * r.width, y: (obj.y / H) * r.height }
        el.style.left = px.x + 'px'
        el.style.top = px.y + 'px'
        el.style.width = Math.max(20, (obj.w / W) * r.width) + 'px'
        el.style.height = Math.max(16, (obj.h / H) * r.height) + 'px'
        el.style.fontSize = Math.max(8, 16 * (obj.h || TEXT_DEFAULT_H) / TEXT_DEFAULT_H) + 'px'
        // 内容：本端正在编辑时以本地输入为准，不覆盖；否则同步远端文本
        // 文本放在独立的 .scratch-text-content span 里，绝不整块 textContent（会冲掉手柄节点）
        if (editingId === id && el.contentEditable === 'true') {
          // 保持输入焦点与内容
        } else if (content.textContent !== (obj.text || '')) {
          content.textContent = (obj.text || '') + ''
        }
        if (pendingSelectId === id) {
          pendingSelectId = null
          startEdit(el, id) // 新建后自动进入编辑：点击即输入文字
        }
      })
    }
    // 清理已删除/不在当前页的文本元素
    textEls.forEach((el, id) => {
      if (!seen.has(id)) {
        el.remove()
        textEls.delete(id)
      }
    })
  }

  // ---- 文本交互：选中 / 双击编辑 / 拖拽调大小 / Delete 删除 ----
  function selectText(el) {
    textEls.forEach((e) => e.classList.remove('selected', 'editing'))
    el.classList.add('selected')
    if (el.contentEditable === 'true') el.blur() // 先退出编辑态（blur 触发 endEdit 保存）
    el.focus() // 聚焦（tabIndex=0），保证后续 Delete/Backspace 落在框上
  }

  // 取消所有文本框选中/编辑（点击画布、切页、删框时调用）
  function deselectAll() {
    textEls.forEach((e) => {
      e.classList.remove('selected')
      if (e.contentEditable === 'true') e.blur() // blur 触发 endEdit 保存
    })
  }

  function startEdit(el, id) {
    editingId = id
    el.classList.add('editing', 'selected')
    el.contentEditable = 'true'
    el.focus()
    // 光标移到末尾
    const content = el.querySelector('.scratch-text-content')
    const range = document.createRange()
    range.selectNodeContents(content)
    range.collapse(false)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
  }

  function endEdit(el, id) {
    if (el.contentEditable !== 'true') return
    el.contentEditable = 'false'
    el.classList.remove('editing')
    const page = currentMap()
    const obj = page && page.get(id)
    if (obj && obj.type === 'text') {
      const content = el.querySelector('.scratch-text-content')
      doc.transact(() => {
        page.set(id, { ...obj, text: content.textContent })
      }, 'text-edit')
    }
    if (editingId === id) editingId = null
  }

  function deleteText(id) {
    const page = currentMap()
    if (page) page.delete(id) // 触发 observe → syncTexts 移除元素
    if (editingId === id) editingId = null
    pendingSelectId = null
    document.activeElement && document.activeElement.blur()
  }

  // 拖拽右下角手柄调整文本框大小（文本字号随高度等比）
  function startResize(id, e) {
    e.preventDefault()
    e.stopPropagation()
    const page = currentMap()
    const obj = page && page.get(id)
    if (!obj || obj.type !== 'text') return
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch (err) { /* 合成事件无捕获对象 */ }
    const startV = toV(e)
    const startW = obj.w
    const startH = obj.h
    const move = (ev) => {
      const v = toV(ev)
      const dw = v.x - startV.x
      const dh = v.y - startV.y
      const nw = Math.max(40, startW + dw)
      const nh = Math.max(20, startH + dh)
      const nfs = Math.max(8, 16 * nh / TEXT_DEFAULT_H)
      const np = page.get(id)
      if (np && np.type === 'text') {
        doc.transact(() => {
          page.set(id, { ...np, w: Math.round(nw), h: Math.round(nh), fs: nfs })
        }, 'text-resize')
      }
    }
    const up = () => {
      e.currentTarget.releasePointerCapture && e.currentTarget.releasePointerCapture(e.pointerId)
      e.currentTarget.removeEventListener('pointermove', move)
      e.currentTarget.removeEventListener('pointerup', up)
    }
    e.currentTarget.addEventListener('pointermove', move)
    e.currentTarget.addEventListener('pointerup', up)
  }

  function wireTextEvents(el, id) {
    el.addEventListener('pointerdown', (e) => {
      if (e.target.classList.contains('scratch-text-handle')) return // 交给手柄
      e.stopPropagation()
    })
    el.addEventListener('click', () => {
      // 单击恒为"选中"（可 Delete 删除）；编辑只由双击进入，避免选中态残留导致误进编辑
      selectText(el)
    })
    el.addEventListener('dblclick', (e) => {
      e.preventDefault()
      startEdit(el, id)
    })
    el.addEventListener('keydown', (e) => {
      if (el.contentEditable === 'true') return // 编辑态 Delete/Backspace 正常删字
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        deleteText(id)
      }
    })
    el.addEventListener('blur', () => endEdit(el, id))
    el.addEventListener('input', () => {
      const page = currentMap()
      const obj = page && page.get(id)
      if (!obj || obj.type !== 'text') return
      const now = performance.now()
      if (now - lastTextSave < 300) return // 节流保存，减少 CRDT 写入
      lastTextSave = now
      const content = el.querySelector('.scratch-text-content')
      doc.transact(() => {
        page.set(id, { ...obj, text: content.textContent })
      }, 'text-edit')
    })
    const h = el.querySelector('.scratch-text-handle')
    h.addEventListener('pointerdown', (e) => startResize(id, e))
  }

  // ---- 名称框：仅"绘制中"（本端 active 笔画 或 远端 scratch 预览）且开启名称显示时出现 ----
  function syncLabels() {
    if (!labelLayer) return
    labelLayer.querySelectorAll('.yRemoteLabel').forEach((el) => el.remove())
    if (!showNames) return
    const me = awareness.getLocalState() || {}
    const user = me.user || {}
    const items = []
    if (active && active.p.length >= 2) {
      items.push({
        name: user.name || '我',
        color: user.color || '#888',
        px: active.p[active.p.length - 2],
        py: active.p[active.p.length - 1],
      })
    }
    awareness.getStates().forEach((state, cid) => {
      if (cid === doc.clientID) return
      const item = previewItemFor(cid, state)
      if (item) items.push({ name: item.name, color: item.color, px: item.p[item.p.length - 2], py: item.p[item.p.length - 1] })
      const lp = laserFor(state)
      if (lp) {
        const u = state.user || {}
        items.push({ name: u.name || `用户${cid}`, color: u.color || '#888', px: lp[lp.length - 2], py: lp[lp.length - 1] })
      }
    })
    if (!items.length) return
    const r = canvas.getBoundingClientRect()
    for (const it of items) {
      const el = document.createElement('div')
      el.className = 'yRemoteLabel'
      el.textContent = it.name
      el.style.color = it.color
      el.style.top = (it.py / H) * r.height + 'px'
      el.style.left = (it.px / W) * r.width + 'px'
      labelLayer.appendChild(el)
    }
  }

  // ---- 擦除：点到折线最小距离（分线段求垂足距离），阈值 12，命中最近一条 ----
  function distToSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay
    const len2 = dx * dx + dy * dy
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0
    t = Math.max(0, Math.min(1, t))
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
  }

  function hitTest(v) {
    const page = currentMap()
    if (!page) return null
    let bestId = null
    let bestDist = Infinity
    page.forEach((s, id) => {
      if (s.type === 'text') return // 文本不参与线条擦除（用 Delete 删除）
      const p = s.p
      const n = p.length
      if (n < 2) return
      let minD = Infinity
      for (let i = 0; i < n - 2; i += 2) {
        const d = distToSeg(v.x, v.y, p[i], p[i + 1], p[i + 2], p[i + 3])
        if (d < minD) minD = d
      }
      if (n === 2) minD = Math.min(minD, Math.hypot(v.x - p[0], v.y - p[1]))
      if (minD < bestDist) {
        bestDist = minD
        bestId = id
      }
    })
    return bestDist <= ERASE_THRESHOLD ? bestId : null
  }

  // ---- 画笔/橡皮/文本 事件 ----
  const onPointerDown = (e) => {
    if (e.button !== 0) return
    e.preventDefault() // 阻止文本选择/滚动
    deselectAll() // 点击画布：取消文本框选中/编辑（编辑中的 blur 会触发 endEdit 保存）
    const v = toV(e)
    // 指针捕获：真实拖拽时防止移出画布丢事件；合成事件/异常环境无活动指针则忽略
    try {
      canvas.setPointerCapture(e.pointerId)
    } catch (err) { /* 非真实指针（如合成事件）无捕获对象，忽略 */ }
    if (tool === 'text') {
      createText(v) // 文本工具：点击画布生成文本框
      return
    }
    if (tool === 'laser') {
      laserDown = true
      laserPts.push({ x: v.x, y: v.y, t: performance.now() })
      startLaser()
      return
    }
    if (tool === 'pen') {
      seq++
      const me = awareness.getLocalState() || {}
      const user = me.user || {}
      active = {
        id: `${doc.clientID}-${seq}`,
        u: user.name || '匿名',
        c: penColor || user.color || '#888',
        w: width,
        p: [v.x, v.y],
      }
      syncLabels()
    } else {
      erasing = true
      eraseAt(v)
    }
  }

  const onPointerMove = (e) => {
    if (e.button !== 0 && e.buttons === 0) return // 悬停移动不算
    const v = toV(e)
    if (tool === 'laser' && laserDown) {
      laserPts.push({ x: v.x, y: v.y, t: performance.now() })
    } else if (tool === 'pen' && active) {
      const p = active.p
      const lastX = p[p.length - 2]
      const lastY = p[p.length - 1]
      if (Math.hypot(v.x - lastX, v.y - lastY) < 2) return // 相邻点过近丢弃采样
      p.push(v.x, v.y)
      // 只增量画本端当前折线的新线段（立即反馈，不触发全量重绘）
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.strokeStyle = active.c
      ctx.lineWidth = active.w
      ctx.beginPath()
      ctx.moveTo(p[p.length - 4], p[p.length - 3])
      ctx.lineTo(v.x, v.y)
      ctx.stroke()
      // 节流广播绘制中预览（远端显示半透明线条 + 名称框，带页标记）
      const now = performance.now()
      if (now - lastBroadcast > 30) {
        lastBroadcast = now
        awareness.setLocalStateField('scratch', { c: active.c, w: active.w, p: p.slice(), page: currentPage })
      }
      syncLabels()
    } else if (erasing) {
      eraseAt(v)
    }
  }

  const onPointerUp = (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    if (tool === 'pen' && active) {
      const page = currentMap()
      if (page) {
        page.set(active.id, { id: active.id, type: 'stroke', u: active.u, c: active.c, w: active.w, p: active.p })
      }
      active = null
      awareness.setLocalStateField('scratch', null) // 本端停笔，远端移除预览
      // page.set 触发 observe → paintFull（已提交笔画重绘）
    }
    laserDown = false // 轨迹继续渐隐，由 laserTick 收尾
    erasing = false
    if (canvas.hasPointerCapture && canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId)
    }
    syncLabels()
  }

  // ---- 激光笔：每帧裁掉过期轨迹点并重绘，节流广播；轨迹消失后停止 ----
  function startLaser() {
    if (!laserRaf) laserRaf = requestAnimationFrame(laserTick)
  }

  function laserTick() {
    const now = performance.now()
    const last = laserPts[laserPts.length - 1]
    laserPts = laserPts.filter((q) => now - q.t < LASER_LIFE)
    if (laserDown && last && laserPts[laserPts.length - 1] !== last) laserPts.push(last) // 按住不动时保留笔尖
    const alive = laserPts.length > 0
    if (!alive || now - lastLaserBroadcast > 40) {
      lastLaserBroadcast = now
      awareness.setLocalStateField('laser', alive ? { page: currentPage, p: localLaserFlat() } : null)
    }
    requestPaint()
    laserRaf = alive ? requestAnimationFrame(laserTick) : 0
  }

  // 橡皮拖动擦除节流（线条为单位：一次删一条最近的）
  function eraseAt(v) {
    const now = performance.now()
    if (now - lastErase < 20) return
    lastErase = now
    const id = hitTest(v)
    const page = currentMap()
    if (id && page) page.delete(id) // delete 触发 observe → paintFull
  }

  // ---- 文本工具：点击画布生成文本框 ----
  function createText(v) {
    const page = currentMap()
    if (!page) return
    seqText++
    const me = awareness.getLocalState() || {}
    const user = me.user || {}
    const id = `t${doc.clientID}-${seqText}`
    page.set(id, {
      id, type: 'text',
      u: user.name || '匿名',
      x: Math.max(0, Math.min(W - TEXT_DEFAULT_W, v.x)),
      y: Math.max(0, Math.min(H - TEXT_DEFAULT_H, v.y)),
      w: TEXT_DEFAULT_W, h: TEXT_DEFAULT_H, fs: TEXT_BASE_FS,
      text: '文本',
    })
    pendingSelectId = id // syncTexts 创建元素后自动进入编辑（点击即输入）
  }

  // ---- 多页：新建 / 切换 / 删除 / 排序 / 渲染列表 ----
  // 须在首次同步完成后调用：同步前本地文档为空，若此时新建 p1 会与服务端已有的 p1 冲突，
  // 按 clientID 决胜，可能用空页覆盖所有人的第 1 页
  function ensurePages() {
    if (scratchpages.size > 0) return
    // 迁移旧单页数据（annotations）到第一页 p1
    doc.transact(() => {
      const p1 = new Y.Map()
      annotations.forEach((s, id) => {
        p1.set(id, { id, type: 'stroke', u: s.u, c: s.c, w: s.w, p: s.p })
      })
      scratchpages.set('p1', p1)
      metaFor('p1').set('name', '页 1')
      metaFor('p1').set('order', 0)
    }, 'scratchpad-init')
  }

  // 页属性 Y.Map（不存在则创建；需在事务内调用）
  function metaFor(id) {
    let meta = pagemeta.get(id)
    if (!meta) {
      meta = new Y.Map()
      pagemeta.set(id, meta)
    }
    return meta
  }

  // 页顺序：按 pagemeta.order 排序，相同/缺失时按 id，保证各端一致
  // （Y.Map 的键遍历顺序取决于本端收到更新的先后，各端可能不同，不能直接用）
  function orderOf(id) {
    const meta = pagemeta.get(id)
    const o = meta && meta.get('order')
    return typeof o === 'number' ? o : -1
  }

  function orderedIds() {
    return Array.from(scratchpages.keys()).sort((a, b) => orderOf(a) - orderOf(b) || (a < b ? -1 : a > b ? 1 : 0))
  }

  function createPage() {
    seqText++ // 复用序号保证 id 唯一即可
    const id = `p${Date.now().toString(36)}-${seqText}`
    const ids = orderedIds()
    // 新页名在创建时固定（拖动排序后不会跟着序号变），编号取现有“页 N”的最大值 + 1
    let maxNum = 0
    ids.forEach((pid, idx) => {
      const m = /^页 (\d+)$/.exec(pageName(pid, idx))
      if (m) maxNum = Math.max(maxNum, Number(m[1]))
    })
    const maxOrder = ids.reduce((mx, pid) => Math.max(mx, orderOf(pid)), -1)
    doc.transact(() => {
      scratchpages.set(id, new Y.Map())
      metaFor(id).set('name', `页 ${maxNum + 1}`)
      metaFor(id).set('order', maxOrder + 1)
    })
    attachPageObs(id)
    switchPage(id)
  }

  // 把 from 页移到 target 页之前/之后：按新顺序重写所有页的 order（只写变化的）
  function movePage(from, target, after) {
    if (from === target) return
    const ids = orderedIds().filter((x) => x !== from)
    let i = ids.indexOf(target)
    if (i < 0) return
    if (after) i++
    ids.splice(i, 0, from)
    doc.transact(() => {
      ids.forEach((pid, k) => {
        if (orderOf(pid) !== k) metaFor(pid).set('order', k)
      })
    })
  }

  function deletePage(id) {
    if (scratchpages.size <= 1) return // 至少保留一页
    doc.transact(() => {
      scratchpages.delete(id) // 触发 onPagesChange：刷新列表 + 若删除的是当前页则回退第一页
      pagemeta.delete(id)
    })
  }

  // 页名：自定义名（pagemeta.name）优先，否则按序号显示“页 N”
  function pageName(id, idx) {
    const meta = pagemeta.get(id)
    const name = meta && meta.get('name')
    return name || `页 ${idx + 1}`
  }

  function renamePage(id, name) {
    if (name.length > 30) return '页名最多 30 个字'
    doc.transact(() => {
      metaFor(id).set('name', name)
    })
  }

  function switchPage(id) {
    if (id === currentPage) return
    if (editingId) { // 切页前结束编辑（须在 currentPage 仍是旧页时保存，否则 endEdit 存到新页丢失）
      const el = textEls.get(editingId)
      if (el) endEdit(el, editingId)
    }
    currentPage = id
    awareness.setLocalStateField('page', id)
    renderPages()
    requestPaint(true)
  }

  function clearDropMarks() {
    pageListEl.querySelectorAll('.drop-before, .drop-after, .dragging').forEach((el) => {
      el.classList.remove('drop-before', 'drop-after', 'dragging')
    })
  }

  function renderPages() {
    if (!pageListEl) return
    pageListEl.innerHTML = ''
    const ids = orderedIds()
    ids.forEach((id, idx) => {
      const row = document.createElement('div')
      row.className = 'scratchpad-page' + (id === currentPage ? ' active' : '')
      row.dataset.page = id
      const label = pageName(id, idx)
      // ≡ 拖动手柄：拖到其他页的上半/下半部分放下，插到其前/后
      const grip = document.createElement('span')
      grip.className = 'grip'
      grip.textContent = '≡'
      grip.title = '拖动调整顺序'
      grip.draggable = true
      grip.addEventListener('click', (e) => e.stopPropagation())
      grip.addEventListener('dragstart', (e) => {
        dragId = id
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', id)
        e.dataTransfer.setDragImage(row, 12, row.offsetHeight / 2)
        row.classList.add('dragging')
      })
      grip.addEventListener('dragend', () => {
        dragId = null
        clearDropMarks()
      })
      row.addEventListener('dragover', (e) => {
        if (!dragId || dragId === id) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const r = row.getBoundingClientRect()
        const after = e.clientY > r.top + r.height / 2
        row.classList.toggle('drop-before', !after)
        row.classList.toggle('drop-after', after)
      })
      row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'))
      row.addEventListener('drop', (e) => {
        if (!dragId) return
        e.preventDefault()
        const after = row.classList.contains('drop-after')
        const from = dragId
        dragId = null
        clearDropMarks()
        movePage(from, id, after)
      })
      const name = document.createElement('span')
      name.className = 'name'
      name.textContent = label
      const del = document.createElement('button')
      del.className = 'del'
      del.textContent = '✕'
      del.title = '删除此页'
      del.addEventListener('click', (e) => {
        e.stopPropagation()
        if (window.confirm(`删除 ${label}？`)) deletePage(id)
      })
      row.appendChild(grip)
      row.appendChild(name)
      row.appendChild(del)
      row.addEventListener('click', () => switchPage(id))
      // 右键菜单：重命名 / 删除
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        const items = [{ label: '重命名', onClick: () => inlineRename(name, label, (v) => renamePage(id, v)) }]
        if (scratchpages.size > 1) {
          items.push({ label: '删除', danger: true, onClick: () => { if (window.confirm(`删除 ${label}？`)) deletePage(id) } })
        }
        showContextMenu(e.clientX, e.clientY, items)
      })
      pageListEl.appendChild(row)
    })
  }

  // ---- 监听：页集合变化 / 当前页内容变化 → 合并到下一帧重绘 ----
  // contentChanged=true 时重画底图（页内容/切页），否则只重新合成预览/激光
  const requestPaint = (contentChanged = false) => {
    if (contentChanged) baseDirty = true
    if (pendingPaint) return
    pendingPaint = true
    requestAnimationFrame(() => {
      pendingPaint = false
      paintFull()
    })
  }
  const onPageContent = (event) => {
    // 只重绘当前页的内容变化（event.target 是发生变化的 Y.Map）
    if (event.target === currentMap()) requestPaint(true)
  }
  // 为一个页 attach 内容监听（幂等：同一实例不重复 observe；
  // 同 key 被并发写入覆盖后实例会变，需改为监听新实例，否则该页远端改动不再触发重绘）
  function attachPageObs(id) {
    const page = scratchpages.get(id)
    const old = pageObs.get(id)
    if (old && old === page) return
    if (old) old.unobserve(onPageContent)
    pageObs.delete(id)
    if (!page || typeof page.observe !== 'function') return
    page.observe(onPageContent)
    pageObs.set(id, page)
  }

  // 当前页不存在（尚未选页 / 被本端或远端删除）→ 回退到第一页并广播
  function ensureCurrentPage() {
    if (currentPage && scratchpages.has(currentPage)) return
    const first = orderedIds()[0]
    if (first) {
      currentPage = first
      awareness.setLocalStateField('page', first)
    }
  }

  const onPagesChange = (event) => {
    // 页加入/覆盖/删除时同步内容监听
    if (event.keysChanged) {
      event.keysChanged.forEach((k) => attachPageObs(k))
    }
    ensureCurrentPage()
    renderPages()
    requestPaint(true)
  }

  scratchpages.observe(onPagesChange)
  const onMetaChange = () => renderPages() // 页名/顺序变化（含远端）
  pagemeta.observeDeep(onMetaChange)
  awareness.on('change', onAwarenessChange)

  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', onPointerUp)
  canvas.addEventListener('pointercancel', onPointerUp)

  function onAwarenessChange() { requestPaint() }

  // ---- 工具栏 ----
  const setToolCursor = () => {
    canvas.style.cursor = tool === 'pen' || tool === 'laser' ? 'crosshair' : tool === 'eraser' ? ERASER_CURSOR : 'text'
  }
  const toolBtns = container.querySelectorAll('.scratchpad-tool[data-tool]')
  function setTool(name) {
    if (editingId) { // 切工具时结束文本编辑
      const el = textEls.get(editingId)
      if (el) endEdit(el, editingId)
    }
    tool = name
    toolBtns.forEach((x) => x.classList.toggle('active', x.dataset.tool === name))
    setToolCursor()
  }
  toolBtns.forEach((b) => {
    b.addEventListener('click', () => setTool(b.dataset.tool))
  })
  const widthBtns = container.querySelectorAll('.scratchpad-width[data-width]')
  widthBtns.forEach((b) => {
    b.addEventListener('click', () => {
      width = Number(b.dataset.width)
      widthBtns.forEach((x) => x.classList.toggle('active', x === b))
    })
  })
  // 颜色：色块（data-color 为空 = 我的颜色）+ 自定义取色器；选色后自动切到画笔
  const colorBtns = container.querySelectorAll('.scratchpad-color')
  const colorInput = document.getElementById('scratch-color-custom')
  const myColor = ((awareness.getLocalState() || {}).user || {}).color || '#888'
  colorBtns.forEach((b) => {
    b.style.background = b.dataset.color || myColor
    b.addEventListener('click', () => {
      penColor = b.dataset.color || null
      colorBtns.forEach((x) => x.classList.toggle('active', x === b))
      if (colorInput) colorInput.classList.remove('active')
      setTool('pen')
    })
  })
  if (colorInput) {
    colorInput.addEventListener('input', () => {
      penColor = colorInput.value
      colorBtns.forEach((x) => x.classList.remove('active'))
      colorInput.classList.add('active')
      setTool('pen')
    })
  }
  container.querySelector('#scratch-clear').addEventListener('click', () => {
    const page = currentMap()
    if (!page || page.size === 0) return
    if (window.confirm('清空当前页所有批注？此操作对所有人生效。')) page.clear()
  })
  document.getElementById('scratch-page-add').addEventListener('click', () => createPage())

  // ---- 尺寸适配：可用空间缩放 + 画布分辨率随实际尺寸 ----
  resizeObs = new ResizeObserver(() => {
    fitWrap()
    resize()
  })
  resizeObs.observe(zone)
  window.addEventListener('resize', resize)

  // ---- 初始化 ----
  // 本端当前页：优先 awareness 已存值（其他端翻页互不影响），否则默认第一页
  const savedPage = awareness.getLocalState() && awareness.getLocalState().page
  if (savedPage && scratchpages.has(savedPage)) currentPage = savedPage
  ensureCurrentPage()
  // attach 现有页内容监听（幂等去重）
  Array.from(scratchpages.keys()).forEach(attachPageObs)
  renderPages()
  // 首次同步完成后再补默认页（同步到的已有页会经 onPagesChange 选中）
  const onSynced = (isSynced) => {
    if (isSynced === false) return
    if (provider) provider.off('synced', onSynced)
    ensurePages()
    ensureCurrentPage()
    renderPages()
    requestPaint(true)
  }
  if (!provider || provider.synced) onSynced(true)
  else provider.on('synced', onSynced)
  // 初次：容器隐藏时 RO 不触发，等显示后由 RO 驱动；若已可见立即铺一帧
  if (zone.getBoundingClientRect().width > 0) {
    fitWrap()
    resize()
  }
  setToolCursor()

  // ---- 导出 ----
  return {
    setShowNames(v) {
      showNames = !!v
      syncLabels()
    },
    destroy() {
      if (active) awareness.setLocalStateField('scratch', null)
      if (laserRaf) cancelAnimationFrame(laserRaf)
      if (laserPts.length) awareness.setLocalStateField('laser', null)
      if (provider) provider.off('synced', onSynced)
      scratchpages.unobserve(onPagesChange)
      pagemeta.unobserveDeep(onMetaChange)
      awareness.off('change', onAwarenessChange)
      pageObs.forEach((page) => page.unobserve(onPageContent))
      pageObs.clear()
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
      if (resizeObs) resizeObs.disconnect()
      window.removeEventListener('resize', resize)
      if (labelLayer) labelLayer.querySelectorAll('.yRemoteLabel').forEach((el) => el.remove())
      if (textLayer) textLayer.querySelectorAll('.scratch-text').forEach((el) => el.remove())
      textEls.clear()
      ctx.clearRect(0, 0, W, H)
    },
  }
}
