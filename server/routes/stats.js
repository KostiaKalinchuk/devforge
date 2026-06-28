const express = require('express')
const { db }  = require('../db')
const router  = express.Router()

const CONTEXT_LIMIT = 200000

router.get('/', (req, res) => {
  // Totals
  const totals = db.prepare(`
    SELECT COUNT(*) as runs,
           COALESCE(SUM(tokens_in), 0)  as tokens_in,
           COALESCE(SUM(tokens_out), 0) as tokens_out,
           COALESCE(SUM(cost_usd), 0)   as cost_usd
    FROM agent_logs
  `).get()

  // By agent type
  const byAgent = db.prepare(`
    SELECT agent,
           COUNT(*) as runs,
           COALESCE(SUM(tokens_in), 0)  as tokens_in,
           COALESCE(SUM(tokens_out), 0) as tokens_out,
           COALESCE(SUM(cost_usd), 0)   as cost_usd
    FROM agent_logs
    GROUP BY agent
    ORDER BY SUM(cost_usd) DESC
  `).all()

  // By task — summary rows
  const taskRows = db.prepare(`
    SELECT t.id as task_id, t.title,
           COUNT(l.id) as runs,
           COALESCE(SUM(l.tokens_in), 0)  as tokens_in,
           COALESCE(SUM(l.tokens_out), 0) as tokens_out,
           COALESCE(SUM(l.cost_usd), 0)   as cost_usd
    FROM agent_logs l
    JOIN tasks t ON l.task_id = t.id
    GROUP BY t.id
    ORDER BY t.updated_at DESC
  `).all()

  // Agent breakdown per task
  const byTask = taskRows.map(task => {
    const agents = db.prepare(`
      SELECT agent,
             COALESCE(tokens_in, 0)  as tokens_in,
             COALESCE(tokens_out, 0) as tokens_out,
             COALESCE(cost_usd, 0)   as cost_usd,
             COALESCE(duration_ms, 0) as duration_ms
      FROM agent_logs
      WHERE task_id = ?
      ORDER BY created_at ASC
    `).all(task.task_id).map(a => ({
      ...a,
      context_pct: a.tokens_in
        ? Math.round((a.tokens_in / CONTEXT_LIMIT) * 1000) / 10
        : null
    }))
    return { ...task, agents }
  })

  res.json({ totals, by_agent: byAgent, by_task: byTask })
})

module.exports = router
