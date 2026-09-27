// runner.js — 交互式运行会话客户端（WS：/ws/contest/{slug}/run）
// 功能：连接运行端点，start 编译运行、sendStdin 交互输入、kill 终止；
//       服务端事件（compile/stdout/stderr/exit）经回调通知 UI。
// 依赖：无（原生 WebSocket）。可调参数：无。
// 协议：见 .for_human_dev.md「5. 运行/调试协议」。

export class RunSession {
  /**
   * @param {string} slug 比赛 slug
   * @param {string} token 会话 token
   * @param {object} cb 回调：onOpen / onClose / onCompile(ok,error) / onStdout(data) / onStderr(data) / onExit(info)
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
    const url = `${proto}//${location.host}/ws/contest/${encodeURIComponent(this.slug)}/run?token=${encodeURIComponent(this.token)}`
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
        case 'exit': cb.onExit && cb.onExit(msg); break
      }
    }
  }

  start(path) { this.send({ t: 'start', path }) }
  sendStdin(data) { this.send({ t: 'stdin', data }) }
  kill() { this.send({ t: 'kill' }) }

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
