# Git Worktrees for Concurrent Task Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current single-directory git checkout with per-task git worktrees so that multiple tasks running concurrently on the same project never conflict on the working tree.

**Architecture:** Each task gets an isolated git worktree at `workspace/{taskId}/worktree/` created from `main` when the Developer agent first runs. All subsequent agents (Developer retries, QA, Tests, Reviewer) work from this worktree. On accept the branch is pushed and the worktree removed; on fail the worktree is pruned silently.

**Tech Stack:** Node.js, simple-git (already installed), existing `context.js` workspace path helpers.

## Global Constraints

- No new npm dependencies — use `simple-git` (already in package.json) for all git operations via `.raw([...])` for worktree commands.
- Worktree path is always `path.join(WORKSPACE_DIR, taskId, 'worktree')` — derived, no DB schema change.
- All git operations are best-effort where failure is non-fatal (fetch/pull from origin may fail for local-only repos).
- `createWorktree` must be idempotent: if the worktree directory already exists, return immediately without error (covers retry runs).
- `removeWorktree` must be fire-and-forget safe (used inside `failTask` which is sync).
- Do not change the DB schema.
- Do not change the agent prompt files.
- `pm_active` and `architect_active` keep using `task.local_path` as `projectPath` (they only read the project, never write to it).

---

### Task 1: Add `worktreeDir` to `context.js` and rewrite `git.js` with worktree helpers

**Files:**
- Modify: `server/orchestrator/context.js:6-8` (add `worktreeDir` export)
- Modify: `server/orchestrator/git.js` (full rewrite — replace `checkoutBranchFromMain` with `createWorktree`, add `removeWorktree`)

**Interfaces:**
- Produces:
  - `context.worktreeDir(taskId: string): string` — returns `workspace/{taskId}/worktree`
  - `git.createWorktree(repoPath: string, branchName: string, worktreePath: string): Promise<void>`
  - `git.pushBranch(repoPath: string, branchName: string): Promise<void>` — unchanged
  - `git.removeWorktree(repoPath: string, worktreePath: string): Promise<void>`

- [ ] **Step 1: Add `worktreeDir` to `context.js`**

In `server/orchestrator/context.js`, add one line after the existing `projectDir` function (line 8):

```js
function worktreeDir(taskId) { return path.join(WORKSPACE_ROOT, taskId, 'worktree') }
```

Then add `worktreeDir` to the `module.exports` at the bottom:

```js
module.exports = { taskDir, evidenceDir, projectDir, worktreeDir, init, write, read, exists, listFiles, listEvidenceFiles }
```

- [ ] **Step 2: Verify `worktreeDir` exports correctly**

```bash
cd /Users/kostiantynkalinchuk/localhost/devforge
node -e "const c = require('./server/orchestrator/context'); console.log(c.worktreeDir('abc123'))"
```

Expected output (path will vary based on WORKSPACE_DIR):
```
/Users/kostiantynkalinchuk/localhost/devforge/workspace/abc123/worktree
```

- [ ] **Step 3: Rewrite `server/orchestrator/git.js`**

Replace the entire file with:

```js
const simpleGit = require('simple-git')
const fs = require('fs')

async function createWorktree(repoPath, branchName, worktreePath) {
  if (fs.existsSync(worktreePath)) return  // idempotent — retry runs reuse existing worktree

  const git = simpleGit(repoPath)
  await git.fetch('origin').catch(() => {})       // best-effort; local-only repos won't have origin
  await git.pull('origin', 'main').catch(() => {}) // best-effort

  const branches = await git.branchLocal()
  if (branches.all.includes(branchName)) {
    // Branch already exists (e.g. from a previous crashed run) — attach worktree to it
    await git.raw(['worktree', 'add', worktreePath, branchName])
  } else {
    // First time: create new branch from main in the new worktree
    await git.raw(['worktree', 'add', '-b', branchName, worktreePath, 'main'])
  }
}

async function pushBranch(repoPath, branchName) {
  const git = simpleGit(repoPath)
  await git.push('origin', branchName)
}

async function removeWorktree(repoPath, worktreePath) {
  const git = simpleGit(repoPath)
  await git.raw(['worktree', 'remove', '--force', worktreePath]).catch(() => {})
  await git.raw(['worktree', 'prune']).catch(() => {})  // clean up stale refs
}

module.exports = { createWorktree, pushBranch, removeWorktree }
```

