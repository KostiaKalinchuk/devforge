const express = require('express')
const { v4: uuid } = require('uuid')
const { db } = require('../db')
const router = express.Router()

router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all())
})

router.post('/', (req, res) => {
  const { name, local_path, git_url, description, internal_port, health_check, test_command } = req.body
  if (!name || !local_path) return res.status(400).json({ error: 'name and local_path required' })
  const id = uuid()
  db.prepare(`INSERT INTO projects (id,name,local_path,git_url,description,internal_port,health_check,test_command)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, name, local_path, git_url||null, description||null,
         internal_port||80, health_check||'/health', test_command||'php artisan test')
  res.json(db.prepare('SELECT * FROM projects WHERE id=?').get(id))
})

router.put('/:id', (req, res) => {
  const { name, local_path, git_url, description, internal_port, health_check, test_command } = req.body
  db.prepare(`UPDATE projects SET name=?,local_path=?,git_url=?,description=?,
              internal_port=?,health_check=?,test_command=? WHERE id=?`)
    .run(name, local_path, git_url||null, description||null,
         internal_port||80, health_check||'/health', test_command||'php artisan test', req.params.id)
  res.json(db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id))
})

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM projects WHERE id=?').run(req.params.id)
  res.json({ ok: true })
})

module.exports = router
