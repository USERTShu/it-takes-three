// yjs-setup.js — Yjs 协作数据层（ES 模块）
// 功能：创建 Y.Doc + "files" map + WebsocketProvider + awareness；
//       文件增删（主路径：直接 CRDT 操作，provider 自动广播增量）。
// 依赖：yjs、y-websocket、y-protocols（经 editor.html importmap 映射到 vendor）。
// 可调参数：无（房间名固定为 contest/{slug}，token 走 query）。
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { Awareness } from 'y-protocols/awareness'

/**
 * 建立与后端比赛的实时连接。
 * @param {string} slug 比赛 slug
 * @param {string} token 登录 token（query 携带，后端校验）
 * @param {{display_name:string, username:string, color:string}} user 本地用户信息（含服务端分配的颜色）
 * @returns {{doc:Y.Doc, filesMap:Y.Map, awareness:Awareness, provider:WebsocketProvider}}
 */
export function setupYjs(slug, token, user) {
  const doc = new Y.Doc()
  const filesMap = doc.getMap('files')
  const awareness = new Awareness(doc)
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const provider = new WebsocketProvider(
    `${protocol}//${location.host}/ws`,
    `contest/${slug}`,
    doc,
    { params: { token }, awareness },
  )
  // 广播本地身份：名字 + 服务端分配的颜色（光标/标签用）
  awareness.setLocalStateField('user', {
    name: user.display_name || user.username || '匿名',
    color: user.color || '#888888',
  })
  return { doc, filesMap, awareness, provider }
}

/** 新建文件（已存在返回 false）。 */
export function createFile(filesMap, path, content = '') {
  if (filesMap.has(path)) return false
  filesMap.set(path, new Y.Text(content))
  return true
}

/** 删除文件（不存在返回 false）。 */
export function deleteFile(filesMap, path) {
  if (!filesMap.has(path)) return false
  filesMap.delete(path)
  return true
}
