const express = require('express')
const { db } = require('../db')
const context      = require('../orchestrator/context')
const orchestrator = require('../orchestrator/index')
const router = express.Router()

// List all tasks (optionally filter by project)
router.get('/', (req, res) => {
  const where = req.query.project_id ? 'WHERE t.project_id = ?' : ''
  const args  = req.query.project_id ? [req.query.project_id] : []
  const tasks = db.prepare(`
    SELECT t.*, p.name as project_name
    FROM tasks t JOIN projects p ON t.project_id = p.id
    ${where} ORDER BY t.created_at DESC
  `).all(...args)
  res.json(tasks)
})

// Create task
router.post('/', (req, res) => {
  const { project_id, title, description } = req.body
  if (!project_id || !title) return res.status(400).json({ error: 'project_id and title required' })
  const id = orchestrator.createTask(project_id, title, description)
  res.json(db.prepare('SELECT * FROM tasks WHERE id=?').get(id))
})

// Start task (inbox → pm_active)
router.post('/:id/start', (req, res) => {
  orchestrator.startTask(req.params.id)
  res.json({ ok: true })
})

// Accept task (awaiting_acceptance → done)
router.post('/:id/accept', async (req, res) => {
  await orchestrator.acceptTask(req.params.id)
  res.json({ ok: true })
})

// Get PM questions for a task
router.get('/:id/questions', (req, res) => {
  const questions = db.prepare(
    'SELECT * FROM pm_questions WHERE task_id = ? ORDER BY order_num'
  ).all(req.params.id)
  res.json(questions)
})

// Submit answers to PM questions
router.post('/:id/questions/answers', (req, res) => {
  const { answers } = req.body   // [{ id, answer }]
  orchestrator.answerPMQuestions(req.params.id, answers)
  res.json({ ok: true })
})

// Get agent logs
router.get('/:id/logs', (req, res) => {
  res.json(db.prepare(
    'SELECT * FROM agent_logs WHERE task_id = ? ORDER BY created_at DESC'
  ).all(req.params.id))
})

// Get workspace files list
router.get('/:id/files', (req, res) => {
  res.json(context.listFiles(req.params.id))
})

// Get a specific workspace file content
router.get('/:id/files/:filename', (req, res) => {
  const content = context.read(req.params.id, req.params.filename)
  if (content === null) return res.status(404).json({ error: 'not found' })
  res.type('text/plain').send(content)
})

// Get QA evidence files
router.get('/:id/evidence', (req, res) => {
  res.json(context.listEvidenceFiles(req.params.id))
})

module.exports = router
