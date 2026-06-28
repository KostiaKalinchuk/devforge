/* ── State ─────────────────────────────────────────────────────────────────── */
let tasks    = []
let projects = []
let activeProjectId = null
let ws = null

const COLUMNS = [
  { id: 'human-in',   label: '📥 Inbox',      statuses: ['inbox'], human: true },
  { id: 'pm',         label: '🧑 PM',          statuses: ['pm_active','pm_questioning'] },
  { id: 'architect',  label: '🏗 Architect',   statuses: ['architect_active'] },
  { id: 'dev',        label: '💻 Developer',   statuses: ['dev_active'] },
  { id: 'qa',         label: '🔍 QA',          statuses: ['qa_active'] },
  { id: 'tests',      label: '🧪 Tests',       statuses: ['tests_active'] },
  { id: 'review',     label: '👁 Review',      statuses: ['review_active'] },
  { id: 'human-out',  label: '✅ Done',        statuses: ['awaiting_acceptance','done','failed'], human: true, done: true },
]

const AGENT_LABELS = {
  pm: 'PM', architect: 'Architect', developer: 'Developer',
  qa: 'QA', tests: 'Tests', reviewer: 'Reviewer', orchestrator: 'System'
}

/* ── Init ───────────────────────────────────────────────────────────────────── */
async function init() {
  await loadProjects()
  await loadTasks()
  renderKanban()
  connectWS()
}

/* ── WebSocket ──────────────────────────────────────────────────────────────── */
function connectWS() {
  ws = new WebSocket(`ws://${location.host}`)
  ws.onopen = () => { document.getElementById('ws-dot').classList.add('connected') }
  ws.onclose = () => {
    document.getElementById('ws-dot').classList.remove('connected')
    setTimeout(connectWS, 3000)
  }
  ws.onmessage = e => {
    const msg = JSON.parse(e.data)
    if (msg.type === 'task_update' || msg.type === 'task_created') {
      const idx = tasks.findIndex(t => t.id === msg.task.id)
      if (idx >= 0) tasks[idx] = msg.task; else tasks.unshift(msg.task)
      renderKanban()
    }
  }
}

/* ── API ────────────────────────────────────────────────────────────────────── */
async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  return res.json()
}

async function loadProjects() {
  projects = await api('GET', '/projects')
  const sel = document.getElementById('project-select')
  sel.innerHTML = '<option value="">All projects</option>' +
    projects.map(p => `<option value="${p.id}">${p.name}</option>`).join('')
}

async function loadTasks() {
  const url = activeProjectId ? `/tasks?project_id=${activeProjectId}` : '/tasks'
  tasks = await api('GET', url)
}

/* ── Kanban render ──────────────────────────────────────────────────────────── */
function renderKanban() {
  const kanban = document.getElementById('kanban')
  kanban.innerHTML = ''

  COLUMNS.forEach(col => {
    const colTasks = tasks.filter(t =>
      col.statuses.includes(t.status) &&
      (!activeProjectId || t.project_id === activeProjectId)
    )
    const el = document.createElement('div')
    el.className = 'column' + (col.human ? ' human' : '') + (col.done ? ' done-col' : '')
    el.innerHTML = `
      <div class="col-header">
        <span class="dot"></span>${col.label}
        <span class="col-count">${colTasks.length}</span>
      </div>
      <div class="col-body" id="col-${col.id}"></div>
    `
    kanban.appendChild(el)

    const body = el.querySelector('.col-body')
    if (colTasks.length === 0) {
      body.innerHTML = '<div class="empty">—</div>'
    } else {
      colTasks.forEach(t => body.appendChild(makeCard(t)))
    }
  })
}

function makeCard(task) {
  const el = document.createElement('div')
  const isRunning = !['inbox','pm_questioning','awaiting_acceptance','done','failed'].includes(task.status)
  el.className = 'card' + (isRunning ? ' active-agent' : '')
  el.innerHTML = `
    <div class="card-title">${esc(task.title)}</div>
    <div class="card-meta">
      <span class="card-project">${esc(task.project_name || '')}</span>
      ${task.current_agent ? `<span class="card-agent"><span class="agent-icon">⚡</span>${AGENT_LABELS[task.current_agent]||task.current_agent}</span>` : ''}
      ${task.retry_count > 0 ? `<span class="card-retry">↩ retry ${task.retry_count}</span>` : ''}
      <span>${statusBadge(task.status)}</span>
    </div>
  `
  el.onclick = () => openTaskModal(task.id)
  return el
}

