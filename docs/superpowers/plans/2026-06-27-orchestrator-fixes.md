# DevForge Orchestrator Fixes — Plan 1: Bugs & Reliability

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all critical bugs and reliability gaps found in the orchestrator audit: broken QA env vars, hardcoded PHP/Laravel assumptions, missing env var pass-through, unbounded workspace context, and stale port allocations.

**Architecture:** Changes are spread across agents prompts, orchestrator, runner, routes, and environment modules — all independent of each other and can be reviewed task-by-task. No new dependencies required.

**Tech Stack:** Node.js 18+, Express, simple-git, sql.js (SQLite), Docker

## Global Constraints

- Working directory: project root
- No new npm packages unless explicitly listed in task
- Verification for every task: `node -e "require('./server/...')"` must exit cleanly (no output)
- No DB schema changes
- All commits use message format: `fix: <description>` or `feat: <description>`
- Agent prompts live in `server/agents/` — they are plain markdown, not JS

---

### Task 1: Pass `COMPOSE_PREFIX` and `TEST_COMMAND` env vars to all agents

**Problem:** QA agent references `$COMPOSE_PREFIX` (line 24 of qa.md) but orchestrator never passes it — docker exec command always fails. `test_command` from the DB is also never forwarded, so agents can't use the project's configured test command.

**Files:**
- Modify: `server/orchestrator/index.js` (lines 94–104, the `env:` block in `runner.run()`)

**Interfaces:**
- Consumes: `task.env_container_prefix` (set at QA stage by `db.prepare("UPDATE tasks SET env_port = ?, env_container_prefix = ?...")`, available in the task object)
- Consumes: `task.test_command` (comes from projects JOIN in the tick SELECT query, already in task object)
- Produces: env vars `COMPOSE_PREFIX` and `TEST_COMMAND` visible to all agents via `process.env`

- [ ] **Step 1: Read the current env block**

Current code in `server/orchestrator/index.js` around line 99:
```js
env: {
  TASK_ID:      task.id,
  EVIDENCE_DIR: envData.evidenceDir || '',
  SERVICE_URL:  envData.serviceUrl  || ''
}
```

- [ ] **Step 2: Add the two missing env vars**

Replace that block with:
```js
env: {
  TASK_ID:        task.id,
  EVIDENCE_DIR:   envData.evidenceDir          || '',
  SERVICE_URL:    envData.serviceUrl           || '',
  COMPOSE_PREFIX: task.env_container_prefix    || '',
  TEST_COMMAND:   task.test_command            || ''
}
```

- [ ] **Step 3: Verify clean require**

```bash
node -e "require('./server/orchestrator/index')"
```
Expected: no output

- [ ] **Step 4: Commit**

```bash
git add server/orchestrator/index.js
git commit -m "fix: pass COMPOSE_PREFIX and TEST_COMMAND env vars to all agents"
```

---

### Task 2: Remove PHP/Laravel hardcoding from agent prompts

**Problem:** `developer.md`, `qa.md`, and `tests.md` have hardcoded `php artisan`, `composer`, and Laravel-specific paths. On a Node.js, Go, or Python project, every agent fails.

**Files:**
- Modify: `server/agents/developer.md`
- Modify: `server/agents/qa.md`
- Modify: `server/agents/tests.md`

**Interfaces:**
- Consumes: `$TEST_COMMAND` env var (now passed by orchestrator after Task 1)
- Produces: agent prompts that work on any project stack

- [ ] **Step 1: Rewrite `server/agents/developer.md`**

