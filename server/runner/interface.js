/**
 * Abstract Agent Runner Interface.
 * Swap the adapter (claude-code, codex, etc.) without touching orchestrator logic.
 */
class AgentRunner {
  /**
   * @param {string} agentName  - e.g. 'pm', 'architect', 'developer'
   * @param {object} context    - { taskId, projectPath, workspacePath, extra }
   * @returns {Promise<{ status: 'done'|'questions'|'failed', message: string }>}
   */
  async run(agentName, context) {
    throw new Error('AgentRunner.run() must be implemented by adapter')
  }
}

module.exports = AgentRunner