function statusBadge(status) {
  const map = {
    inbox:'inbox', pm_active:'pm', pm_questioning:'pm',
    architect_active:'architect', dev_active:'dev',
    qa_active:'qa', tests_active:'tests', review_active:'review',
    awaiting_acceptance:'awaiting', done:'done', failed:'failed'
  }
  const cls = map[status] || 'inbox'
  const labels = {
    inbox:'Inbox', pm_active:'PM running', pm_questioning:'Needs answers',
    architect_active:'Architect', dev_active:'Developing',
    qa_active:'QA testing', tests_active:'Writing tests', review_active:'Reviewing',
    awaiting_acceptance:'Review me', done:'Done', failed:'Failed'
  }
  return `<span class="badge badge-${cls}">${labels[status]||status}</span>`
}

/* ── Task modal ─────────────────────────────────────────────────────────────── */
async function openTaskModal(taskId) {
  const task = tasks.find(t => t.id === taskId)
  if (!task) return

  const modal = document.getElementById('task-modal')
  document.getElementById('modal-title').textContent = task.title
  document.getElementById('modal-status').innerHTML = statusBadge(task.status)
  modal.dataset.taskId = taskId
  modal.classList.add('open')

  // Show/hide action buttons
  document.getElementById('btn-start-task').style.display    = task.status === 'inbox' ? '' : 'none'
  document.getElementById('btn-accept-task').style.display   = task.status === 'awaiting_acceptance' ? '' : 'none'
  document.getElementById('btn-answer-pm').style.display     = task.status === 'pm_questioning' ? '' : 'none'
  document.getElementById('btn-cancel-task').style.display   = !['inbox','done','failed'].includes(task.status) ? '' : 'none'
  document.getElementById('btn-retry-task').style.display    = task.status === 'failed' ? '' : 'none'

  switchTab('logs')
  loadModalLogs(taskId)
}

async function loadModalLogs(taskId) {
  const logs = await api('GET', `/tasks/${taskId}/logs`)
  const el = document.getElementById('modal-logs')
  if (!logs.length) { el.innerHTML = '<div class="empty">No agent activity yet</div>'; return }
  el.innerHTML = '<div class="log-list">' + logs.map(l => `
    <div class="log-item ${l.status}">
      <div class="log-meta">${AGENT_LABELS[l.agent]||l.agent} · ${l.status} · ${timeAgo(l.created_at)}</div>
      <div class="log-msg">${esc(l.message||'').slice(0,300)}</div>
    </div>
  `).join('') + '</div>'
}

async function loadModalFiles(taskId) {
  const files = await api('GET', `/tasks/${taskId}/files`)
  const el = document.getElementById('modal-files')
  if (!files.length) { el.innerHTML = '<div class="empty">No files yet</div>'; return }
  el.innerHTML = '<div class="file-list">' + files.map(f => `
    <div class="file-item" onclick="viewFile('${taskId}','${f}')">
      <span class="file-icon">${f.endsWith('.md')?'📄':'📋'}</span>${esc(f)}
    </div>
  `).join('') + '</div>'
}

async function viewFile(taskId, filename) {
  const content = await fetch(`/api/tasks/${taskId}/files/${filename}`).then(r => r.text())
  const el = document.getElementById('modal-files')
  el.innerHTML = `
    <div style="margin-bottom:8px">
      <button class="btn-secondary" onclick="loadModalFiles('${taskId}')" style="font-size:11px;padding:4px 8px">← Back</button>
      <span style="font-size:12px;color:var(--text2);margin-left:8px">${esc(filename)}</span>
    </div>
    <div class="file-viewer">${esc(content)}</div>
  `
}

async function loadModalEvidence(taskId) {
  const files = await api('GET', `/tasks/${taskId}/evidence`)
  const el = document.getElementById('modal-evidence')
  if (!files.length) { el.innerHTML = '<div class="empty">No QA evidence yet</div>'; return }
  el.innerHTML = '<div class="evidence-grid">' + files.map(f => {
    const isVideo = f.name.endsWith('.mp4') || f.name.endsWith('.webm')
    const isImg   = f.name.match(/\.(png|jpg|jpeg|gif|webp)$/)
    const media   = isVideo
      ? `<video src="${f.url}" controls muted></video>`
      : isImg ? `<img src="${f.url}" alt="${esc(f.name)}">`
      : `<div style="height:90px;display:flex;align-items:center;justify-content:center;font-size:24px">📄</div>`
    return `<div class="evidence-item" onclick="window.open('${f.url}')">
      ${media}<div class="evidence-name">${esc(f.name)}</div>
    </div>`
  }).join('') + '</div>'
}

