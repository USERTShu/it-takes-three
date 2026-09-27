// monaco-shim.js — y-monaco 的 AMD 适配垫片
// 功能：y-monaco 原代码 import 'monaco-editor/esm/vs/editor/editor.api.js'（ESM 版，
//       与 AMD 加载的 Monaco 冲突）。运行时仅使用以下 3 个公开符号，这里从
//       AMD 版加载后挂到 globalThis.monaco 的对象上导出。
// 依赖：全局 window.monaco（由 loader.js + editor.main.js 注入）
// 可调参数：无
const m = globalThis.monaco
export const Range = m.Range
export const Selection = m.Selection
export const SelectionDirection = m.SelectionDirection
