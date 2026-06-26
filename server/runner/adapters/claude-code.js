const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const AgentRunner = require('../interface')

// Default model per agent — override any via .env (e.g. AGENT_MODEL_ARCHITECT=claude-opus-4-8)
const AGENT_MODELS = {
  pm:        process.env.AGENT_MODEL_PM        || 'claude-sonnet-4-6',
  architect: process.env.AGENT_MODEL_ARCHITECT || 'claude-opus-4-8',
  developer: process.env.AGENT_MODEL_DEVELOPER || 'claude-sonnet-4-6',
  qa:        process.env.AGENT_MODEL_QA        || 'claude-sonnet-4-6',
  tests:     process.env.AGENT_MODEL_TESTS     || 'claude-sonnet-4-6',
  reviewer:  process.env.AGENT_MODEL_REVIEWER  || 'claude-opus-4-8',
}

class ClaudeCodeAdapter extends AgentRunner {
  constructor() {
    super()
    this.claudeBin = process.env.CLAUDE_BIN || 'claude'
    this.claudeFlags = (process.env.CLAUDE_FLAGS || '--dangerously-skip-permissions').split(' ').filter(Boolean)
    this.agentsDir = path.resolve(__dirname, '../../agents')
  }

  async run(agentName, context) {
    const agentPromptPath = path.join(this.agentsDir, `${agentName}.md`)
    if (!fs.existsSync(agentPromptPath)) {
      throw new Error(`Agent prompt not found: ${agentPromptPath}`)
    }

    const model = AGENT_MODELS[agentName] || 'claude-sonnet-4-6'
    const agentRole = fs.readFileSync(agentPromptPath, 'utf8')
    const prompt = this._buildPrompt(agentRole, context)

    const args = [
      ...this.claudeFlags,
      '--model', model,
      '-p', prompt,
      '--output-format', 'text'
    ]

    return new Promise((resolve, reject) => {
      const cwd = context.projectPath || context.workspacePath
      const proc = spawn(this.claudeBin, args, {
        cwd,
        env: { ...process.env, ...context.env },
        timeout: 20 * 60 * 1000 // 20 min max per agent
      })

      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', d => { stdout += d.toString() })
      proc.stderr.on('data', d => { stderr += d.toString() })

      proc.on('error', err => reject(new Error(`Failed to spawn claude: ${err.message}`)))

      proc.on('close', code => {
        if (code !== 0) {
          reject(new Error(`Claude exited with code ${code}:\n${stderr}`))
          return
        }

        // Parse status from last line: "STATUS: done|questions|failed"
        const statusMatch = stdout.match(/^STATUS:\s*(done|questions|failed)/m)
        const status = statusMatch ? statusMatch[1] : 'done'
        const message = stdout.replace(/^STATUS:.*$/m, '').trim()

        resolve({ status, message, raw: stdout })
      })
    })
  }

  _buildPrompt(agentRole, context) {
    const { taskId, workspacePath, serviceUrl, extra } = context

    const workspaceFiles = this._readWorkspaceFiles(workspacePath)

    return `${agentRole}

---
## WORKSPACE: ${workspacePath}

${workspaceFiles}

${serviceUrl ? `## SERVICE URL\n${serviceUrl}\n` : ''}
${extra ? `## ADDITIONAL CONTEXT\n${extra}\n` : ''}

---
Do your work now. When finished, write all output files to the workspace directory shown above.
On the very last line of your response write exactly:
STATUS: done
or STATUS: questions (if you need human input)
or STATUS: failed (if blocked)`
  }

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
}

// Stub for future Codex adapter (same interface)
class CodexAdapter extends AgentRunner {
  async run(agentName, context) {
    throw new Error('Codex adapter not yet implemented. Switch AGENT_ADAPTER=claude-code in .env')
  }
}

function createAdapter() {
  const type = process.env.AGENT_ADAPTER || 'claude-code'
  if (type === 'claude-code') return new ClaudeCodeAdapter()
  if (type === 'codex') return new CodexAdapter()
  throw new Error(`Unknown adapter: ${type}`)
}

module.exports = { ClaudeCodeAdapter, CodexAdapter, createAdapter, AGENT_MODELS }