async function loadPMQuestions(taskId) {
  const questions = await api('GET', `/tasks/${taskId}/questions`)
  const el = document.getElementById('modal-questions')
  if (!questions.length) { el.innerHTML = '<div class="empty">No questions yet</div>'; return }
  el.innerHTML = '<div class="q-list">' + questions.map(q => `
    <div class="q-item" data-id="${q.id}">
      <label>${esc(q.question)}</label>
      <textarea placeholder="Your answer…">${esc(q.answer||'')}</textarea>
    </div>
  `).join('') + '</div>'

  // Restore drafts from localStorage and auto-save on input
  el.querySelectorAll('.q-item').forEach(item => {
    const qId = item.dataset.id
    const key = `pmDraft_${taskId}_${qId}`
    const ta = item.querySelector('textarea')
    if (!ta.value) {
      const saved = localStorage.getItem(key)
      if (saved) ta.value = saved
    }
    ta.addEventListener('input', () => localStorage.setItem(key, ta.value))
  })
}

/* ── Tab switching ──────────────────────────────────────────────────────────── */
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name))
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.id === 'pane-' + name))

  const taskId = document.getElementById('task-modal').dataset.taskId
  if (name === 'files')     loadModalFiles(taskId)
  if (name === 'evidence')  loadModalEvidence(taskId)
  if (name === 'questions') loadPMQuestions(taskId)
}

/* ── Actions ────────────────────────────────────────────────────────────────── */
async function startTask() {
  const id = document.getElementById('task-modal').dataset.taskId
  await api('POST', `/tasks/${id}/start`)
  closeModal('task-modal')
}

async function acceptTask() {
  const id = document.getElementById('task-modal').dataset.taskId
  await api('POST', `/tasks/${id}/accept`)
  closeModal('task-modal')
}

async function cancelTask() {
  if (!confirm('Cancel this task?')) return
  const id = document.getElementById('task-modal').dataset.taskId
  await api('POST', `/tasks/${id}/cancel`)
  closeModal('task-modal')
}

async function retryTask() {
  const id = document.getElementById('task-modal').dataset.taskId
  await api('POST', `/tasks/${id}/retry`)
  closeModal('task-modal')
}

async function submitAnswers() {
  const id = document.getElementById('task-modal').dataset.taskId
  const items = document.querySelectorAll('.q-item')
  const answers = Array.from(items).map(el => ({
    id: el.dataset.id,
    answer: el.querySelector('textarea').value
  }))
  await api('POST', `/tasks/${id}/questions/answers`, { answers })
  // Clear saved drafts
  items.forEach(el => localStorage.removeItem(`pmDraft_${id}_${el.dataset.id}`))
  closeModal('task-modal')
}

/* ── New task modal ─────────────────────────────────────────────────────────── */
function openNewTask() {
  const sel = document.getElementById('project-select')
  const projectId = sel.value || (projects[0]?.id || '')
  document.getElementById('new-project-id').value = projectId
  // Populate project dropdown in form
  document.getElementById('new-project-select').innerHTML =
    projects.map(p => `<option value="${p.id}" ${p.id===projectId?'selected':''}>${p.name}</option>`).join('')
  document.getElementById('new-task-modal').classList.add('open')
  document.getElementById('new-task-title').focus()
}

async function createTask() {
  const title = document.getElementById('new-task-title').value.trim()
  const desc  = document.getElementById('new-task-desc').value.trim()
  const projId = document.getElementById('new-project-select').value
  if (!title || !projId) return alert('Title and project are required')
  await api('POST', '/tasks', { project_id: projId, title, description: desc })
  closeModal('new-task-modal')
  document.getElementById('new-task-title').value = ''
  document.getElementById('new-task-desc').value = ''
}

/* ── Projects panel ─────────────────────────────────────────────────────────── */
function toggleProjects() {
  const panel = document.getElementById('projects-panel')
  panel.classList.toggle('open')
  if (panel.classList.contains('open')) renderProjectsPanel()
}

