const { execSync, spawnSync } = require('child_process')
const fs   = require('fs')
const path = require('path')
const yaml = require('js-yaml')   // loaded lazily — no extra dep, we parse manually
const portAllocator = require('./port-allocator')

const HEALTH_TIMEOUT = parseInt(process.env.CONTAINER_HEALTH_TIMEOUT || '120') * 1000

/**
 * Spin up an isolated Docker environment for a task.
 * Copies the project, overrides ports, starts compose, waits for /health.
 */
async function start(task, project) {
  const prefix  = `devforge-${task.id.slice(0, 8)}`
  const port    = portAllocator.allocate(task.id)
  const taskDir = path.join(process.env.WORKSPACE_DIR || './workspace', task.id, 'project')

  // Copy project source into task workspace
  fs.mkdirSync(taskDir, { recursive: true })
  spawnSync('rsync', ['-a', '--exclude=.git', '--exclude=vendor', '--exclude=node_modules',
    `${project.local_path}/`, `${taskDir}/`], { stdio: 'pipe' })

  // Patch docker-compose: replace hardcoded external port with dynamic one
  const composeSrc = path.join(taskDir, 'docker-compose.yml')
  if (!fs.existsSync(composeSrc)) {
    throw new Error(`No docker-compose.yml in ${project.local_path}`)
  }
  let composeContent = fs.readFileSync(composeSrc, 'utf8')
  // Replace any "XXXX:80" pattern with our dynamic port
  composeContent = composeContent.replace(/"\d+:(\d+)"/g, `"${port}:$1"`)
  composeContent = composeContent.replace(/- "\d+:(\d+)"/g, `- "${port}:$1"`)
  fs.writeFileSync(composeSrc, composeContent)

  // Copy .env from project root if exists
  const envSrc = path.join(project.local_path, '.env')
  if (fs.existsSync(envSrc)) {
    fs.copyFileSync(envSrc, path.join(taskDir, '.env'))
  }

  // Start containers
  execSync(`docker compose -p ${prefix} up -d --build`, {
    cwd: taskDir,
    stdio: 'inherit',
    timeout: 10 * 60 * 1000
  })

  // Wait for health check
  const serviceUrl = `http://localhost:${port}`
  await waitForHealth(serviceUrl, project.health_check || '/health')

  return { serviceUrl, port, prefix, taskDir }
}

async function stop(task) {
  const prefix  = task.env_container_prefix
  const taskDir = path.join(process.env.WORKSPACE_DIR || './workspace', task.id, 'project')

  if (prefix && fs.existsSync(taskDir)) {
    try {
      execSync(`docker compose -p ${prefix} down -v`, {
        cwd: taskDir, stdio: 'pipe', timeout: 60_000
      })
    } catch (e) {
      console.warn(`[env] Could not stop containers for ${prefix}:`, e.message)
    }
  }
  portAllocator.release(task.id)
}

async function waitForHealth(baseUrl, endpoint) {
  const url     = `${baseUrl}${endpoint}`
  const start   = Date.now()
  const http    = require('http')

  while (Date.now() - start < HEALTH_TIMEOUT) {
    const ok = await ping(http, url)
    if (ok) return
    await sleep(3000)
  }
  throw new Error(`Service did not become healthy at ${url} within ${HEALTH_TIMEOUT / 1000}s`)
}

function ping(http, url) {
  return new Promise(resolve => {
    const req = http.get(url, res => resolve(res.statusCode < 500))
    req.on('error', () => resolve(false))
    req.setTimeout(2000, () => { req.destroy(); resolve(false) })
  })
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

module.exports = { start, stop }