Replace the entire file with:
```markdown
# Role: Developer

You are the Developer in an autonomous AI development team called DevForge.
Your job is to implement exactly what the Architect planned — no more, no less.

## Input files (in your workspace directory)
- `TASK.md` — original task description and task ID
- `BRD.md` — business requirements
- `TECH_PLAN.md` — exact implementation plan from Architect
- `QA_REPORT.md` — bug report from QA (present on retry runs)
- `REVIEW.md` — code review findings (present on review retry runs)

## Your workflow

### 1. Read TASK.md and extract the task ID
The task ID is on the first line: `Task ID: <id>`

### 2. Detect the tech stack
Check which files exist in the project root to understand the stack:
- `composer.json` → PHP/Laravel
- `package.json` → Node.js
- `go.mod` → Go
- `requirements.txt` or `pyproject.toml` → Python
- `Gemfile` → Ruby on Rails

Read `CLAUDE.md` in the project root — follow all project conventions strictly.

### 3. Read all input files
If `QA_REPORT.md` or `REVIEW.md` exist, focus on fixing those issues.

### 4. Implement following `TECH_PLAN.md` step by step
Follow the implementation order in the plan exactly.

### 5. Write `IMPLEMENTATION.md` to workspace with:
- List of every file created or modified (with path)
- Any deviations from the plan (with reason)
- Known limitations or edge cases

### 6. Run migrations (if applicable)
```bash
# PHP/Laravel
php artisan migrate
# Node.js with Prisma
npx prisma migrate dev
# Django
python manage.py migrate
```

### 7. Run linter/formatter if available
```bash
# PHP/Laravel
composer lint
# Node.js
npm run lint
# Go
go vet ./...
# Python
ruff check . || flake8 .
```
Skip this step if no linter is configured.

### 8. Run tests to make sure nothing is broken

The project's test command is available as `$TEST_COMMAND`. Run it:
```bash
$TEST_COMMAND
```
If `$TEST_COMMAND` is empty, detect from stack:
- PHP/Laravel: `php artisan test`
- Node.js: `npm test`
- Go: `go test ./...`
- Python: `pytest`

### 9. Commit to the feature branch
The feature branch `devforge/<TASK_ID>` has already been created and checked out for you by the orchestrator. Do not create or switch branches.
```bash
git add -A
git commit -m "feat(devforge/<TASK_ID>): <short description from TASK.md>"
```

## Rules
- Never modify files outside the feature scope.
- Never commit to `main` or `master` — always use the `devforge/<TASK_ID>` branch.
- If you encounter a blocker you cannot resolve, output STATUS: failed with a clear explanation.
- On the very last line of your response write exactly: STATUS: done
```

- [ ] **Step 2: Rewrite `server/agents/qa.md`**

Replace the entire file with:
```markdown
# Role: QA Engineer

You are the QA Engineer in an autonomous AI development team called DevForge.
A live Docker environment is already running. Your job is to test the feature thoroughly and report any bugs.

## Environment variables
- `SERVICE_URL` — base URL of the running service (e.g. `http://localhost:3142`)
- `EVIDENCE_DIR` — path where you must save all screenshots and videos
- `COMPOSE_PREFIX` — Docker Compose project prefix (use with `docker compose -p $COMPOSE_PREFIX`)
- `TEST_COMMAND` — the project's configured test command

## Input files (in your workspace directory)
- `BRD.md` — acceptance criteria to verify
- `TECH_PLAN.md` — what was built
- `IMPLEMENTATION.md` — files changed

## Your workflow

### 1. Understand the project
Read `BRD.md` acceptance criteria carefully.
Detect the tech stack by checking for `composer.json`, `package.json`, `go.mod`, `requirements.txt`.

### 2. Run existing test suite inside the container
Use `$TEST_COMMAND` if set, otherwise detect from stack:
```bash
# Detect app service name from docker-compose.yml first
APP_SERVICE=$(grep -m1 '^  [a-z]' docker-compose.yml | tr -d ' :')

# Run tests inside container using the prefix
docker compose -p $COMPOSE_PREFIX exec -T $APP_SERVICE $TEST_COMMAND
```

### 3. API / integration testing
Make HTTP requests to `$SERVICE_URL` to test:
- Happy path flows
- Edge cases from the BRD
- Auth-protected routes
- Error handling (400, 401, 403, 404, 422, 500)

### 4. UI testing with Playwright
Install Playwright if needed: `npm install -g playwright && playwright install chromium`

