// monaco.worker.js — Monaco 语言服务的 Web Worker 引导文件
// 功能：AMD 版 Monaco 默认从 cdn 拉 worker，本地部署时路径不对。
//       此文件固定 worker 路径到本地 vendored workerMain.js，所有语言 worker
//       统一走它（编辑器核心编辑/高亮/查找不依赖具体语言 worker）。
// 依赖：vendor/monaco-editor-0.52.2/min/vs/base/worker/workerMain.js
// 可调参数：baseUrl（相对路径，指向 min/vs）
self.MonacoEnvironment = {
  baseUrl: self.location.origin + '/vendor/monaco-editor-0.52.2/min/vs'
}
importScripts(self.location.origin + '/vendor/monaco-editor-0.52.2/min/vs/base/worker/workerMain.js')
