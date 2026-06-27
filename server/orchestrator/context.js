const fs   = require('fs')
const path = require('path')

const WORKSPACE_ROOT = path.resolve(process.env.WORKSPACE_DIR || './workspace')

function taskDir(taskId)      { return path.join(WORKSPACE_ROOT, taskId) }
function evidenceDir(taskId)  { return path.join(WORKSPACE_ROOT, taskId, 'qa-evidence') }
function projectDir(taskId)   { return path.join(WORKSPACE_ROOT, taskId, 'project') }
function worktreeDir(taskId) { return path.join(WORKSPACE_ROOT, taskId, 'worktree') }

function init(taskId, taskTitle, taskDescription) {
  const dir = taskDir(taskId)
  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(evidenceDir(taskId), { recursive: true })
  write(taskId, 'TASK.md', `Task ID: ${taskId}\nBranch: devforge/${taskId.slice(0, 8)}\n\n# Task\n\n**${taskTitle}**\n\n${taskDescription || ''}`)
}

function write(taskId, filename, content) {
  fs.writeFileSync(path.join(taskDir(taskId), filename), content, 'utf8')
}

function read(taskId, filename) {
  const dir = taskDir(taskId)
  const p = path.resolve(dir, path.basename(filename))
  if (!p.startsWith(dir + path.sep)) return null
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null
}

function exists(taskId, filename) {
  return fs.existsSync(path.join(taskDir(taskId), filename))
}

function listFiles(taskId) {
  const dir = taskDir(taskId)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter(f => !fs.statSync(path.join(dir, f)).isDirectory())
}

function listEvidenceFiles(taskId) {
  const dir = evidenceDir(taskId)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).map(f => ({
    name: f,
    path: path.join(dir, f),
    url:  `/evidence/${taskId}/${f}`
  }))
}

function deleteWorkspace(taskId) {
  const dir = taskDir(taskId)
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

module.exports = { taskDir, evidenceDir, projectDir, worktreeDir, init, write, read, exists, listFiles, listEvidenceFiles, deleteWorkspace }
