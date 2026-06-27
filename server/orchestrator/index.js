const { db } = require('../db')
const context      = require('./context')
const sm           = require('./state-machine')
const envManager   = require('../environment/manager')
const { createAdapter } = require('../runner/adapters/claude-code')
const { v4: uuid } = require('uuid')
const gitHelper    = require('./git')

const { exec } = require('child_process')
const fs = require('fs')

const WORKTREE_STATUSES = new Set(['dev_active', 'qa_active', 'tests_active', 'review_active'])

function macNotify(title, body) {
  // macOS system notification — works even when browser is closed
  const safe = s => s.replace(/'/g, '\'')
  exec(`osascript -e 'display notification "${safe(body)}" with title "${safe(title)}" sound name "Glass"'`,
    err => { if (err) console.warn('[notify] osascript failed:', err.message) })
}


let broadcast = () => {}   // set by server/index.js

function setBroadcast(fn) { broadcast = fn }

const runner = createAdapter()

const inFlight = new Set() // task IDs currently being processed

// ─── Main polling loop ────────────────────────────────────────────────────────

function startLoop(intervalMs = 5000) {
  setInterval(tick, intervalMs)
  console.log(`[orchestrator] polling every ${intervalMs}ms`)
}

async function tick() {
  const activeTasks = db.prepare(`
    SELECT tasks.*, projects.local_path, projects.internal_port,
           projects.health_check, projects.test_command,
           projects.name as project_name
    FROM tasks
    JOIN projects ON tasks.project_id = projects.id
    WHERE tasks.status NOT IN ('inbox','pm_questioning','awaiting_acceptance','done','failed')
    LIMIT 3
  `).all()

  for (const task of activeTasks) {
    if (inFlight.has(task.id)) continue
    inFlight.add(task.id)
    processTask(task)
      .catch(err => {
        console.error(`[orchestrator] task ${task.id} error:`, err.message)
        failTask(task.id, err.message)
      })
      .finally(() => inFlight.delete(task.id))
  }
}

// ─── Process a single task ────────────────────────────────────────────────────

async function processTask(task) {
  const agentName = sm.agentForStatus(task.status)
  if (!agentName) return

  const agentModel = (require('../runner/adapters/claude-code').AGENT_MODELS || {})[agentName] || 'default'
  log(task.id, agentName, 'started', `Starting ${agentName} agent [${agentModel}]`)
  broadcast({ type: 'task_update', task: getTask(task.id) })

  // Build context for agent
  const wsPath       = context.taskDir(task.id)
  const worktreePath = context.worktreeDir(task.id)
  const envData      = {}

  // For Developer (first run): create isolated worktree from main BEFORE computing projectPath
  if (task.status === 'dev_active' && task.retry_count === 0) {
    await gitHelper.createWorktree(task.local_path, task.branch, worktreePath)
    log(task.id, 'orchestrator', 'started', `Created worktree for branch ${task.branch}`)
  }

  // projectPath: use worktree for dev/qa/tests/review (worktree must exist by now for these statuses)
  const projectPath = (WORKTREE_STATUSES.has(task.status) && fs.existsSync(worktreePath))
    ? worktreePath
    : task.local_path

  // For QA: spin up environment first (rsync source is worktree — has developer's changes)
  if (sm.needsEnvironment(task.status)) {
    const project = { local_path: task.local_path, health_check: task.health_check, name: task.project_name, worktreePath }
    const env     = await envManager.start(task, project)
    envData.serviceUrl = env.serviceUrl
    envData.evidenceDir = context.evidenceDir(task.id)

    db.prepare(`UPDATE tasks SET env_port = ?, env_container_prefix = ? WHERE id = ?`)
      .run(env.port, env.prefix, task.id)
  }

  // Run agent via Claude Code CLI
  const result = await runner.run(agentName, {
    taskId:        task.id,
    projectPath,
    workspacePath: wsPath,
    serviceUrl:    envData.serviceUrl,
    env: {
      TASK_ID:      task.id,
      EVIDENCE_DIR: envData.evidenceDir || '',
      SERVICE_URL:  envData.serviceUrl  || ''
    }
  })

  // Stop QA environment
  if (sm.needsEnvironment(task.status)) {
    await envManager.stop(task).catch(e => console.warn('[env] stop error:', e.message))
  }

  log(task.id, agentName, result.status, result.message?.slice(0, 500))

  // If PM returns 'questions', parse them from workspace file
  if (task.status === 'pm_active' && result.status === 'questions') {
    parsePMQuestions(task.id)
  }

  // Advance state
  const newRetry  = (result.status === 'done') ? 0 : task.retry_count + 1
  const newStatus = sm.nextStatus(task.status, result, newRetry)

  db.prepare(`UPDATE tasks SET status = ?, current_agent = ?, retry_count = ?, updated_at = unixepoch()
              WHERE id = ?`).run(newStatus, sm.agentForStatus(newStatus) || null, newRetry, task.id)

  // macOS notification on key transitions
  if (newStatus === 'awaiting_acceptance') {
    macNotify('✅ DevForge', `"${task.title}" is ready for your review`)
  } else if (newStatus === 'failed') {
    macNotify('⚠️ DevForge', `"${task.title}" failed — check the logs`)
  } else if (newStatus === 'pm_questioning') {
    macNotify('💬 DevForge', `PM has questions for "${task.title}"`)
  }

  broadcast({ type: 'task_update', task: getTask(task.id) })
}

