// api.js — REST API 封装（全局 API）
// 功能：统一 fetch 封装（自动带 Authorization: Bearer），并提供登录/比赛/文件接口。
// 依赖：auth.js（Auth.getToken）。可调参数：无（API 前缀固定为 /api）。
const API_BASE = '/api'

async function request(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  const token = Auth.getToken()
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
  if (!resp.ok) {
    const err = new Error((data && data.detail) || `请求失败（HTTP ${resp.status}）`)
    err.status = resp.status
    throw err
  }
  return data
}

const API = {
  login: (inviteCode) => request('/auth/login', { method: 'POST', body: { invite_code: inviteCode } }),
  me: () => request('/auth/me'),
  createContest: (name, slug, durationMinutes) =>
    request('/contests', { method: 'POST', body: { name, slug, duration_minutes: durationMinutes } }),
  listContests: () => request('/contests'),
  getContest: (slug) => request(`/contests/${encodeURIComponent(slug)}`),
  joinContest: (slug) => request(`/contests/${encodeURIComponent(slug)}/join`, { method: 'POST' }),
  startContest: (slug) => request(`/contests/${encodeURIComponent(slug)}/start`, { method: 'POST' }),
  listFiles: (slug) => request(`/contests/${encodeURIComponent(slug)}/files`),
  readFile: (slug, path) => request(`/contests/${encodeURIComponent(slug)}/files/${encodeURIComponent(path)}`),
  writeFile: (slug, path, content) =>
    request(`/contests/${encodeURIComponent(slug)}/files/${encodeURIComponent(path)}`, { method: 'POST', body: { content } }),
  deleteFile: (slug, path) =>
    request(`/contests/${encodeURIComponent(slug)}/files/${encodeURIComponent(path)}`, { method: 'DELETE' }),
}
