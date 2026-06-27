const simpleGit = require('simple-git')
const fs = require('fs')

// Serialize worktree creation per repo path to avoid index.lock collisions
// when two tasks on the same project start simultaneously.
const repoLocks = new Map()

function withRepoLock(repoPath, fn) {
  const current = repoLocks.get(repoPath) || Promise.resolve()
  const next = current.then(fn)
  repoLocks.set(repoPath, next.catch(() => {}))
  return next
}

async function createWorktree(repoPath, branchName, worktreePath) {
  return withRepoLock(repoPath, () => _createWorktree(repoPath, branchName, worktreePath))
}

async function _createWorktree(repoPath, branchName, worktreePath) {
  if (fs.existsSync(worktreePath)) return  // idempotent — retry runs reuse existing worktree

  const git = simpleGit(repoPath)
  await git.fetch('origin').catch(() => {})        // best-effort; local-only repos won't have origin
  await git.pull('origin', 'main').catch(() => {}) // best-effort
  await git.raw(['worktree', 'prune']).catch(() => {}) // clean stale metadata from crashed runs

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
