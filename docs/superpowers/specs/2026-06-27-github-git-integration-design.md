# Git Integration Design

**Date:** 2026-06-27  
**Status:** Approved

## Problem

The developer agent currently creates a feature branch ad-hoc inside its own prompt logic. There is no guarantee it branches from `main`, and there is no mechanism to push the finished branch to the remote after human acceptance.

## Solution

The orchestrator owns all git lifecycle operations. Agents do not touch branch creation or push.

## Behaviour

1. **Branch creation** — when a task first enters `dev_active` (not on retry), the orchestrator creates `devforge/<TASK_SHORT_ID>` branching from the latest `main` on the project's local repo.
2. **Push** — when the human clicks "Accept" (`acceptTask()`), the orchestrator pushes `devforge/<TASK_SHORT_ID>` to `origin` before setting status to `done`.

## Architecture

### New file: `server/orchestrator/git.js`

Two exported functions:

```js
checkoutBranchFromMain(repoPath, branchName)
// git fetch origin, checkout main, pull, checkout -b branchName
// If branch already exists (retry scenario), just checkout without -b

pushBranch(repoPath, branchName)
// git push origin branchName
```

Uses `simple-git` (already a project dependency).

### Changes to `server/orchestrator/index.js`

- In `processTask()`: before dispatching the developer agent, when `task.status === 'dev_active'` and `task.retry_count === 0`, call `checkoutBranchFromMain(task.local_path, task.branch)`.
- In `acceptTask()`: call `pushBranch(task.local_path, task.branch)` before the DB update. If push fails, log the error but still mark the task done (non-blocking).

### Changes to `server/agents/developer.md`

Remove step "Set up or switch to the feature branch" — the branch already exists when the agent runs.

## Error handling

- `checkoutBranchFromMain` failure → fail the task (same as any agent error).
- `pushBranch` failure → log warning, proceed to `done` anyway. The branch is local and code is not lost.

## Out of scope

- Creating GitHub PRs
- Authentication setup (assumed: remote already configured with push access in the local repo)
- Branch protection / force-push handling
