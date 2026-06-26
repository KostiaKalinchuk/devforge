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
