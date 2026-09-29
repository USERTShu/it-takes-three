// scratchpad.js — 协作草稿纸（多人画笔批注 + 多页 + 文本，实时同步）
// 功能：
//  - 画笔批注（按用户颜色区分，粗细 2/4/8/16），绘制中名称框（复用 .yRemoteLabel），
//    以线条为单位的橡皮擦除（选中擦除时光标变为橡皮擦），一键清空当前页；
//  - 多页：左侧页栏 新建/选择/删除（数据存 doc.getMap('scratchpages'): pageId -> Y.Map）；
//  - 文本：文本工具点击画布生成文本框（字体黑色），拖右下角手柄调大小（文本随之缩放），
//    Delete 删除文本框（双击进入编辑改文字，暂不支持其他文本功能）。
// 依赖：yjs（scratchpages Map）、y-protocols/awareness（scratch/page 预览字段）、cursors.css（.yRemoteLabel）。
// 可调参数：initScratchpad({doc, awareness, getShowNames}) → {setShowNames(v), destroy()}。

import * as Y from 'yjs'

const W = 1200 // 虚拟坐标系：固定 1200×800，画布按实际尺寸缩放，坐标始终在虚拟系运算
const H = 800
const ERASE_THRESHOLD = 12 // 擦除命中阈值（虚拟 px）：点到折线最小距离
const PREVIEW_ALPHA = 0.45 // 远端绘制中预览透明度
const TEXT_DEFAULT_W = 140 // 新建文本框默认宽（虚拟 px）
const TEXT_DEFAULT_H = 44 // 新建文本框默认高（虚拟 px，字号基准：fs = 16 * h / 44）
const TEXT_BASE_FS = 16

// 橡皮擦光标（SVG data URI，热点在橡皮左下尖端）
const ERASER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><rect x="3" y="5" width="13" height="15" rx="2" fill="#f8bbd0" stroke="#ad1457" stroke-width="1"/><rect x="5" y="8" width="9" height="4" rx="1" fill="#ffffff"/><rect x="3" y="14" width="13" height="6" rx="1" fill="#ec407a"/></svg>'
const ERASER_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(ERASER_SVG)}") 4 5, crosshair`

/**
 * 初始化协作草稿纸。
 * @param {{doc: Y.Doc, awareness: import('y-protocols/awareness').Awareness, getShowNames: Function}} opts
 * @returns {{setShowNames: Function, destroy: Function}}
 */
