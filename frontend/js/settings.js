// settings.js — 编辑器设置（字号/行高/主题/制表符）
// 功能：从 localStorage('vp_settings') 读取/保存设置；渲染设置弹层（⚙ 按钮打开），
//       控件变更即时应用并持久化。applyFn(editor, settings) 由调用方注入。
// 依赖：无（纯 DOM + localStorage）。可调参数：DEFAULTS。

export const SETTINGS_KEY = 'vp_settings'

export const DEFAULTS = {
  fontSize: 14, // 编辑器字号（px）
  lineHeight: 20, // 行高（px），自动布局用
  tabSize: 4, // 制表符宽度
  theme: 'dark', // 'dark' | 'light'
}

/** 读取设置（合并默认值 + 消毒非法值） */
export function loadSettings() {
  const out = { ...DEFAULTS }
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')
    if (typeof raw === 'object' && raw) {
      const n = (v, lo, hi, d) => {
        const x = Number(v)
        return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d
      }
      if (raw.fontSize != null) out.fontSize = n(raw.fontSize, 8, 48, DEFAULTS.fontSize)
      if (raw.lineHeight != null) out.lineHeight = n(raw.lineHeight, 12, 72, DEFAULTS.lineHeight)
      if (raw.tabSize != null) out.tabSize = n(raw.tabSize, 1, 16, DEFAULTS.tabSize)
      if (raw.theme === 'light' || raw.theme === 'dark') out.theme = raw.theme
    }
  } catch (e) { /* 损坏的 JSON 走默认值 */ }
  return out
}

/** 保存设置到 localStorage */
export function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)) } catch (e) { /* 忽略（隐私模式等） */ }
}

/**
 * 初始化设置弹层交互。
 * @param {import('./editor-setup.js')} editor Monaco 编辑器实例
 * @param {(ed:any, s:object)=>void} applyFn 应用设置的回调（会传入 loadSettings 的结果）
 */
export function initSettingsPanel(editor, applyFn) {
  const btn = document.getElementById('btn-settings')
  const pop = document.getElementById('settings-pop')
  if (!btn || !pop) return
  const toggle = (show) => {
    pop.classList.toggle('hidden', !show)
    btn.classList.toggle('active', show)
  }
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    toggle(pop.classList.contains('hidden'))
  })
  document.addEventListener('click', (e) => {
    if (!pop.classList.contains('hidden') && !pop.contains(e.target)) toggle(false)
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.classList.contains('hidden')) toggle(false)
  })
  // 控件：change → 读取全部 → 应用 + 保存
  const ids = {
    fontSize: 'set-font-size',
    lineHeight: 'set-line-height',
    theme: 'set-theme',
    tabSize: 'set-tab-size',
  }
  const read = () => ({
    fontSize: Number(document.getElementById(ids.fontSize).value),
    lineHeight: Number(document.getElementById(ids.lineHeight).value),
    theme: document.getElementById(ids.theme).value,
    tabSize: Number(document.getElementById(ids.tabSize).value),
  })
  Object.values(ids).forEach((id) => {
    const el = document.getElementById(id)
    if (el) el.addEventListener('change', () => {
      const s = read()
      saveSettings(s)
      applyFn(editor, s)
    })
  })
  // 弹层初始值 = 当前设置
  const s = loadSettings()
  document.getElementById(ids.fontSize).value = s.fontSize
  document.getElementById(ids.lineHeight).value = s.lineHeight
  document.getElementById(ids.theme).value = s.theme
  document.getElementById(ids.tabSize).value = s.tabSize
}