function renderProjectsPanel() {
  const body = document.getElementById('projects-body')
  if (!projects.length) { body.innerHTML = '<div class="empty">No projects yet</div>'; return }
  body.innerHTML = projects.map(p => `
    <div class="project-card">
      <h3>${esc(p.name)}</h3>
      <p>${esc(p.description||'')}</p>
      <div class="path">${esc(p.local_path)}</div>
    </div>
  `).join('')
}

function openAddProject() {
  document.getElementById('add-project-modal').classList.add('open')
}

async function saveProject() {
  const name     = document.getElementById('proj-name').value.trim()
  const path     = document.getElementById('proj-path').value.trim()
  const port     = document.getElementById('proj-port').value || '80'
  const health   = document.getElementById('proj-health').value || '/health'
  const testCmd  = document.getElementById('proj-test').value || 'php artisan test'
  const desc     = document.getElementById('proj-desc').value.trim()
  if (!name || !path) return alert('Name and path are required')
  await api('POST', '/projects', { name, local_path: path, internal_port: parseInt(port), health_check: health, test_command: testCmd, description: desc })
  await loadProjects()
  closeModal('add-project-modal')
  renderProjectsPanel()
  ;['proj-name','proj-path','proj-desc'].forEach(id => document.getElementById(id).value = '')
}

/* ── Helpers ────────────────────────────────────────────────────────────────── */
function closeModal(id) { document.getElementById(id).classList.remove('open') }