- [ ] **Step 4: Create a local bare repo to test against**

```bash
rm -rf /tmp/devforge-git-test
mkdir -p /tmp/devforge-git-test/origin.git /tmp/devforge-git-test/local
git init --bare /tmp/devforge-git-test/origin.git
git clone /tmp/devforge-git-test/origin.git /tmp/devforge-git-test/local
cd /tmp/devforge-git-test/local
echo "init" > README.md
git add .
git commit -m "init"
git push origin main
```

Expected: no errors, `main` branch exists in the bare repo.

- [ ] **Step 5: Test `createWorktree` — new branch**

```bash
cd /Users/kostiantynkalinchuk/localhost/devforge
node -e "
const git = require('./server/orchestrator/git')
const { execSync } = require('child_process')
git.createWorktree(
  '/tmp/devforge-git-test/local',
  'devforge/task001',
  '/tmp/devforge-git-test/wt1'
).then(() => {
  const branch = execSync('git branch --show-current', { cwd: '/tmp/devforge-git-test/wt1' }).toString().trim()
  console.log('branch:', branch)
  console.log('PASS:', branch === 'devforge/task001')
}).catch(e => { console.error('FAIL:', e.message) })
"
```

Expected output:
```
branch: devforge/task001
PASS: true
```

- [ ] **Step 6: Test `createWorktree` — idempotency (call twice)**

```bash
cd /Users/kostiantynkalinchuk/localhost/devforge
node -e "
const git = require('./server/orchestrator/git')
git.createWorktree(
  '/tmp/devforge-git-test/local',
  'devforge/task001',
  '/tmp/devforge-git-test/wt1'  // already exists
).then(() => console.log('PASS: idempotent, no error'))
  .catch(e => console.error('FAIL:', e.message))
"
```

Expected output:
```
PASS: idempotent, no error
```

- [ ] **Step 7: Test `removeWorktree`**

```bash
cd /Users/kostiantynkalinchuk/localhost/devforge
node -e "
const git = require('./server/orchestrator/git')
const fs = require('fs')
git.removeWorktree(
  '/tmp/devforge-git-test/local',
  '/tmp/devforge-git-test/wt1'
).then(() => {
  const gone = !fs.existsSync('/tmp/devforge-git-test/wt1')
  console.log('removed:', gone)
  console.log('PASS:', gone)
}).catch(e => console.error('FAIL:', e.message))
"
```

Expected output:
```
removed: true
PASS: true
```

- [ ] **Step 8: Clean up temp test repo**

```bash
rm -rf /tmp/devforge-git-test
```

- [ ] **Step 9: Commit**

```bash
cd /Users/kostiantynkalinchuk/localhost/devforge
git add server/orchestrator/context.js server/orchestrator/git.js
git commit -m "feat: add worktreeDir helper and rewrite git.js with worktree support"
```

---

### Task 2: Use worktrees in `orchestrator/index.js`

**Files:**
- Modify: `server/orchestrator/index.js` (processTask, acceptTask, failTask)

**Interfaces:**
- Consumes:
  - `context.worktreeDir(taskId)` → string (from Task 1)
  - `gitHelper.createWorktree(repoPath, branchName, worktreePath)` → Promise<void> (from Task 1)
  - `gitHelper.removeWorktree(repoPath, worktreePath)` → Promise<void> (from Task 1)
  - `gitHelper.pushBranch(repoPath, branchName)` → Promise<void> (unchanged from Task 1)

The statuses that need the worktree as `projectPath` are `dev_active`, `qa_active`, `tests_active`, `review_active`. PM and Architect only read the project, so they continue using `task.local_path`.

- [ ] **Step 1: Add `fs` require and `WORKTREE_STATUSES` set at top of `index.js`**

After `const { exec } = require('child_process')` (line 9), add:

```js
const fs = require('fs')

const WORKTREE_STATUSES = new Set(['dev_active', 'qa_active', 'tests_active', 'review_active'])
```

- [ ] **Step 2: Replace the branch creation block and `projectPath` in `processTask`**

Locate this block in `processTask` (around line 64-95):