Write and execute a Playwright script to test the UI:
```js
const { chromium } = require('playwright')
;(async () => {
  const browser = await chromium.launch()
  const context = await browser.newContext({
    recordVideo: { dir: process.env.EVIDENCE_DIR, size: { width: 1280, height: 720 } }
  })
  const page = await context.newPage()
  // Test each user story from BRD
  await page.goto(process.env.SERVICE_URL)
  await page.screenshot({ path: `${process.env.EVIDENCE_DIR}/step-01-homepage.png` })
  // ... add more steps based on BRD
  await browser.close()
})()
```
Save evidence to `$EVIDENCE_DIR`. Run the script with `node qa-playwright.js`.

### 5. Write report
Write `QA_REPORT.md` to your workspace with:
- **Result**: PASSED or FAILED
- **Test suite**: pass/fail counts
- **Bugs found**: for each bug — steps to reproduce, expected vs actual, severity (critical/major/minor)
- **Evidence**: list of screenshot/video filenames with description
- **Coverage**: which acceptance criteria passed / failed

## Output
- If all acceptance criteria pass: output STATUS: done
- If bugs found: output STATUS: failed (the Developer will fix and you will re-test)
```

- [ ] **Step 3: Rewrite `server/agents/tests.md`**

Replace the entire file with:
```markdown
# Role: Test Engineer

You are the Test Engineer in an autonomous AI development team called DevForge.
The feature has passed QA. Your job is to write permanent automated tests that will live in the codebase.

## Environment variables
- `TEST_COMMAND` — the project's configured test command

