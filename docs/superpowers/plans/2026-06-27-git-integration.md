# Git Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Orchestrator creates feature branch from `main` before dev agent runs and pushes it to remote when human accepts the task.

**Architecture:** New `server/orchestrator/git.js` module wraps `simple-git`. Orchestrator calls it at two points: before dispatching the developer agent (first run only), and inside `acceptTask()` before marking done. Developer agent prompt no longer handles branch creation.

**Tech Stack:** Node.js, `simple-git` (already in `package.json`)

## Global Constraints

- No new npm dependencies — use `simple-git` already installed
- Push errors are non-fatal: log warning, continue to `done`
- Branch name format stays `devforge/<TASK_SHORT_ID>` (matches existing `tasks.branch` column, e.g. `devforge/abc12345`)

---

### Task 1: Create `server/orchestrator/git.js`

**Files:**
- Create: `server/orchestrator/git.js`

**Interfaces:**
- Produces:
  - `checkoutBranchFromMain(repoPath, branchName): Promise<void>` — throws on failure
  - `pushBranch(repoPath, branchName): Promise<void>` — throws on failure

- [ ] **Step 1: Create the file**

```js
// server/orchestrator/git.js
const simpleGit = require('simple-git')

async function checkoutBranchFromMain(repoPath, branchName) {
  const git = simpleGit(repoPath)
  await git.fetch('origin').catch(() => {}) // best-effort; repo may be local-only
  await git.checkout('main')
  await git.pull('origin', 'main').catch(() => {}) // best-effort
  const branches = await git.branchLocal()
  if (branches.all.includes(branchName)) {
    await git.checkout(branchName)
  } else {
    await git.checkoutLocalBranch(branchName)
  }
}

async function pushBranch(repoPath, branchName) {
  const git = simpleGit(repoPath)
  await git.push('origin', branchName)
}

module.exports = { checkoutBranchFromMain, pushBranch }
```

- [ ] **Step 2: Smoke-test the module loads without error**

```bash
cd /Users/kostiantynkalinchuk/localhost/devforge
node -e "const g = require('./server/orchestrator/git'); console.log(Object.keys(g))"
```

Expected output: `[ 'checkoutBranchFromMain', 'pushBranch' ]`

- [ ] **Step 3: Commit**

```bash
git -C /Users/kostiantynkalinchuk/localhost/devforge add server/orchestrator/git.js
git -C /Users/kostiantynkalinchuk/localhost/devforge commit -m "feat: add git helper for branch creation and push"
```

---

### Task 2: Wire branch creation into `processTask()`

**Files:**
- Modify: `server/orchestrator/index.js` — add `require` at top, add branch creation block inside `processTask()`

**Interfaces:**
- Consumes: `checkoutBranchFromMain(repoPath, branchName)` from `./git`

The block goes **after** the QA environment setup and **before** the `runner.run()` call, guarded by `task.status === 'dev_active' && task.retry_count === 0`.

- [ ] **Step 1: Add require at top of `server/orchestrator/index.js`**

After the existing requires (around line 6), add:

```js
const gitHelper = require('./git')
```

- [ ] **Step 2: Add branch creation block inside `processTask()`**

In `server/orchestrator/index.js`, inside `processTask()`, find the comment `// Run agent via Claude Code CLI` (line ~77). Insert the following block immediately before it:

```js
  // For Developer (first run): create feature branch from main
  if (task.status === 'dev_active' && task.retry_count === 0) {
    await gitHelper.checkoutBranchFromMain(task.local_path, task.branch)
    log(task.id, 'orchestrator', 'started', `Checked out branch ${task.branch} from main`)
  }
```

- [ ] **Step 3: Verify server still starts**

```bash
cd /Users/kostiantynkalinchuk/localhost/devforge
node -e "require('./server/orchestrator/index')" 2>&1 | head -5
```

Expected: no error output (module loads cleanly).

- [ ] **Step 4: Commit**

```bash
git -C /Users/kostiantynkalinchuk/localhost/devforge add server/orchestrator/index.js
git -C /Users/kostiantynkalinchuk/localhost/devforge commit -m "feat: checkout branch from main before developer agent runs"
```

---

### Task 3: Wire push into `acceptTask()`

**Files:**
- Modify: `server/orchestrator/index.js` — make `acceptTask` async, add push before DB update

**Interfaces:**
- Consumes: `pushBranch(repoPath, branchName)` from `./git`
- Consumes: `getTask(taskId)` — already defined in same file, returns task row with `local_path` and `branch`

- [ ] **Step 1: Update `acceptTask()` in `server/orchestrator/index.js`**

Replace the current `acceptTask` function (lines 154–157):

```js
// BEFORE:
function acceptTask(taskId) {
  db.prepare(`UPDATE tasks SET status = 'done', updated_at = unixepoch() WHERE id = ?`).run(taskId)
  broadcast({ type: 'task_update', task: getTask(taskId) })
}
```

With:

```js
// AFTER:
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

- [ ] **Step 2: Verify server still starts**

```bash
cd /Users/kostiantynkalinchuk/localhost/devforge
node -e "require('./server/orchestrator/index')" 2>&1 | head -5
```

Expected: no error output.

- [ ] **Step 3: Commit**

```bash
git -C /Users/kostiantynkalinchuk/localhost/devforge add server/orchestrator/index.js
git -C /Users/kostiantynkalinchuk/localhost/devforge commit -m "feat: push branch to origin when task is accepted"
```

---

### Task 4: Update developer agent prompt

**Files:**
- Modify: `server/agents/developer.md` — remove "Set up or switch to the feature branch" section (step 2), renumber remaining steps

**Interfaces:** none

- [ ] **Step 1: Remove branch setup section from `server/agents/developer.md`**

Delete the entire section "### 2. Set up or switch to the feature branch" including the code block:

```markdown
### 2. Set up or switch to the feature branch
```bash
git fetch origin 2>/dev/null || true
# If branch already exists (retry run), just switch to it
if git show-ref --quiet refs/heads/devforge/<TASK_ID>; then
  git checkout devforge/<TASK_ID>
else
  git checkout -b devforge/<TASK_ID>
fi
```
```

Replace the remaining step numbers so they run 2→7 instead of 3→8 (i.e. shift each `### N.` down by one).

Also update the commit command in step 7 (was step 8) to keep it consistent — no change to the command itself, just the heading number.

- [ ] **Step 2: Verify the file looks correct**

```bash
grep "^### " /Users/kostiantynkalinchuk/localhost/devforge/server/agents/developer.md
```

Expected:
```
### 1. Read TASK.md and extract the task ID
### 2. Read all input files
### 3. Implement following `TECH_PLAN.md` step by step
### 4. Write `IMPLEMENTATION.md` to workspace with:
### 5. Run linter/formatter if available
### 6. Run tests to make sure nothing is broken
### 7. Commit to the feature branch
```

- [ ] **Step 3: Commit**

```bash
git -C /Users/kostiantynkalinchuk/localhost/devforge add server/agents/developer.md
git -C /Users/kostiantynkalinchuk/localhost/devforge commit -m "feat: remove manual branch setup from developer agent (orchestrator now handles it)"
```