```js
  // Build context for agent
  const wsPath  = context.taskDir(task.id)
  const envData = {}

  // For QA: spin up environment first
  if (sm.needsEnvironment(task.status)) {
    const project = { local_path: task.local_path, health_check: task.health_check, name: task.project_name }
    const env     = await envManager.start(task, project)
    envData.serviceUrl = env.serviceUrl
    envData.evidenceDir = context.evidenceDir(task.id)

    db.prepare(`UPDATE tasks SET env_port = ?, env_container_prefix = ? WHERE id = ?`)
      .run(env.port, env.prefix, task.id)
  }

  // For Developer (first run): create feature branch from main
  if (task.status === 'dev_active' && task.retry_count === 0) {
    await gitHelper.checkoutBranchFromMain(task.local_path, task.branch)
    log(task.id, 'orchestrator', 'started', `Checked out branch ${task.branch} from main`)
  }

  // Run agent via Claude Code CLI
  const result = await runner.run(agentName, {
    taskId:        task.id,
    projectPath:   task.local_path,
    workspacePath: wsPath,
```

Replace with:

```js
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
```

- [ ] **Step 3: Update `acceptTask` — remove worktree after push**

Replace the current `acceptTask`:

```js
async function acceptTask(taskId) {
  const task = getTask(taskId)
  if (task && task.local_path && task.branch) {
    await gitHelper.pushBranch(task.local_path, task.branch).catch(err => {
      console.warn(`[git] push failed for task ${taskId}:`, err.message)
    })
  }
  db.prepare(`UPDATE tasks SET status = 'done', updated_at = unixepoch() WHERE id = ?`).run(taskId)
  broadcast({ type: 'task_update', task: getTask(taskId) })
}
```

With:

```js
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
```

- [ ] **Step 4: Update `failTask` — prune worktree on failure**

Replace:

```js
function failTask(taskId, message) {
  log(taskId, 'orchestrator', 'failed', message)
  db.prepare(`UPDATE tasks SET status = 'failed', updated_at = unixepoch() WHERE id = ?`).run(taskId)
  broadcast({ type: 'task_update', task: getTask(taskId) })
}
```

With:

```js
function failTask(taskId, message) {
  const task = getTask(taskId)
  if (task?.local_path) {
    gitHelper.removeWorktree(task.local_path, context.worktreeDir(taskId)).catch(() => {})
  }
  log(taskId, 'orchestrator', 'failed', message)
  db.prepare(`UPDATE tasks SET status = 'failed', updated_at = unixepoch() WHERE id = ?`).run(taskId)
  broadcast({ type: 'task_update', task: getTask(taskId) })
}
```

- [ ] **Step 5: Verify the server loads without errors**

```bash
cd /Users/kostiantynkalinchuk/localhost/devforge
node -e "require('./server/orchestrator/index')" 2>&1 | head -5
```

Expected: no output (clean require, no errors). If you see errors, they will be printed to stderr.

- [ ] **Step 6: Verify `projectPath` logic in isolation**

```bash
cd /Users/kostiantynkalinchuk/localhost/devforge
node -e "
const fs = require('fs')
const path = require('path')
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || './workspace'
const WORKTREE_STATUSES = new Set(['dev_active', 'qa_active', 'tests_active', 'review_active'])

function worktreeDir(taskId) { return path.join(WORKSPACE_DIR, taskId, 'worktree') }

// Simulate: worktree does NOT exist yet (pm_active)
const t1 = { status: 'pm_active', local_path: '/projects/myapp' }
const wt1 = worktreeDir('task1')
const pp1 = (WORKTREE_STATUSES.has(t1.status) && fs.existsSync(wt1)) ? wt1 : t1.local_path
console.log('pm_active, no worktree →', pp1)  // should be /projects/myapp

// Simulate: worktree exists, dev_active
fs.mkdirSync(worktreeDir('task2'), { recursive: true })
const t2 = { status: 'dev_active', local_path: '/projects/myapp' }
const wt2 = worktreeDir('task2')
const pp2 = (WORKTREE_STATUSES.has(t2.status) && fs.existsSync(wt2)) ? wt2 : t2.local_path
console.log('dev_active, worktree exists →', pp2)  // should be workspace/task2/worktree
fs.rmSync(worktreeDir('task2'), { recursive: true })
"
```

Expected:
```
pm_active, no worktree → /projects/myapp
dev_active, worktree exists → workspace/task2/worktree
```

- [ ] **Step 7: Commit**

