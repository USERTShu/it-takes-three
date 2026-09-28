// debugger.js — 断点/当前行装饰（Monaco glyph margin）+ 调试会话客户端
// 功能：
//   BreakpointManager：点击 glyph margin 切换断点（红点）、当前执行行高亮（黄色箭头）；
//   DebugSession：连接 /ws/contest/{slug}/debug，断点/继续/单步/变量/调用栈等命令转发。
// 依赖：window.monaco（AMD 加载后全局）。可调参数：无。
// 协议：见 .for_human_dev.md「5. 运行/调试协议」。

// ---- 断点与当前行装饰 ----

export class BreakpointManager {
  /**
   * @param {monaco.editor.IStandaloneCodeEditor} editor
   * @param {(line:number, enabled:boolean) => void} [onToggle] 切换断点时回调
   */
  constructor(editor, onToggle) {
    this.editor = editor
    this.onToggle = onToggle || null
    this.bps = new Set() // 行号集合
    this.decoIds = [] // 断点装饰 id（随 model 变化失效，需重渲染）
    this.curDecoId = [] // 当前行装饰 id
    this._sub = editor.onMouseDown((e) => {
      if (!e.target) return
      const t = e.target.type
      const mt = window.monaco.editor.MouseTargetType
      if (t === mt.GUTTER_GLYPH_MARGIN) {
        this.toggle(e.target.position.lineNumber)
      } else if (t === mt.GUTTER_LINE_NUMBERS) {
        // 断点图标已通过 CSS translateX(15px) 右移到行号列留白区，而 Monaco 的
        // glyph margin 命中区只有 20px，点图标右半（280+）时 target 是行号列、
        // 不会触发切换。这里把行号数字左侧的留白区也纳入点击区：
        // 点击图标附近（红点视觉区域 + 留白）都能切换，点击数字本身不切换。
        const line = e.target.position.lineNumber
        const x = e.event?.browserEvent?.clientX ?? -1
        const el = this._findLineNumberEl(line)
        if (el) {
          const tn = [...el.childNodes].find((n) => n.nodeType === 3) || el
          const rng = document.createRange()
          rng.selectNodeContents(tn)
          if (x < rng.getBoundingClientRect().left) this.toggle(line)
        } else {
          this.toggle(line)
        }
      }
    })
  }

  /** 查找指定行的 .line-numbers 元素（用于判定点击是否在数字左侧） */
  _findLineNumberEl(line) {
    const root = this.editor.getDomNode()
    if (!root) return null
    const want = String(line)
    for (const el of root.querySelectorAll('.line-numbers')) {
      if (el.textContent.trim() === want) return el
    }
    return null
  }

  has(line) { return this.bps.has(line) }

  toggle(line) {
    if (this.bps.has(line)) this.bps.delete(line)
    else this.bps.add(line)
    const enabled = this.bps.has(line)
    this.render()
    if (this.onToggle) this.onToggle(line, enabled)
    return enabled
  }

  clear() {
    this.bps.clear()
    this.render()
  }

  /** 以服务端为准同步断点（调试会话内 gdb 是事实源） */
  syncFromServer(lines) {
    const next = new Set((lines || []).map((x) => (typeof x === 'number' ? x : x.line)))
    if (JSON.stringify([...this.bps].sort((a, b) => a - b)) ===
        JSON.stringify([...next].sort((a, b) => a - b))) return
    this.bps = next
    this.render()
  }

  render() {
    const model = this.editor.getModel()
    const monaco = window.monaco
    if (!model || !monaco) { this.decoIds = []; return }
    const ds = []
    for (const line of this.bps) {
      if (line >= 1 && line <= model.getLineCount()) {
        ds.push({
          range: new monaco.Range(line, 1, line, 1),
          options: { glyphMarginClassName: 'vp-breakpoint-glyph' },
        })
      }
    }
    this.decoIds = this.editor.deltaDecorations(this.decoIds, ds)
  }