function esc(str) {
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

function timeAgo(unixSec) {
  const d = Math.floor(Date.now()/1000) - unixSec
  if (d < 60)  return `${d}s ago`
  if (d < 3600) return `${Math.floor(d/60)}m ago`
  return `${Math.floor(d/3600)}h ago`
}

document.getElementById('project-select').addEventListener('change', async e => {
  activeProjectId = e.target.value || null
  showKanban()
  await loadTasks()
  renderKanban()
})

init()

/* ── Stats ───────────────────────────────────────────────────────────────── */
function fmt$(v) {
  if (v == null || v === 0) return '—'
  return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`
}
function fmtK(v) { if (!v) return '—'; return v >= 1000 ? `${(v/1000).toFixed(1)}k` : String(v) }
function fmtMs(v) { if (!v) return '—'; return v >= 60000 ? `${(v/60000).toFixed(1)}m` : `${(v/1000).toFixed(1)}s` }
function fmtCtx(pct) {
  if (pct == null) return '—'
  const cls = pct < 50 ? 'ctx-green' : pct <= 80 ? 'ctx-yellow' : 'ctx-red'
  return `${pct.toFixed(1)}% <span class="ctx-bar ${cls}" style="width:${Math.min(pct,100)*0.6}px"></span>`
}

async function loadStats() {
  const data = await api('GET', '/stats')

  // Totals bar
  document.getElementById('stats-totals').innerHTML = `
    <div class="stats-section-title">ЗАГАЛЬНИЙ ПІДСУМОК</div>
    <div class="stats-total-item"><div class="stats-total-label">Total Cost</div><div class="stats-total-value">${fmt$(data.totals.cost_usd)}</div></div>
    <div class="stats-total-item"><div class="stats-total-label">Tokens In</div><div class="stats-total-value">${fmtK(data.totals.tokens_in)}</div></div>
    <div class="stats-total-item"><div class="stats-total-label">Tokens Out</div><div class="stats-total-value">${fmtK(data.totals.tokens_out)}</div></div>
    <div class="stats-total-item"><div class="stats-total-label">Agent Runs</div><div class="stats-total-value">${data.totals.runs}</div></div>
  `

  // By-agent table
  document.getElementById('stats-by-agent').innerHTML = `
    <div class="stats-section-title">НАЙДОРОЖЧІ АГЕНТИ</div>
    <table class="stats-table">
      <tr><th>Agent</th><th>Runs</th><th>Tokens In</th><th>Tokens Out</th><th>Cost</th></tr>
      ${data.by_agent.map(a => `
        <tr>
          <td>${esc(a.agent)}</td>
          <td>${a.runs}</td>
          <td>${fmtK(a.tokens_in)}</td>
          <td>${fmtK(a.tokens_out)}</td>
          <td>${fmt$(a.cost_usd)}</td>
        </tr>
      `).join('')}
    </table>
  `

  // By-task collapsible table
  const taskRows = data.by_task.map((task, i) => {
    const agentRows = task.agents.map(a => `
      <tr class="agent-row hidden" data-task-idx="${i}">
        <td style="padding-left:28px">↳ ${esc(a.agent)}</td>
        <td></td>
        <td>${fmtK(a.tokens_in)}</td>
        <td>${fmtK(a.tokens_out)}</td>
        <td>${fmt$(a.cost_usd)}</td>
        <td>${fmtMs(a.duration_ms)}</td>
        <td>${fmtCtx(a.context_pct)}</td>
      </tr>
    `).join('')
    return `
      <tr class="task-row" onclick="toggleTaskAgents(${i})">
        <td>▶ ${esc(task.title)}</td>
        <td>${task.runs}</td>
        <td>${fmtK(task.tokens_in)}</td>
        <td>${fmtK(task.tokens_out)}</td>
        <td>${fmt$(task.cost_usd)}</td>
        <td></td><td></td>
      </tr>
      ${agentRows}
    `
  }).join('')

  document.getElementById('stats-by-task').innerHTML = `
    <div class="stats-section-title">ПО ЗАДАЧАХ</div>
    <table class="stats-table">
      <tr><th>Task</th><th>Runs</th><th>Tokens In</th><th>Tokens Out</th><th>Cost</th><th>Duration</th><th>Context %</th></tr>
      ${taskRows || '<tr><td colspan="7" style="color:var(--text2);text-align:center;padding:20px">No agent runs yet</td></tr>'}
    </table>
  `
}

function toggleTaskAgents(idx) {
  document.querySelectorAll(`.agent-row[data-task-idx="${idx}"]`).forEach(row => {
    row.classList.toggle('hidden')
  })
}

function showStats() {
  document.getElementById('kanban').style.display = 'none'
  document.getElementById('stats-view').style.display = 'flex'
  document.getElementById('stats-view').style.flexDirection = 'column'
  document.getElementById('btn-stats').classList.add('active')
  loadStats()
}

function showKanban() {
  document.getElementById('kanban').style.display = 'flex'
  document.getElementById('stats-view').style.display = 'none'
  document.getElementById('btn-stats').classList.remove('active')
}

/* ── Notifications ──────────────────────────────────────────────────────────── */

// Request browser notification permission on load
function initNotifications() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission()
  }
}

function notify(title, body, isUrgent = false) {
  // 1. Browser notification
  if ('Notification' in window && Notification.permission === 'granted') {
    const n = new Notification(title, {
      body,
      icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🔨</text></svg>',
      tag: 'devforge',
      requireInteraction: isUrgent
    })
    n.onclick = () => { window.focus(); n.close() }
  }

  // 2. Sound (Web Audio API — no file needed)
  playChime(isUrgent)
}

function playChime(isUrgent) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const notes = isUrgent
      ? [523, 659, 784, 1047]   // C5 E5 G5 C6 — success fanfare
      : [440, 523]               // A4 C5 — soft ping

    let time = ctx.currentTime
    notes.forEach((freq, i) => {
      const osc  = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.frequency.value = freq
      osc.type = 'sine'
      gain.gain.setValueAtTime(0.18, time)
      gain.gain.exponentialRampToValueAtTime(0.001, time + 0.35)
      osc.start(time)
      osc.stop(time + 0.35)
      time += 0.18
    })
  } catch (_) {}
}

// Hook into WebSocket message handler — extend existing handler
const _origOnMessage = ws ? ws.onmessage : null
function hookNotifications() {
  if (!ws) return
  const prev = ws.onmessage
  ws.onmessage = e => {
    if (prev) prev(e)
    const msg = JSON.parse(e.data)
    if (msg.type === 'task_update') {
      const t = msg.task
      if (t.status === 'awaiting_acceptance') {
        notify('✅ DevForge — Ready for review', `"${t.title}" completed all stages`, true)
      } else if (t.status === 'failed') {
        notify('⚠️ DevForge — Task failed', `"${t.title}" needs attention`, true)
      } else if (t.status === 'pm_questioning') {
        notify('💬 DevForge — PM has questions', `"${t.title}" — open the task to answer`, false)
      }
    }
  }
}

// Init
initNotifications()
// Hook after WS connects (slight delay)
setTimeout(hookNotifications, 1000)