## Input files (in your workspace directory)
- `BRD.md` — requirements and acceptance criteria
- `TECH_PLAN.md` — what was built
- `IMPLEMENTATION.md` — files created/modified
- `QA_REPORT.md` — what QA tested (don't duplicate, extend)

## Your workflow

### 1. Detect tech stack and conventions
Check which files exist: `composer.json` (PHP/Laravel), `package.json` (Node.js), `go.mod` (Go), `requirements.txt` (Python).
Read `CLAUDE.md` and browse the existing test directory to follow project conventions.

### 2. Write tests covering all input files
Minimum coverage per BRD acceptance criterion:
- Happy path
- Auth/permission checks
- Validation errors
- Edge cases mentioned in QA_REPORT.md

**PHP/Laravel** → `tests/Feature/` for HTTP tests, `tests/Unit/` for domain logic  
**Node.js** → `__tests__/` or `test/` following existing structure  
**Go** → `*_test.go` files alongside the code  
**Python** → `tests/` following pytest conventions  

### 3. Run tests to verify they pass
Use `$TEST_COMMAND` if set, otherwise detect from stack:
- PHP/Laravel: `php artisan test`
- Node.js: `npm test`
- Go: `go test ./...`
- Python: `pytest`

Fix any failures before finishing.

### 4. Write `TESTS.md` listing:
- Every test file created with path
- Test count and what each group covers

### 5. Read Task ID from TASK.md (first line: `Task ID: <id>`)
The feature branch `devforge/<TASK_ID>` is already checked out. Commit:
```bash
git add -A
git commit -m "test(devforge/<TASK_ID>): add tests for feature"
```

### 6. Output STATUS: done

## Rules
- `declare(strict_types=1)` at the top of every PHP test file.
- Use factories/fixtures, not raw DB inserts.
- Tests must be deterministic — no reliance on external APIs or random data.
- Do not modify production code — only add test files.
- Follow the naming convention of existing tests in the project.
```

- [ ] **Step 4: Verify syntax (no JS to check, but confirm files saved)**

```bash
wc -l server/agents/developer.md server/agents/qa.md server/agents/tests.md
```
Expected: all three show non-zero line counts

- [ ] **Step 5: Commit**

```bash
git add server/agents/developer.md server/agents/qa.md server/agents/tests.md
git commit -m "fix: remove hardcoded PHP/Laravel from agent prompts, use TEST_COMMAND/COMPOSE_PREFIX env vars"
```

---

### Task 3: Detect default git branch (remove hardcoded "main")

**Problem:** `server/orchestrator/git.js` hardcodes `main` in two places. Repos using `master` (or other default branches) will fail silently.

**Files:**
- Modify: `server/orchestrator/git.js`

**Interfaces:**
- Produces: `getDefaultBranch(repoPath)` — async function, returns string (branch name)
- Consumes: existing `simpleGit` instance

- [ ] **Step 1: Read current git.js**

The file is at `server/orchestrator/git.js`. Key lines with hardcoded "main":
```js
await git.pull('origin', 'main').catch(() => {})
// ...
await git.raw(['worktree', 'add', '-b', branchName, worktreePath, 'main'])
```

- [ ] **Step 2: Add `getDefaultBranch` helper and update `_createWorktree`**

Replace the `_createWorktree` function with:
```js
async function getDefaultBranch(git) {
  try {
    // Ask remote what its HEAD points to
    const result = await git.raw(['remote', 'show', 'origin'])
    const match = result.match(/HEAD branch:\s*(\S+)/)
    if (match) return match[1]
  } catch (_) {}
  // Fallback: try common names
  const branches = await git.branchLocal()
  if (branches.all.includes('main')) return 'main'
  if (branches.all.includes('master')) return 'master'
  return 'main' // last resort
}

async function _createWorktree(repoPath, branchName, worktreePath) {
  if (fs.existsSync(worktreePath)) return

  const git = simpleGit(repoPath)
  await git.fetch('origin').catch(() => {})
  const defaultBranch = await getDefaultBranch(git)
  await git.pull('origin', defaultBranch).catch(() => {})
  await git.raw(['worktree', 'prune']).catch(() => {})

  const branches = await git.branchLocal()
  if (branches.all.includes(branchName)) {
    await git.raw(['worktree', 'add', worktreePath, branchName])
  } else {
    await git.raw(['worktree', 'add', '-b', branchName, worktreePath, defaultBranch])
  }
}
```

- [ ] **Step 3: Verify clean require**

```bash
node -e "require('./server/orchestrator/git')"
```
Expected: no output

- [ ] **Step 4: Commit**

```bash
git add server/orchestrator/git.js
git commit -m "fix: detect default git branch instead of hardcoding 'main'"
```

---

### Task 4: Truncate large workspace files in agent runner

**Problem:** `_readWorkspaceFiles` in `server/runner/adapters/claude-code.js` reads ALL `.md` and `.json` workspace files with no size limit. One large file (screenshot JSON, verbose test output) can exceed the model's context window and crash the agent.

**Files:**
- Modify: `server/runner/adapters/claude-code.js` (the `_readWorkspaceFiles` method, lines 96–106)

**Interfaces:**
- No interface changes — internal method

- [ ] **Step 1: Read the current method**

```js
_readWorkspaceFiles(workspacePath) {
  if (!workspacePath || !fs.existsSync(workspacePath)) return ''
  const files = fs.readdirSync(workspacePath)
    .filter(f => f.endsWith('.md') || f.endsWith('.json'))
    .filter(f => !f.startsWith('QA_EVIDENCE'))

  return files.map(f => {
    const content = fs.readFileSync(path.join(workspacePath, f), 'utf8')
    return `### ${f}\n${content}`
  }).join('\n\n')
}
```

- [ ] **Step 2: Replace with size-limited version**

```js
_readWorkspaceFiles(workspacePath) {
  const FILE_LIMIT  = 20 * 1024  // 20 KB per file
  const TOTAL_LIMIT = 80 * 1024  // 80 KB total

  if (!workspacePath || !fs.existsSync(workspacePath)) return ''
  const files = fs.readdirSync(workspacePath)
    .filter(f => f.endsWith('.md') || f.endsWith('.json'))
    .filter(f => !f.startsWith('QA_EVIDENCE'))

  let total = 0
  const parts = []
  for (const f of files) {
    if (total >= TOTAL_LIMIT) {
      parts.push(`### ${f}\n[omitted — total workspace context limit reached]`)
      continue
    }
    let content = fs.readFileSync(path.join(workspacePath, f), 'utf8')
    if (content.length > FILE_LIMIT) {
      content = content.slice(0, FILE_LIMIT) + `\n\n[truncated — file exceeded ${FILE_LIMIT / 1024}KB]`
    }
    total += content.length
    parts.push(`### ${f}\n${content}`)
  }
  return parts.join('\n\n')
}
```

- [ ] **Step 3: Verify clean require**

```bash
node -e "require('./server/runner/adapters/claude-code')"
```
Expected: no output

- [ ] **Step 4: Commit**

```bash
git add server/runner/adapters/claude-code.js
git commit -m "fix: truncate large workspace files to prevent agent context overflow"
```

---

### Task 5: Validate `local_path` on project creation

**Problem:** `POST /api/projects` accepts any string as `local_path` without checking if it's a real directory or a git repo. Later, orchestrator fails cryptically when trying to create worktrees.

**Files:**
- Modify: `server/routes/projects.js`

**Interfaces:**
- No new exports; changes are inside POST and PUT handlers

- [ ] **Step 1: Add validation helper**

At the top of `server/routes/projects.js` after the requires, add:
```js
const fs   = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

function validateLocalPath(local_path) {
  if (!fs.existsSync(local_path))       return 'local_path does not exist'
  if (!fs.statSync(local_path).isDirectory()) return 'local_path is not a directory'
  const result = spawnSync('git', ['-C', local_path, 'rev-parse', '--git-dir'], { encoding: 'utf8' })
  if (result.status !== 0)              return 'local_path is not a git repository'
  return null
}
```

- [ ] **Step 2: Call validator in POST handler**

In the POST route, after the `if (!name || !local_path)` check, add:
```js
const pathError = validateLocalPath(local_path)
if (pathError) return res.status(400).json({ error: pathError })
```

The full POST handler becomes:
```js
router.post('/', (req, res) => {
  const { name, local_path, git_url, description, internal_port, health_check, test_command } = req.body
  if (!name || !local_path) return res.status(400).json({ error: 'name and local_path required' })
  const pathError = validateLocalPath(local_path)
  if (pathError) return res.status(400).json({ error: pathError })
  const id = uuid()
  db.prepare(`INSERT INTO projects (id,name,local_path,git_url,description,internal_port,health_check,test_command)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, name, local_path, git_url||null, description||null,
         internal_port||80, health_check||'/health', test_command||'php artisan test')
  res.json(db.prepare('SELECT * FROM projects WHERE id=?').get(id))
})
```

Also add in PUT handler after the destructuring:
```js
if (local_path) {
  const pathError = validateLocalPath(local_path)
  if (pathError) return res.status(400).json({ error: pathError })
}
```

- [ ] **Step 3: Verify clean require**

```bash
node -e "require('./server/routes/projects')"
```
Expected: no output

- [ ] **Step 4: Commit**

```bash
git add server/routes/projects.js
git commit -m "fix: validate local_path is a real git repo on project create/update"
```

---

### Task 6: Clean up stale port allocations on startup

**Problem:** If `envManager.stop()` fails silently (docker crash, process kill), the port is never released from `allocated_ports` table. Over time, the range fills and QA tasks fail with "No free ports."

**Fix:** On orchestrator startup, delete any `allocated_ports` rows for tasks that are no longer in an active Docker-using state (done, failed, or not in qa_active).

**Files:**
- Modify: `server/environment/port-allocator.js`
- Modify: `server/index.js` (call the cleanup on startup)

**Interfaces:**
- Produces: `cleanup()` — synchronous function, exported from port-allocator.js; deletes stale rows; called once at startup

- [ ] **Step 1: Add `cleanup` to port-allocator.js**

At the end of `server/environment/port-allocator.js`, before `module.exports`, add:
```js
// Called once at startup to remove ports for tasks that are no longer QA-active
function cleanup() {
  const freed = db.prepare(`
    DELETE FROM allocated_ports
    WHERE task_id NOT IN (
      SELECT id FROM tasks WHERE status = 'qa_active'
    )
  `).run()
  if (freed.changes > 0) {
    console.log(`[ports] released ${freed.changes} stale port allocation(s)`)
  }
}
```

Update `module.exports`:
```js
module.exports = { allocate, release, getPort, cleanup }
```

- [ ] **Step 2: Call `cleanup()` in `server/index.js` before starting the orchestrator loop**

In `server/index.js`, in the `main()` function, find where `orchestrator.startLoop()` is called and add the cleanup call just before it:
```js
const portAllocator = require('./environment/port-allocator')
portAllocator.cleanup()
orchestrator.startLoop()
```

(Add the `require` near the top of main() with the other local requires, or at the top of the file.)

- [ ] **Step 3: Verify clean require**

```bash
node -e "require('./server/environment/port-allocator')"
```
Expected: no output

- [ ] **Step 4: Commit**

```bash
git add server/environment/port-allocator.js server/index.js
git commit -m "fix: clean up stale port allocations on startup"
```

---

### Task 7: Task cancellation — API + UI

**Problem:** Once a task is started, there is no way to abort it. The only option is to wait for failure after max retries. Need a Cancel button that stops the task immediately.

**Approach:** Mark task as `failed` in the DB with a "Cancelled by user" log entry. The running agent (claude CLI process) will complete but its result is discarded by `processTask` — by the time it finishes, the task is already `failed` and the `inFlight.delete()` in `.finally()` will clean it up. No process kill needed for an initial implementation.

**Files:**
- Modify: `server/orchestrator/index.js` — add `cancelTask` function and export it
- Modify: `server/routes/tasks.js` — add `DELETE /:id` or `POST /:id/cancel` route
- Modify: `ui/app.js` — add cancel button logic
- Modify: `ui/index.html` — add cancel button element

**Interfaces:**
- Produces: `orchestrator.cancelTask(taskId)` — synchronous; marks task `failed`, broadcasts update
- Produces: `POST /api/tasks/:id/cancel` — returns `{ ok: true }`

- [ ] **Step 1: Add `cancelTask` to `server/orchestrator/index.js`**

In `index.js`, after `acceptTask`, add:
```js
function cancelTask(taskId) {
  log(taskId, 'orchestrator', 'failed', 'Cancelled by user')
  db.prepare(`UPDATE tasks SET status = 'failed', updated_at = unixepoch() WHERE id = ?`).run(taskId)
  broadcast({ type: 'task_update', task: getTask(taskId) })
}
```

Update `module.exports` at the bottom:
```js
module.exports = { startLoop, setBroadcast, createTask, startTask, answerPMQuestions, acceptTask, cancelTask }
```

- [ ] **Step 2: Add `POST /api/tasks/:id/cancel` route to `server/routes/tasks.js`**

After the accept route, add:
```js
// Cancel task (any active status → failed)
router.post('/:id/cancel', (req, res) => {
  orchestrator.cancelTask(req.params.id)
  res.json({ ok: true })
})
```

- [ ] **Step 3: Add Cancel button to task modal in `ui/index.html`**

Find the section with `btn-accept-task` and `btn-answer-pm` buttons in `ui/index.html`. Add after them:
```html
<button id="btn-cancel-task" class="btn-danger" onclick="cancelTask()" style="display:none">Cancel</button>
```

- [ ] **Step 4: Wire Cancel button in `ui/app.js`**

In `openTaskModal`, find where the other buttons' `style.display` are set (around line 147):
```js
document.getElementById('btn-start-task').style.display    = task.status === 'inbox' ? '' : 'none'
document.getElementById('btn-accept-task').style.display   = task.status === 'awaiting_acceptance' ? '' : 'none'
document.getElementById('btn-answer-pm').style.display     = task.status === 'pm_questioning' ? '' : 'none'
```

Add:
```js
const cancellable = !['inbox','awaiting_acceptance','done','failed'].includes(task.status)
document.getElementById('btn-cancel-task').style.display = cancellable ? '' : 'none'
```

Add the `cancelTask` async function after `acceptTask`:
```js
async function cancelTask() {
  if (!confirm('Cancel this task?')) return
  const id = document.getElementById('task-modal').dataset.taskId
  await api('POST', `/tasks/${id}/cancel`)
  closeModal('task-modal')
}
```

- [ ] **Step 5: Add `.btn-danger` style to `ui/style.css`**

Find where `.btn-secondary` is defined and add nearby:
```css
.btn-danger {
  background: #dc3545;
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 6px 14px;
  cursor: pointer;
  font-size: 13px;
}
.btn-danger:hover { background: #c82333; }
```

- [ ] **Step 6: Verify**

```bash
node -e "require('./server/orchestrator/index'); require('./server/routes/tasks')"
```
Expected: no output

- [ ] **Step 7: Commit**

```bash
git add server/orchestrator/index.js server/routes/tasks.js ui/app.js ui/index.html ui/style.css
git commit -m "feat: add task cancellation — Cancel button in UI, POST /api/tasks/:id/cancel"
```

---

### Task 8: Retry failed tasks + workspace cleanup after done

**Problem A:** Failed tasks can only be retried by directly editing the DB. Need a Retry button.

**Problem B:** `workspace/{taskId}/` directories accumulate forever. Need cleanup after tasks complete.

**Fix A:** Retry resets task status to `pm_active` and retry_count to 0 (restarts full pipeline). This is safer than trying to resume mid-pipeline.

**Fix B:** On `acceptTask` and after cancel, schedule workspace deletion after the task is marked done (immediate delete is fine — the data is in DB logs and git).

**Files:**
- Modify: `server/orchestrator/index.js` — add `retryTask`, update `acceptTask` and `cancelTask` to clean workspace
- Modify: `server/orchestrator/context.js` — add `deleteWorkspace(taskId)` helper
- Modify: `server/routes/tasks.js` — add `POST /:id/retry`
- Modify: `ui/app.js` — add Retry button logic
- Modify: `ui/index.html` — add Retry button element

**Interfaces:**
- Produces: `context.deleteWorkspace(taskId)` — deletes `workspace/{taskId}/` recursively
- Produces: `orchestrator.retryTask(taskId)` — resets to pm_active
- Produces: `POST /api/tasks/:id/retry`

- [ ] **Step 1: Add `deleteWorkspace` to `server/orchestrator/context.js`**

At the end of `context.js`, before `module.exports`, add:
```js
function deleteWorkspace(taskId) {
  const dir = taskDir(taskId)
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
```

Add to `module.exports`:
```js
module.exports = { init, write, read, exists, listFiles, taskDir, evidenceDir, listEvidenceFiles, worktreeDir, deleteWorkspace }
```

- [ ] **Step 2: Add `retryTask` to `server/orchestrator/index.js`**

After `cancelTask`, add:
```js
function retryTask(taskId) {
  db.prepare(`UPDATE tasks SET status = 'pm_active', retry_count = 0, current_agent = 'pm', updated_at = unixepoch() WHERE id = ?`).run(taskId)
  log(taskId, 'orchestrator', 'started', 'Retried by user — restarting from PM')
  broadcast({ type: 'task_update', task: getTask(taskId) })
}
```

Add `retryTask` to `module.exports`.

- [ ] **Step 3: Call `deleteWorkspace` in `acceptTask` and `cancelTask`**

In `acceptTask`, after the DB update and before `broadcast`:
```js
context.deleteWorkspace(taskId)
```

In `cancelTask`, after the DB update and before `broadcast`:
```js
context.deleteWorkspace(taskId)
```

- [ ] **Step 4: Add `POST /api/tasks/:id/retry` to `server/routes/tasks.js`**

After the cancel route:
```js
// Retry failed task (failed → pm_active)
router.post('/:id/retry', (req, res) => {
  const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(req.params.id)
  if (!task || task.status !== 'failed') return res.status(400).json({ error: 'task must be in failed status' })
  orchestrator.retryTask(req.params.id)
  res.json({ ok: true })
})
```

- [ ] **Step 5: Add Retry button in `ui/index.html`**

After the Cancel button:
```html
<button id="btn-retry-task" class="btn-secondary" onclick="retryTask()" style="display:none">Retry</button>
```

- [ ] **Step 6: Wire Retry button in `ui/app.js`**

In `openTaskModal`, add:
```js
document.getElementById('btn-retry-task').style.display = task.status === 'failed' ? '' : 'none'
```

Add the `retryTask` function:
```js
async function retryTask() {
  const id = document.getElementById('task-modal').dataset.taskId
  await api('POST', `/tasks/${id}/retry`)
  closeModal('task-modal')
}
```

- [ ] **Step 7: Verify**

```bash
node -e "require('./server/orchestrator/context'); require('./server/orchestrator/index'); require('./server/routes/tasks')"
```
Expected: no output

- [ ] **Step 8: Commit**

```bash
git add server/orchestrator/index.js server/orchestrator/context.js server/routes/tasks.js ui/app.js ui/index.html
git commit -m "feat: add retry button for failed tasks, delete workspace on accept/cancel"
```

---

### Task 9: Agent logs rotation

**Problem:** `agent_logs` table grows unbounded. On a long-running orchestrator with many tasks, this fills the SQLite file and slows queries.

**Fix:** After inserting a new log entry, delete entries for that task if the count exceeds 200. Keep the most recent 200 per task.

**Files:**
- Modify: `server/orchestrator/index.js` — update the `log()` helper function

**Interfaces:**
- No interface changes — `log()` is internal

- [ ] **Step 1: Find the current `log` function**

In `server/orchestrator/index.js`:
```js
function log(taskId, agent, status, message) {
  db.prepare('INSERT INTO agent_logs (id, task_id, agent, status, message) VALUES (?, ?, ?, ?, ?)')
    .run(uuid(), taskId, agent, status, message || '')
}
```

- [ ] **Step 2: Add rotation after insert**

```js
const MAX_LOGS_PER_TASK = 200

function log(taskId, agent, status, message) {
  db.prepare('INSERT INTO agent_logs (id, task_id, agent, status, message) VALUES (?, ?, ?, ?, ?)')
    .run(uuid(), taskId, agent, status, message || '')
  // Keep only the most recent MAX_LOGS_PER_TASK entries per task
  db.prepare(`
    DELETE FROM agent_logs
    WHERE task_id = ? AND id NOT IN (
      SELECT id FROM agent_logs WHERE task_id = ?
      ORDER BY created_at DESC LIMIT ?
    )
  `).run(taskId, taskId, MAX_LOGS_PER_TASK)
}
```

- [ ] **Step 3: Verify clean require**

```bash
node -e "require('./server/orchestrator/index')"
```
Expected: no output

- [ ] **Step 4: Commit**

```bash
git add server/orchestrator/index.js
git commit -m "fix: rotate agent_logs to keep max 200 entries per task"
```

---

## Self-Review

**Spec coverage check:**
- ✅ QA COMPOSE_PREFIX — Task 1
- ✅ TEST_COMMAND pass-through — Task 1
- ✅ Hardcoded PHP/Laravel in agent prompts — Task 2
- ✅ Hardcoded "main" branch — Task 3
- ✅ Workspace file size limits — Task 4
- ✅ local_path validation — Task 5
- ✅ Port cleanup on startup — Task 6
- ✅ Task cancellation — Task 7
- ✅ Retry failed tasks — Task 8
- ✅ Workspace cleanup after done — Task 8
- ✅ Log rotation — Task 9
- ✅ Developer prompt mentions branch is pre-created — Task 2 (developer.md step 9)

**Notes:**
- `test-runner.js` Playwright wiring is intentionally deferred — the QA agent already runs Playwright itself with `--dangerously-skip-permissions`. Wiring the orchestrator-side runner is Plan 2 scope.
- UI `btn-danger` class might already exist in style.css — implementer should check before adding.
- `deleteWorkspace` in `acceptTask` deletes worktree AND workspace. The worktree removal via `gitHelper.removeWorktree` is already done in `acceptTask`; workspace is separate (`workspace/{taskId}/` outside git).
