require('dotenv').config()
const express          = require('express')
const http             = require('http')
const path             = require('path')
const fs               = require('fs')
const { WebSocketServer } = require('ws')
const { init: initDb } = require('./db')

async function main() {
  // db must be ready before anything else
  await initDb()

  const orchestrator = require('./orchestrator/index')
  const app    = express()
  const server = http.createServer(app)
  const wss    = new WebSocketServer({ server })
  const PORT   = process.env.PORT || 4000

  app.use(express.json())
  app.use(express.static(path.join(__dirname, '../ui')))

  app.use('/evidence', (req, res, next) => {
    const wsDir = path.resolve(process.env.WORKSPACE_DIR || './workspace')
    const file  = path.resolve(wsDir, req.path.replace(/^\/+/, ''))
    if (!file.startsWith(wsDir + path.sep)) return next()
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return res.sendFile(file)
    next()
  })

  app.use('/api/projects', require('./routes/projects'))
  app.use('/api/tasks',    require('./routes/tasks'))
  app.use('/api/stats',    require('./routes/stats'))
  app.get('/health', (_req, res) => res.json({ ok: true }))

  function broadcast(data) {
    const msg = JSON.stringify(data)
    wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg) })
  }

  wss.on('connection', ws => ws.send(JSON.stringify({ type: 'connected' })))
  orchestrator.setBroadcast(broadcast)

  server.listen(PORT, () => {
    console.log(`\n🔨 DevForge running at http://localhost:${PORT}\n`)
    orchestrator.startLoop(5000)
  })
}

main().catch(err => { console.error('startup error:', err); process.exit(1) })
