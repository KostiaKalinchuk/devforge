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
      '--output-format', 'json'
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

        let parsed = {}
        try { parsed = JSON.parse(stdout) } catch (_) {}

        // text content — fall back to raw stdout if JSON parse failed
        const text = parsed.result || stdout

        // cost — try both common field names (CLI uses total_cost_usd)
        const costUsd = parsed.total_cost_usd ?? parsed.cost_usd ?? null

        // duration
        const durationMs = parsed.duration_ms ?? null

        // tokens — try flat fields first, then nested usage object
        const usage = parsed.usage || {}
        const tokensIn  = parsed.input_tokens  ?? parsed.tokens_in  ?? usage.input_tokens  ?? null
        const tokensOut = parsed.output_tokens ?? parsed.tokens_out ?? usage.output_tokens ?? null

        // parse STATUS from the text content
        const statusMatch = text.match(/^STATUS:\s*(done|questions|failed)/m)
        const status  = statusMatch ? statusMatch[1] : 'done'
        const message = text.replace(/^STATUS:.*$/m, '').trim()

        resolve({ status, message, raw: stdout, tokensIn, tokensOut, costUsd, durationMs })
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
    const MAX_FILE_CHARS = 40_000
    const files = fs.readdirSync(workspacePath)
      .filter(f => f.endsWith('.md') || f.endsWith('.json'))
      .filter(f => !f.startsWith('QA_EVIDENCE'))

    return files.map(f => {
      let content = fs.readFileSync(path.join(workspacePath, f), 'utf8')
      if (content.length > MAX_FILE_CHARS) {
        content = content.slice(0, MAX_FILE_CHARS) + `\n\n[...truncated — ${content.length} chars total]`
      }
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
