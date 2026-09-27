// auth.js — 登录态管理（全局 Auth）
// 功能：token/user 的 localStorage 存取；页面鉴权跳转（无 token 回登录页）。
// 依赖：无。可调参数：存储键名固定（vp_token / vp_user）。
const KEY_TOKEN = 'vp_token'
const KEY_USER = 'vp_user'

const Auth = {
  getToken() {
    return localStorage.getItem(KEY_TOKEN)
  },
  getUser() {
    try {
      return JSON.parse(localStorage.getItem(KEY_USER)) || null
    } catch (e) {
      return null
    }
  },
  save(token, user) {
    localStorage.setItem(KEY_TOKEN, token)
    localStorage.setItem(KEY_USER, JSON.stringify(user))
  },
  clear() {
    localStorage.removeItem(KEY_TOKEN)
    localStorage.removeItem(KEY_USER)
  },
  requireAuth() {
    if (!this.getToken()) {
      location.href = '/login.html'
      return false
    }
    return true
  },
}