  /** 设置当前执行行（null 清除） */
  setCurrentLine(line) {
    const model = this.editor.getModel()
    const monaco = window.monaco
    if (!model || !monaco) { this.curDecoId = []; return }
    const valid = line && line >= 1 && line <= model.getLineCount()
    const ds = valid
      ? [{
          range: new monaco.Range(line, 1, line, model.getLineMaxColumn(line)),
          options: {
            isWholeLine: true,
            className: 'vp-current-line',
            glyphMarginClassName: 'vp-current-line-glyph',
          },
        }]
      : []
    this.curDecoId = this.editor.deltaDecorations(this.curDecoId, ds)
    if (valid) this.editor.revealLineInCenterIfOutsideViewport(line)
  }

  clearCurrentLine() { this.setCurrentLine(null) }

  destroy() {
    try { this._sub.dispose() } catch (e) { /* 忽略 */ }
  }
}

// ---- 调试会话客户端 ----

export class DebugSession {
  /**
   * @param {string} slug
   * @param {string} token
   * @param {object} cb 回调：
   *   onOpen / onClose / onError / onCompile(ok,error) / onStdout(data) / onStderr(data)
   *   onState(state) / onExit(info) / onStack(list) / onVars(list) / onBreakpoints(list)
   *   onWatch(list)（自定义监控表达式求值结果）
   */
  constructor(slug, token, cb) {
    this.slug = slug
    this.token = token
    this.cb = cb || {}
    this.ws = null
    this.active = false
    this._buf = [] // WS 未就绪时缓冲的消息（connect 后立即 start 的场景）
  }

  connect() {
    if (this.ws) return
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${proto}//${location.host}/ws/contest/${encodeURIComponent(this.slug)}/debug?token=${encodeURIComponent(this.token)}`
    const ws = new WebSocket(url)
    this.ws = ws
    ws.onopen = () => {
      this.active = true
      const buf = this._buf
      this._buf = []
      for (const obj of buf) this.send(obj)
      if (this.cb.onOpen) this.cb.onOpen()
    }
    ws.onerror = () => {
      this.active = false
      if (this.cb.onError) this.cb.onError()
    }
    ws.onclose = () => {
      this.active = false
      this.ws = null
      if (this.cb.onClose) this.cb.onClose()
    }
    ws.onmessage = (e) => {
      let msg
      try { msg = JSON.parse(e.data) } catch { return }
      const cb = this.cb
      switch (msg.t) {
        case 'compile': cb.onCompile && cb.onCompile(msg.ok, msg.error); break
        case 'stdout': cb.onStdout && cb.onStdout(msg.data); break
        case 'stderr': cb.onStderr && cb.onStderr(msg.data); break
        case 'state': cb.onState && cb.onState(msg); break
        case 'exit': cb.onExit && cb.onExit(msg); break
        case 'stack': cb.onStack && cb.onStack(msg.stack || []); break
        case 'vars': cb.onVars && cb.onVars(msg.vars || []); break
        case 'breakpoints': cb.onBreakpoints && cb.onBreakpoints(msg.list || []); break
        case 'watch': cb.onWatch && cb.onWatch(msg.results || []); break
        case 'closed': cb.onClosed && cb.onClosed(); break
      }
    }
  }

  start(path) { this.send({ t: 'start', path }) }
  break(line) { this.send({ t: 'break', line }) }
  breakDel(line) { this.send({ t: 'breakDel', line }) }
  /** 请求对表达式列表求值（gdb 处于 stopped 状态时有效） */
  watch(exprs) { this.send({ t: 'watch', exprs }) }
  cmd(name, extra) { this.send(Object.assign({ t: name }, extra || {})) }
  sendStdin(data) { this.send({ t: 'stdin', data }) }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj))
    } else {
      this._buf.push(obj)
    }
  }

  close() {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }
}
