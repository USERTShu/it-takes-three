// app-lobby.js — 大厅页逻辑
// 功能：创建/加入比赛、展示我的比赛列表（含状态/成员/分享链接），
//       创建者可开始比赛并分配颜色；已开始可进入编辑器。
// 依赖：auth.js、api.js。可调参数：无。
(function () {
  if (!Auth.requireAuth()) return
  const me = Auth.getUser()
  const listEl = document.getElementById('contest-list')
  const createForm = document.getElementById('create-form')
  const createErr = document.getElementById('create-error')
  const joinForm = document.getElementById('join-form')
  const joinErr = document.getElementById('join-error')

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  }

  function fmtTime(t) {
    if (!t) return ''
    const d = new Date(t)
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }

  function linkOf(slug) {
    return `${location.origin}/editor.html?slug=${encodeURIComponent(slug)}`
  }

  async function refresh() {
    try {
      const contests = await API.listContests()
      render(contests)
    } catch (err) {
      listEl.innerHTML = `<div class="error">${esc(err.message)}</div>`
    }
  }

  function render(contests) {
    if (!contests.length) {
      listEl.innerHTML = '<div class="empty">还没有比赛，创建或加入一个吧。</div>'
      return
    }
    listEl.innerHTML = contests.map((c) => {
      const members = (c.members || []).map((m) => {
        const color = m.color || '#888'
        return `<span class="member-chip"><span class="dot" style="background:${color}"></span>${esc(m.display_name || m.username || `#${m.user_id}`)}</span>`
      }).join('')
      const statusCls = `status-tag ${c.status === 'started' ? 'started' : ''}`
      let actions = ''
      if (c.status === 'created') {
        if (c.creator_id === me.id) {
          actions += `<button class="btn small" data-action="start" data-slug="${esc(c.slug)}">开始比赛</button>`
        }
        actions += `<button class="btn small" data-action="enter" data-slug="${esc(c.slug)}">进入（等待开始）</button>`
      } else {
        actions += `<button class="btn small primary" data-action="enter" data-slug="${esc(c.slug)}">进入编辑器</button>`
      }
      return `
        <div class="contest-item">
          <div class="row1">
            <span class="name">${esc(c.name)}</span>
            <span class="slug">${esc(c.slug)}</span>
            <span class="${statusCls}">${c.status === 'started' ? '已开始' : c.status === 'finished' ? '已结束' : '未开始'}</span>
            ${c.status === 'started' ? `<span class="slug">开始于 ${fmtTime(c.start_time)}</span>` : ''}
            <span class="actions">${actions}</span>
          </div>
          <div class="member-chips">成员：${members}</div>
          <div class="member-chips">分享链接：<span class="link-copy" data-action="copy" data-link="${esc(linkOf(c.slug))}">${esc(linkOf(c.slug))}</span></div>
        </div>`
    }).join('')
  }

  // 事件委托
  listEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]')
    if (!btn) return
    const { action, slug, link } = btn.dataset
    if (action === 'copy') {
      try {
        await navigator.clipboard.writeText(link)
        btn.textContent = '已复制'
        setTimeout(() => btn.textContent = link, 1200)
      } catch (err) {
        window.prompt('复制链接：', link)
      }
    } else if (action === 'enter') {
      location.href = `/editor.html?slug=${encodeURIComponent(slug)}`
    } else if (action === 'start') {
      btn.disabled = true
      try {
        await API.startContest(slug)
        await refresh()
      } catch (err) {
        alert(err.message)
        btn.disabled = false
      }
    }
  })

  createForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    createErr.classList.add('hidden')
    const name = document.getElementById('contest-name').value.trim()
    const slug = document.getElementById('contest-slug').value.trim().toLowerCase()
    const duration = parseInt(document.getElementById('contest-duration').value, 10) || 300
    if (!/^[a-z0-9-]+$/.test(slug)) {
      createErr.textContent = 'slug 只能包含小写字母、数字、连字符'
      createErr.classList.remove('hidden')
      return
    }
    try {
      await API.createContest(name, slug, duration)
      createForm.reset()
      document.getElementById('contest-duration').value = 300
      await refresh()
    } catch (err) {
      createErr.textContent = err.message
      createErr.classList.remove('hidden')
    }
  })

  joinForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    joinErr.classList.add('hidden')
    const slug = document.getElementById('join-slug').value.trim().toLowerCase()
    if (!slug) return
    try {
      await API.joinContest(slug)
      location.href = `/editor.html?slug=${encodeURIComponent(slug)}`
    } catch (err) {
      joinErr.textContent = err.message
      joinErr.classList.remove('hidden')
    }
  })

  document.getElementById('user-info').textContent = me ? me.display_name || me.username : ''
  document.getElementById('btn-logout').addEventListener('click', () => {
    Auth.clear()
    location.href = '/login.html'
  })

  refresh()
  setInterval(refresh, 10000)
})()
