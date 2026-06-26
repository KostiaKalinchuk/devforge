const { db } = require('../db')

const START = parseInt(process.env.DOCKER_PORT_RANGE_START || '3100')
const END   = parseInt(process.env.DOCKER_PORT_RANGE_END   || '3999')

function allocate(taskId) {
  const used = new Set(
    db.prepare('SELECT port FROM allocated_ports').all().map(r => r.port)
  )
  for (let p = START; p <= END; p++) {
    if (!used.has(p)) {
      db.prepare('INSERT INTO allocated_ports (port, task_id) VALUES (?, ?)').run(p, taskId)
      return p
    }
  }
  throw new Error(`No free ports in range ${START}-${END}`)
}

function release(taskId) {
  db.prepare('DELETE FROM allocated_ports WHERE task_id = ?').run(taskId)
}

function getPort(taskId) {
  const row = db.prepare('SELECT port FROM allocated_ports WHERE task_id = ?').get(taskId)
  return row ? row.port : null
}

module.exports = { allocate, release, getPort }