export function initScratchpad({ doc, awareness, getShowNames }) {
  const annotations = doc.getMap('annotations') // 旧数据（迁移到多页结构后不再使用）
  const scratchpages = doc.getMap('scratchpages') // pageId -> Y.Map（页内对象）
  const container = document.getElementById('scratchpad-container')
  const canvas = document.getElementById('scratch-canvas')
  const ctx = canvas.getContext('2d')
  const zone = container.querySelector('.scratchpad-canvas-zone')
  const wrap = container.querySelector('.scratchpad-canvas-wrap')
  const labelLayer = container.querySelector('.scratchpad-label-layer')
  const textLayer = document.getElementById('scratch-text-layer')
  const pageListEl = document.getElementById('scratch-page-list')

  let showNames = getShowNames ? getShowNames() : true // 名称框开关（与编辑器名称开关同步）
  let tool = 'pen' // 'pen' | 'eraser' | 'text'
  let width = 2 // 当前线宽
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
  const pageObs = new Map() // 页 key -> Y.Map observe 返回的监听器（用于 destroy 清理）

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
    }
    ctx.setTransform(pxW / W, 0, 0, pxH / H, 0, 0)
    paintFull()
  }

  // 画布区可用空间驱动缩放：等比（1200:800）取能同时塞下宽高的最大尺寸，防止超高/超宽
  function fitWrap() {
    const z = zone.getBoundingClientRect()
    const availW = Math.max(0, z.width - 32)
    const availH = Math.max(0, z.height - 32)
    let w = Math.min(availW, availH * (W / H))
    wrap.style.width = Math.max(200, w) + 'px'
    wrap.style.height = (wrap.clientWidth * H / W) + 'px'
  }

  // ---- 折线绘制（pts 为普通数组：length + 下标访问） ----
  function drawPoints(pts, color, w, alpha) {
    const n = pts.length
    ctx.globalAlpha = alpha
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (n < 4) {
      if (n >= 2) { // 单点落笔：圆点，让"点一下"也有可见反馈
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(pts[0], pts[1], Math.max(1, w / 2), 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
      return
    }
    ctx.strokeStyle = color
    ctx.lineWidth = w
    ctx.beginPath()
    ctx.moveTo(pts[0], pts[1])
    for (let i = 2; i < n; i += 2) ctx.lineTo(pts[i], pts[i + 1])
    ctx.stroke()
    ctx.globalAlpha = 1
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

  // ---- 全量重绘：本页已提交笔画 + 远端绘制中预览 + 本端绘制中笔画 + 文本层 ----
  // 注意：页内对象经 Yjs ContentAny 原样存取（普通对象/数组），用 s.p / s.c 下标访问；
  //       文本对象由 syncTexts 渲染为 HTML 元素，不画在 canvas 上。
  function paintFull() {
    ctx.clearRect(0, 0, W, H)
    const page = currentMap()
    if (page) {
      page.forEach((obj) => {
        if (obj.type === 'text') return
        drawPoints(obj.p, obj.c, obj.w, 1)
      })
    }
    if (awareness) {
      awareness.getStates().forEach((state, cid) => {
        if (cid === doc.clientID) return // 跳过本端预览（由 active 绘制）
        const item = previewItemFor(cid, state)
        if (item) drawPoints(item.p, item.color, item.w, PREVIEW_ALPHA)
      })
    }
    if (active && active.p.length >= 2) drawPoints(active.p, active.c, active.w, 1)
    syncTexts()
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
    if (tool === 'pen') {
      seq++
      const me = awareness.getLocalState() || {}
      const user = me.user || {}
      active = {
        id: `${doc.clientID}-${seq}`,
        u: user.name || '匿名',
        c: user.color || '#888',
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
    if (tool === 'pen' && active) {
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
    erasing = false
    if (canvas.hasPointerCapture && canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId)
    }
    syncLabels()
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

  // ---- 多页：新建 / 切换 / 删除 / 渲染列表 ----
  function ensurePages() {
    if (scratchpages.size > 0) return
    // 迁移旧单页数据（annotations）到第一页 p1
    doc.transact(() => {
      const p1 = new Y.Map()
      annotations.forEach((s, id) => {
        p1.set(id, { id, type: 'stroke', u: s.u, c: s.c, w: s.w, p: s.p })
      })
      scratchpages.set('p1', p1)
    }, 'scratchpad-init')
  }

  function createPage() {
    seqText++ // 复用序号保证 id 唯一即可
    const id = `p${Date.now().toString(36)}-${seqText}`
    const page = new Y.Map()
    scratchpages.set(id, page)
    attachPageObs(id)
    switchPage(id)
  }

  function deletePage(id) {
    if (scratchpages.size <= 1) return // 至少保留一页
    scratchpages.delete(id) // 触发 onPagesChange：刷新列表 + 若删除的是当前页则回退第一页
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
    requestPaint()
  }

  function renderPages() {
    if (!pageListEl) return
    pageListEl.innerHTML = ''
    const ids = Array.from(scratchpages.keys())
    ids.forEach((id, idx) => {
      const row = document.createElement('div')
      row.className = 'scratchpad-page' + (id === currentPage ? ' active' : '')
      row.dataset.page = id
      const name = document.createElement('span')
      name.textContent = `页 ${idx + 1}`
      const del = document.createElement('button')
      del.className = 'del'
      del.textContent = '✕'
      del.title = '删除此页'
      del.addEventListener('click', (e) => {
        e.stopPropagation()
        if (window.confirm(`删除 页 ${idx + 1}？`)) deletePage(id)
      })
      row.appendChild(name)
      row.appendChild(del)
      row.addEventListener('click', () => switchPage(id))
      pageListEl.appendChild(row)
    })
  }

  // ---- 监听：页集合变化 / 当前页内容变化 → 合并到下一帧全量重绘 ----
  const requestPaint = () => {
    if (pendingPaint) return
    pendingPaint = true
    requestAnimationFrame(() => {
      pendingPaint = false
      paintFull()
    })
  }
  const onPageContent = (event) => {
    // 只重绘当前页的内容变化（event.target 是发生变化的 Y.Map）
    if (event.target === currentMap()) requestPaint()
  }
  // 为一个页 attach 内容监听（幂等：避免重复 observe → 事件双触发）
  function attachPageObs(id) {
    const page = scratchpages.get(id)
    if (!page || typeof page.observe !== 'function' || pageObs.has(id)) return
    pageObs.set(id, page.observe(onPageContent))
  }

  const onPagesChange = (event) => {
    // 新页加入时 attach 其内容监听
    if (event.keysChanged) {
      event.keysChanged.forEach((k) => attachPageObs(k))
    }
    // 当前页被删除（本端或远端）→ 回退到第一页并广播
    if (currentPage && !scratchpages.has(currentPage)) {
      const first = scratchpages.keys().next().value
      if (first) {
        currentPage = first
        awareness.setLocalStateField('page', first)
      }
    }
    renderPages()
    requestPaint()
  }

  scratchpages.observe(onPagesChange)
  awareness.on('change', onAwarenessChange)

  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', onPointerUp)
  canvas.addEventListener('pointercancel', onPointerUp)

  function onAwarenessChange() { requestPaint() }

  // ---- 工具栏 ----
  const setToolCursor = () => {
    canvas.style.cursor = tool === 'pen' ? 'crosshair' : tool === 'eraser' ? ERASER_CURSOR : 'text'
  }
  const toolBtns = container.querySelectorAll('.scratchpad-tool[data-tool]')
  toolBtns.forEach((b) => {
    b.addEventListener('click', () => {
      if (editingId) { // 切工具时结束文本编辑
        const el = textEls.get(editingId)
        if (el) endEdit(el, editingId)
      }
      tool = b.dataset.tool
      toolBtns.forEach((x) => x.classList.toggle('active', x === b))
      setToolCursor()
    })
  })
  const widthBtns = container.querySelectorAll('.scratchpad-width[data-width]')
  widthBtns.forEach((b) => {
    b.addEventListener('click', () => {
      width = Number(b.dataset.width)
      widthBtns.forEach((x) => x.classList.toggle('active', x === b))
    })
  })
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
  ensurePages()
  // 本端当前页：优先 awareness 已存值（其他端翻页互不影响），否则默认第一页
  const savedPage = awareness.getLocalState() && awareness.getLocalState().page
  currentPage = savedPage && scratchpages.has(savedPage) ? savedPage : scratchpages.keys().next().value
  awareness.setLocalStateField('page', currentPage)
  // attach 现有页内容监听（幂等去重）
  Array.from(scratchpages.keys()).forEach(attachPageObs)
  renderPages()
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
      scratchpages.unobserve(onPagesChange)
      awareness.off('change', onAwarenessChange)
      scratchpages.forEach((page, id) => {
        const l = pageObs.get(id)
        if (l && typeof page.unobserve === 'function') page.unobserve(l)
      })
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
