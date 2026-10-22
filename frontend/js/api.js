// api.js — REST API 封装（全局 API）
// 功能：统一 fetch 封装（自动带 Authorization: Bearer），并提供登录/比赛/文件接口。
// 依赖：auth.js（Auth.getToken）。可调参数：无（API 前缀固定为 /api）。
const API_BASE = '/api'
// 页面固定使用的 token（编辑器页加载时捕获）：多标签页共享 localStorage，
// 其他标签登录别的账号会覆盖它，不固定的话本页请求会串成别人的身份。
let pinnedToken = null

async function request(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  const token = pinnedToken || Auth.getToken()
  if (token) headers['Authorization'] = `Bearer ${token}`
  const resp = await fetch(API_BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let data = null
  try {
    data = await resp.json()
  } catch (e) {
    /* 响应体非 JSON */
  }
  // 登录过期/失效：清掉本地登录态回登录页（否则页面只会反复报错，用户找不到出路）
  if (resp.status === 401 && path !== '/auth/login') {
    if (token === Auth.getToken()) Auth.clear() // 本地存的已是别的账号（其他标签登录）时不误删
    location.href = '/login.html'
  }
  if (!resp.ok) {
    const err = new Error((data && data.detail) || `请求失败（HTTP ${resp.status}）`)
    err.status = resp.status
    throw err
  }
  return data
}

const API = {
  pinToken: (token) => { pinnedToken = token },
  login: (inviteCode) => request('/auth/login', { method: 'POST', body: { invite_code: inviteCode } }),
  me: () => request('/auth/me'),
  createContest: (name, slug, durationMinutes) =>
    request('/contests', { method: 'POST', body: { name, slug, duration_minutes: durationMinutes } }),
  listContests: () => request('/contests'),
  getContest: (slug) => request(`/contests/${encodeURIComponent(slug)}`),
  joinContest: (slug) => request(`/contests/${encodeURIComponent(slug)}/join`, { method: 'POST' }),
  startContest: (slug) => request(`/contests/${encodeURIComponent(slug)}/start`, { method: 'POST' }),
  transferCaptain: (slug, userId) =>
    request(`/contests/${encodeURIComponent(slug)}/captain`, { method: 'POST', body: { user_id: userId } }),
  listFiles: (slug) => request(`/contests/${encodeURIComponent(slug)}/files`),
  readFile: (slug, path) => request(`/contests/${encodeURIComponent(slug)}/files/${encodeURIComponent(path)}`),
  writeFile: (slug, path, content) =>
    request(`/contests/${encodeURIComponent(slug)}/files/${encodeURIComponent(path)}`, { method: 'POST', body: { content } }),
  deleteFile: (slug, path) =>
    request(`/contests/${encodeURIComponent(slug)}/files/${encodeURIComponent(path)}`, { method: 'DELETE' }),
}