```bash
cd /Users/kostiantynkalinchuk/localhost/devforge
git add server/orchestrator/index.js
git commit -m "feat: use git worktrees for task isolation in orchestrator"
```

---

### Task 3: Rsync from worktree in `environment/manager.js`

**Files:**
- Modify: `server/environment/manager.js:16-24` (rsync source selection)

**Interfaces:**
- Consumes: `project.worktreePath` (string | undefined) passed from orchestrator (Task 2 now passes it in the `project` object)

The `start(task, project)` function receives the project object. Task 2 already adds `worktreePath` to it when calling `envManager.start`. Here we use it: if `worktreePath` exists on disk, rsync from there; otherwise fall back to `project.local_path`.

- [ ] **Step 1: Update the rsync source in `manager.js`**

Locate in `server/environment/manager.js` (lines 19-24):

```js
  // Copy project source into task workspace
  fs.mkdirSync(taskDir, { recursive: true })
  const rsync = spawnSync('rsync', ['-a', '--exclude=.git', '--exclude=vendor', '--exclude=node_modules',
    `${project.local_path}/`, `${taskDir}/`], { stdio: 'pipe' })
  if (rsync.status !== 0) {
    throw new Error(`rsync failed (exit ${rsync.status}): ${rsync.stderr?.toString()}`)
  }
```

Replace with:

```js
  // Copy project source into task workspace — prefer worktree (has developer's changes)
  fs.mkdirSync(taskDir, { recursive: true })
  const rsyncSource = (project.worktreePath && fs.existsSync(project.worktreePath))
    ? project.worktreePath
    : project.local_path
  const rsync = spawnSync('rsync', ['-a', '--exclude=.git', '--exclude=vendor', '--exclude=node_modules',
    `${rsyncSource}/`, `${taskDir}/`], { stdio: 'pipe' })
  if (rsync.status !== 0) {
    throw new Error(`rsync failed (exit ${rsync.status}): ${rsync.stderr?.toString()}`)
  }
```

- [ ] **Step 2: Verify `manager.js` loads without errors**

```bash
cd /Users/kostiantynkalinchuk/localhost/devforge
node -e "require('./server/environment/manager')" 2>&1 | head -5
```

Expected: no output.

- [ ] **Step 3: Verify server starts clean**

```bash
cd /Users/kostiantynkalinchuk/localhost/devforge
pkill -f "node.*devforge" 2>/dev/null; sleep 1
node server/index.js &
sleep 3
curl -s http://localhost:4000/health
kill %1 2>/dev/null
```

Expected: `{"ok":true}`

- [ ] **Step 4: Verify rsync source selection logic**

```bash
cd /Users/kostiantynkalinchuk/localhost/devforge
node -e "
const fs = require('fs')
const path = require('path')

// Case 1: worktreePath not provided (old call site, defensive)
const project1 = { local_path: '/projects/myapp' }
const src1 = (project1.worktreePath && fs.existsSync(project1.worktreePath))
  ? project1.worktreePath : project1.local_path
console.log('no worktreePath →', src1)  // /projects/myapp

// Case 2: worktreePath provided but dir doesn't exist yet
const project2 = { local_path: '/projects/myapp', worktreePath: '/tmp/nonexistent-wt' }
const src2 = (project2.worktreePath && fs.existsSync(project2.worktreePath))
  ? project2.worktreePath : project2.local_path
console.log('worktreePath missing on disk →', src2)  // /projects/myapp

// Case 3: worktreePath exists on disk
fs.mkdirSync('/tmp/devforge-wt-test', { recursive: true })
const project3 = { local_path: '/projects/myapp', worktreePath: '/tmp/devforge-wt-test' }
const src3 = (project3.worktreePath && fs.existsSync(project3.worktreePath))
  ? project3.worktreePath : project3.local_path
console.log('worktreePath exists →', src3)  // /tmp/devforge-wt-test
fs.rmSync('/tmp/devforge-wt-test', { recursive: true })
"
```

Expected:
```
no worktreePath → /projects/myapp
worktreePath missing on disk → /projects/myapp
worktreePath exists → /tmp/devforge-wt-test
```

- [ ] **Step 5: Commit**

```bash
cd /Users/kostiantynkalinchuk/localhost/devforge
git add server/environment/manager.js
git commit -m "feat: rsync from worktree in QA environment when available"
```
