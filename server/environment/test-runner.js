const { execSync, spawnSync } = require('child_process')
const fs   = require('fs')
const path = require('path')

/**
 * Runs the project's own test suite inside the running container.
 * Returns { passed, output }
 */
function runProjectTests(taskDir, prefix, testCommand) {
  const cmd = testCommand || 'php artisan test'
  try {
    const appService = detectAppService(taskDir)
    const cmdArgv = cmd.trim().split(/\s+/)
    const result = spawnSync(
      'docker', ['compose', '-p', prefix, 'exec', '-T', appService, ...cmdArgv],
      { cwd: taskDir, timeout: 5 * 60 * 1000, encoding: 'utf8' }
    )
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'test failed')
    return { passed: true, output: result.stdout }
  } catch (e) {
    return { passed: false, output: e.message }
  }
}

/**
 * Runs an ad-hoc Playwright script written by the QA agent.
 * Script receives SERVICE_URL via env.
 */
async function runPlaywrightScript(scriptContent, serviceUrl, evidenceDir) {
  fs.mkdirSync(evidenceDir, { recursive: true })

  const scriptPath = path.join(evidenceDir, 'qa-playwright.js')
  // Inject evidence dir and service URL into the script header
  const header = `
const { chromium } = require('playwright')
const SERVICE_URL = process.env.SERVICE_URL || '${serviceUrl}'
const EVIDENCE_DIR = '${evidenceDir.replace(/\\/g, '/')}'
const fs = require('fs')
`
  fs.writeFileSync(scriptPath, header + '\n' + scriptContent)

  try {
    const output = execSync(`node "${scriptPath}"`, {
      env: { ...process.env, SERVICE_URL: serviceUrl, EVIDENCE_DIR: evidenceDir },
      timeout: 10 * 60 * 1000
    }).toString()
    return { passed: true, output }
  } catch (e) {
    return { passed: false, output: e.stdout?.toString() || e.message }
  }
}

function detectAppService(taskDir) {
  // Try to find the PHP/app service name from docker-compose.yml
  const compose = fs.readFileSync(path.join(taskDir, 'docker-compose.yml'), 'utf8')
  const match = compose.match(/^  (\w+):/m)
  return match ? match[1] : 'app'
}

module.exports = { runProjectTests, runPlaywrightScript }