// ─── Human actions ────────────────────────────────────────────────────────────

function createTask(projectId, title, description) {
  const id = uuid()
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, status, branch)
              VALUES (?, ?, ?, ?, 'inbox', ?)`)
    .run(id, projectId, title, description, `devforge/${id.slice(0, 8)}`)

  context.init(id, title, description)
  broadcast({ type: 'task_created', task: getTask(id) })
  return id
}

function startTask(taskId) {
  db.prepare(`UPDATE tasks SET status = 'pm_active', updated_at = unixepoch() WHERE id = ?`).run(taskId)
  broadcast({ type: 'task_update', task: getTask(taskId) })
}

function answerPMQuestions(taskId, answers) {
  // answers: [{ id, answer }]
  const stmt = db.prepare('UPDATE pm_questions SET answer = ? WHERE id = ? AND task_id = ?')
  for (const { id, answer } of answers) stmt.run(answer, id, taskId)

  // Write answers to workspace so PM can read them
  const questions = db.prepare('SELECT * FROM pm_questions WHERE task_id = ? ORDER BY order_num').all(taskId)
  const qa = questions.map(q => `**Q:** ${q.question}\n**A:** ${q.answer || '(no answer)'}`).join('\n\n')
  context.write(taskId, 'PM_ANSWERS.md', `# PM Q&A\n\n${qa}`)

  // Advance: re-run PM to write BRD
  db.prepare(`UPDATE tasks SET status = 'pm_active', updated_at = unixepoch() WHERE id = ?`).run(taskId)
  broadcast({ type: 'task_update', task: getTask(taskId) })
}

async function acceptTask(taskId) {
  const task = getTask(taskId)
  if (task && task.local_path && task.branch) {
    await gitHelper.pushBranch(task.local_path, task.branch).catch(err => {
      console.warn(`[git] push failed for task ${taskId}:`, err.message)
    })
    await gitHelper.removeWorktree(task.local_path, context.worktreeDir(taskId)).catch(err => {
      console.warn(`[git] worktree removal failed for task ${taskId}:`, err.message)
    })
  }
  db.prepare(`UPDATE tasks SET status = 'done', updated_at = unixepoch() WHERE id = ?`).run(taskId)
  broadcast({ type: 'task_update', task: getTask(taskId) })
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parsePMQuestions(taskId) {
  const raw = context.read(taskId, 'PM_QUESTIONS.md')
  if (!raw) return
  const lines = raw.split('\n').filter(l => l.trim().startsWith('-') || l.trim().match(/^\d+\./))
  lines.forEach((line, i) => {
    const question = line.replace(/^[-\d.]\s*/, '').trim()
    if (question) {
      db.prepare('INSERT INTO pm_questions (id, task_id, question, order_num) VALUES (?, ?, ?, ?)')
        .run(uuid(), taskId, question, i)
    }
  })
}

function failTask(taskId, message) {
  const task = getTask(taskId)
  if (task?.local_path) {
    gitHelper.removeWorktree(task.local_path, context.worktreeDir(taskId)).catch(() => {})
  }
  log(taskId, 'orchestrator', 'failed', message)
  db.prepare(`UPDATE tasks SET status = 'failed', updated_at = unixepoch() WHERE id = ?`).run(taskId)
  broadcast({ type: 'task_update', task: getTask(taskId) })
}

function log(taskId, agent, status, message) {
  db.prepare('INSERT INTO agent_logs (id, task_id, agent, status, message) VALUES (?, ?, ?, ?, ?)')
    .run(uuid(), taskId, agent, status, message || '')
}

function getTask(taskId) {
  return db.prepare(`
    SELECT t.*, p.name as project_name
    FROM tasks t JOIN projects p ON t.project_id = p.id
    WHERE t.id = ?
  `).get(taskId)
}

module.exports = { startLoop, setBroadcast, createTask, startTask, answerPMQuestions, acceptTask }
