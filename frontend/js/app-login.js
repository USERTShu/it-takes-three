// app-login.js — 登录页逻辑
// 功能：提交邀请码 → API.login → 保存 token/user → 跳转大厅。
// 依赖：auth.js、api.js。可调参数：无。
(function () {
  const form = document.getElementById('login-form')
  const codeInput = document.getElementById('invite-code')
  const errEl = document.getElementById('login-error')
  const btn = document.getElementById('btn-login')

  // 已登录直接进大厅
  if (Auth.getToken()) {
    location.href = '/lobby.html'
    return
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const code = codeInput.value.trim()
    if (!code) return
    errEl.classList.add('hidden')
    btn.disabled = true
    btn.textContent = '登录中…'
    try {
      const data = await API.login(code)
      Auth.save(data.token, data.user)
      location.href = '/lobby.html'
    } catch (err) {
      errEl.textContent = err.message || '登录失败'
      errEl.classList.remove('hidden')
      btn.disabled = false
      btn.textContent = '登录'
    }
  })
})()
