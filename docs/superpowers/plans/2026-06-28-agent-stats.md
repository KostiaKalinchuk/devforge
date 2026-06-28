# Agent Statistics Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture per-agent token usage, cost, and context-window % from every Claude CLI invocation and display them on a dedicated Stats page in the DevForge UI.

**Architecture:** Switch the agent runner from `--output-format text` to `--output-format json` to receive structured cost/token data; persist it in four new `agent_logs` columns via a startup migration; expose a `GET /api/stats` endpoint; render a new Stats page in the existing single-page UI.

**Tech Stack:** Node.js/Express, sql.js (SQLite in-memory), vanilla JS/HTML/CSS.

## Global Constraints

- No new npm packages.
- `agent_logs` schema change is additive only (ALTER TABLE ADD COLUMN) — existing rows get NULL for the new columns and must not break any existing queries.
- Context window limit for all models: 200 000 tokens. `context_pct = tokens_in / 200000 * 100`, rounded to one decimal.
- Cost display: individual rows show 4 decimal places (`$0.0012`); totals show 2 decimal places (`$1.23`). Zero / null values show `—`.
- Stats page is read-only; no user actions.
- Server entry point: `server/index.js`. DB wrapper: `server/db.js` (sql.js pattern — in-memory, flushed to `devforge.db` on every write).

---

## File Map

| File | Change |
|------|--------|
| `server/db.js` | Add startup migration: 4 new columns on `agent_logs` |
| `server/runner/adapters/claude-code.js` | Switch to `--output-format json`; parse token/cost fields; return them in resolve object |
| `server/orchestrator/index.js` | Update `log()` signature to accept stats; INSERT the 4 new columns |
| `server/routes/stats.js` | New file — `GET /api/stats` endpoint |
| `server/index.js` | Register `app.use('/api/stats', require('./routes/stats'))` |
| `ui/index.html` | Add "📊 Stats" button to topbar; add `<div id="stats-view">` below kanban |
| `ui/app.js` | Add `loadStats()`, collapsible task rows, nav toggle between kanban and stats |
| `ui/style.css` | Stats page layout and table styles |

---

## Task 1: DB migration — add stats columns to agent_logs

**Files:**
- Modify: `server/db.js`

**Interfaces:**
- Produces: `agent_logs` table with columns `tokens_in INTEGER`, `tokens_out INTEGER`, `cost_usd REAL`, `duration_ms INTEGER`. These are nullable — old rows have NULL.

- [ ] **Step 1: Add migration function to `server/db.js`**

After the existing `_save()` function definition (line ~70), add a `_migrate()` function and call it at the end of `init()`:

```js
function _migrate() {
  const cols = _db.prepare('PRAGMA table_info(agent_logs)').all
    ? (() => { const r = [], s = _db.prepare('PRAGMA table_info(agent_logs)'); while(s.step()) r.push(s.getAsObject()); s.free(); return r })()
    : []
  const names = cols.map(c => c.name)
  if (!names.includes('tokens_in'))   _db.run('ALTER TABLE agent_logs ADD COLUMN tokens_in   INTEGER')
  if (!names.includes('tokens_out'))  _db.run('ALTER TABLE agent_logs ADD COLUMN tokens_out  INTEGER')
  if (!names.includes('cost_usd'))    _db.run('ALTER TABLE agent_logs ADD COLUMN cost_usd    REAL')
  if (!names.includes('duration_ms')) _db.run('ALTER TABLE agent_logs ADD COLUMN duration_ms INTEGER')
  _save()
}
```

Update the `init()` function to call `_migrate()` after `_db.run(SCHEMA)`:

```js
async function init() {
  const SQL = await initSqlJs()
  if (fs.existsSync(DB_PATH)) {
    _db = new SQL.Database(fs.readFileSync(DB_PATH))
  } else {
    _db = new SQL.Database()
  }
  _db.run(SCHEMA)
  _migrate()
  _save()
  return _db
}
```

- [ ] **Step 2: Verify migration runs without error**

```bash
cd /Users/kostiantynkalinchuk/localhost/devforge
node -e "require('./server/db').init().then(() => { const {db} = require('./server/db'); const cols = db.prepare('PRAGMA table_info(agent_logs)').all(); console.log(cols.map(c=>c.name)) })"
```

Expected output includes: `[ 'id', 'task_id', 'agent', 'status', 'message', 'created_at', 'tokens_in', 'tokens_out', 'cost_usd', 'duration_ms' ]`

- [ ] **Step 3: Commit**

```bash
git add server/db.js
git commit -m "feat: add token/cost columns to agent_logs via startup migration"
```

---

## Task 2: Runner — switch to JSON output and parse stats

**Files:**
- Modify: `server/runner/adapters/claude-code.js`

**Interfaces:**
- Consumes: `--output-format json` response from `claude` CLI. The JSON object contains at minimum `result` (string — the text output) and `cost_usd` (float). Token field names vary by CLI version — the step below discovers them.
- Produces: `runner.run()` resolves with `{ status, message, raw, tokensIn, tokensOut, costUsd, durationMs }`. All four stats fields may be `null` if the CLI omits them.

- [ ] **Step 1: Discover the actual JSON shape from your CLI version**

Run a minimal invocation and print the raw JSON to confirm field names:

```bash
echo "Say hi. STATUS: done" | claude --dangerously-skip-permissions --output-format json -p "Say hi then on last line write STATUS: done" 2>/dev/null | head -c 2000
```

Inspect the output. Note the field names for:
- The text content (likely `result`)
- Input token count (may be `input_tokens`, `tokens_in`, or nested under `usage.input_tokens`)
- Output token count (may be `output_tokens`, `tokens_out`, or nested under `usage.output_tokens`)
- Cost (likely `cost_usd` or `total_cost`)
- Duration (likely `duration_ms`)

- [ ] **Step 2: Replace the `args` array and `proc.on('close')` handler in `ClaudeCodeAdapter.run()`**

Find the `args` array (currently ends with `'--output-format', 'text'`) and the `proc.on('close', ...)` block. Replace both:

```js
const args = [
  ...this.claudeFlags,
  '--model', model,
  '-p', prompt,
  '--output-format', 'json'
]
```

Replace the entire `proc.on('close', code => { ... resolve(...) })` block with:

```js
proc.on('close', code => {
  if (code !== 0) {
    reject(new Error(`Claude exited with code ${code}:\n${stderr}`))
    return
  }

  let parsed = {}
  try { parsed = JSON.parse(stdout) } catch (_) {}

  // text content
  const text = parsed.result || stdout

  // cost — try both common field names
  const costUsd = parsed.cost_usd ?? parsed.total_cost ?? null

  // duration
  const durationMs = parsed.duration_ms ?? null

  // tokens — try flat fields first, then nested usage object
  const usage = parsed.usage || {}
  const tokensIn  = parsed.input_tokens  ?? parsed.tokens_in  ?? usage.input_tokens  ?? null
  const tokensOut = parsed.output_tokens ?? parsed.tokens_out ?? usage.output_tokens ?? null

  // parse STATUS from the text
  const statusMatch = text.match(/^STATUS:\s*(done|questions|failed)/m)
  const status  = statusMatch ? statusMatch[1] : 'done'
  const message = text.replace(/^STATUS:.*$/m, '').trim()

  resolve({ status, message, raw: stdout, tokensIn, tokensOut, costUsd, durationMs })
})
```

- [ ] **Step 3: Smoke-test the runner in isolation**

```bash
node -e "
const {createAdapter} = require('./server/runner/adapters/claude-code')
const r = createAdapter()
r.run('pm', { taskId:'test', projectPath:'/tmp', workspacePath:'/tmp', env:{} })
  .then(res => console.log('status:', res.status, 'tokensIn:', res.tokensIn, 'cost:', res.costUsd))
  .catch(e => console.error(e.message))
"
```

Expected: prints `status: done tokensIn: <number or null> cost: <number or null>` without crashing. The exact values depend on the run.

If `tokensIn` and `costUsd` are both `null`, re-read the JSON from Step 1 and adjust the field names in the `resolve()` block.

- [ ] **Step 4: Commit**

```bash
git add server/runner/adapters/claude-code.js
git commit -m "feat: switch runner to --output-format json and parse token/cost stats"
```

---

## Task 3: Orchestrator — persist stats in agent_logs

**Files:**
- Modify: `server/orchestrator/index.js`

**Interfaces:**
- Consumes: `result.tokensIn`, `result.tokensOut`, `result.costUsd`, `result.durationMs` from Task 2's runner resolve object.
- Produces: `log()` function now accepts a fifth `stats` argument `{ tokensIn, tokensOut, costUsd, durationMs }` (defaults to `{}`). All callers that don't pass stats continue to work — existing calls only pass 4 args.

- [ ] **Step 1: Update the `log()` function**

Find the `log()` function (currently ~line 237). Replace it:

```js
function log(taskId, agent, status, message, stats = {}) {
  db.prepare(`INSERT INTO agent_logs
    (id, task_id, agent, status, message, tokens_in, tokens_out, cost_usd, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(uuid(), taskId, agent, status, message || '',
      stats.tokensIn   ?? null,
      stats.tokensOut  ?? null,
      stats.costUsd    ?? null,
      stats.durationMs ?? null)
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

- [ ] **Step 2: Pass stats from the runner result to the log call**

Find the line in `processTask()` that calls `log(task.id, agentName, result.status, ...)` (currently ~line 116). Replace it:

```js
log(task.id, agentName, result.status, result.message?.slice(0, 500), {
  tokensIn:   result.tokensIn,
  tokensOut:  result.tokensOut,
  costUsd:    result.costUsd,
  durationMs: result.durationMs
})
```

- [ ] **Step 3: Verify no syntax errors**

```bash
node -e "require('./server/orchestrator/index')"
```

Expected: no output (clean load).

- [ ] **Step 4: Commit**

```bash
git add server/orchestrator/index.js
git commit -m "feat: persist token/cost stats in agent_logs on each agent run"
```

---

## Task 4: Stats API endpoint

**Files:**
- Create: `server/routes/stats.js`
- Modify: `server/index.js`

**Interfaces:**
- Produces: `GET /api/stats` returns JSON:
  ```json
  {
    "totals": { "cost_usd": 1.23, "tokens_in": 450000, "tokens_out": 120000, "runs": 18 },
    "by_agent": [
      { "agent": "architect", "runs": 3, "tokens_in": 150000, "tokens_out": 40000, "cost_usd": 0.45 }
    ],
    "by_task": [
      {
        "task_id": "abc123",
        "title": "Add hello world endpoint",
        "cost_usd": 0.12,
        "tokens_in": 45000,
        "tokens_out": 12000,
        "runs": 6,
        "agents": [
          { "agent": "pm", "tokens_in": 8000, "tokens_out": 2000,
            "cost_usd": 0.02, "duration_ms": 12000, "context_pct": 4.0 }
        ]
      }
    ]
  }
  ```

- [ ] **Step 1: Create `server/routes/stats.js`**

```js
const express = require('express')
const { db }  = require('../db')
const router  = express.Router()

const CONTEXT_LIMIT = 200000

router.get('/', (req, res) => {
  // Totals
  const totals = db.prepare(`
    SELECT COUNT(*) as runs,
           COALESCE(SUM(tokens_in), 0)  as tokens_in,
           COALESCE(SUM(tokens_out), 0) as tokens_out,
           COALESCE(SUM(cost_usd), 0)   as cost_usd
    FROM agent_logs
  `).get()

  // By agent type
  const byAgent = db.prepare(`
    SELECT agent,
           COUNT(*) as runs,
           COALESCE(SUM(tokens_in), 0)  as tokens_in,
           COALESCE(SUM(tokens_out), 0) as tokens_out,
           COALESCE(SUM(cost_usd), 0)   as cost_usd
    FROM agent_logs
    GROUP BY agent
    ORDER BY SUM(cost_usd) DESC
  `).all()

  // By task — summary rows
  const taskRows = db.prepare(`
    SELECT t.id as task_id, t.title,
           COUNT(l.id) as runs,
           COALESCE(SUM(l.tokens_in), 0)  as tokens_in,
           COALESCE(SUM(l.tokens_out), 0) as tokens_out,
           COALESCE(SUM(l.cost_usd), 0)   as cost_usd
    FROM agent_logs l
    JOIN tasks t ON l.task_id = t.id
    GROUP BY t.id
    ORDER BY t.updated_at DESC
  `).all()

  // Agent breakdown per task
  const byTask = taskRows.map(task => {
    const agents = db.prepare(`
      SELECT agent,
             COALESCE(tokens_in, 0)  as tokens_in,
             COALESCE(tokens_out, 0) as tokens_out,
             COALESCE(cost_usd, 0)   as cost_usd,
             COALESCE(duration_ms, 0) as duration_ms
      FROM agent_logs
      WHERE task_id = ?
      ORDER BY created_at ASC
    `).all(task.task_id).map(a => ({
      ...a,
      context_pct: a.tokens_in
        ? Math.round((a.tokens_in / CONTEXT_LIMIT) * 1000) / 10
        : null
    }))
    return { ...task, agents }
  })

  res.json({ totals, by_agent: byAgent, by_task: byTask })
})

module.exports = router
```

- [ ] **Step 2: Register the route in `server/index.js`**

Find the line `app.use('/api/tasks', require('./routes/tasks'))` and add the stats route directly after it:

```js
app.use('/api/tasks',   require('./routes/tasks'))
app.use('/api/stats',   require('./routes/stats'))
```

- [ ] **Step 3: Test the endpoint**

Start the server: `npm run dev`

```bash
curl -s http://localhost:4000/api/stats | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log('totals:', d.totals); console.log('by_task count:', d.by_task.length)"
```

Expected: prints totals object and task count (may be 0 or more). No 500 errors.

- [ ] **Step 4: Commit**

```bash
git add server/routes/stats.js server/index.js
git commit -m "feat: add GET /api/stats endpoint with token/cost aggregation"
```

---

## Task 5: Stats page in UI

**Files:**
- Modify: `ui/index.html`
- Modify: `ui/app.js`
- Modify: `ui/style.css`

**Interfaces:**
- Consumes: `GET /api/stats` from Task 4 — shape: `{ totals, by_agent, by_task }`.
- Produces: "📊 Stats" button in topbar that toggles the kanban off and the stats-view on. Stats-view has three sections: totals bar, by-agent table, collapsible by-task table.

- [ ] **Step 1: Add Stats button and stats-view to `ui/index.html`**

In the `<div id="topbar">`, add the Stats button **before** `#btn-new-task`:

```html
<button id="btn-stats" onclick="showStats()">📊 Stats</button>
```

After the closing `</div>` of `<div id="kanban">` (and before the first modal), add the stats view:

```html
<!-- ── Stats view ── -->
<div id="stats-view" style="display:none; padding:20px; overflow-y:auto; flex:1;">
  <div id="stats-totals" class="stats-totals"></div>
  <div id="stats-by-agent" style="margin-top:24px"></div>
  <div id="stats-by-task"  style="margin-top:24px"></div>
</div>
```

- [ ] **Step 2: Add stats styles to `ui/style.css`**

Append at the end of the file:

```css
/* ── Stats ── */
#btn-stats { background: var(--bg3); border: 1px solid var(--border); color: var(--text2); padding: 6px 12px; border-radius: var(--radius); font-size: 13px; cursor: pointer; }
#btn-stats.active { border-color: var(--accent); color: var(--accent2); }

.stats-totals { display: flex; gap: 24px; background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 24px; }
.stats-total-item { display: flex; flex-direction: column; gap: 4px; }
.stats-total-label { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: var(--text2); }
.stats-total-value { font-size: 22px; font-weight: 700; color: var(--text); }

.stats-section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: var(--text2); margin-bottom: 10px; }

.stats-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.stats-table th { text-align: left; padding: 6px 10px; color: var(--text2); font-size: 10px; text-transform: uppercase; letter-spacing: .5px; border-bottom: 1px solid var(--border); }
.stats-table td { padding: 7px 10px; border-bottom: 1px solid var(--border); color: var(--text); vertical-align: top; }
.stats-table tr:last-child td { border-bottom: none; }
.stats-table tr.task-row { cursor: pointer; }
.stats-table tr.task-row:hover td { background: var(--bg3); }
.stats-table tr.agent-row td { background: var(--bg); color: var(--text2); font-size: 11px; padding-left: 28px; }
.stats-table tr.agent-row.hidden { display: none; }

.ctx-bar { display: inline-block; height: 6px; border-radius: 3px; margin-left: 6px; vertical-align: middle; }
.ctx-green  { background: var(--green); }
.ctx-yellow { background: var(--yellow); }
.ctx-red    { background: var(--red); }
```

- [ ] **Step 3: Add `showStats()`, `showKanban()`, and `loadStats()` to `ui/app.js`**

Append at the end of the file:

```js
/* ── Stats ───────────────────────────────────────────────────────────────── */
function fmt$(v) {
  if (v == null || v === 0) return '—'
  return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`
}
function fmtK(v) { if (!v) return '—'; return v >= 1000 ? `${(v/1000).toFixed(1)}k` : String(v) }
function fmtMs(v) { if (!v) return '—'; return v >= 60000 ? `${(v/60000).toFixed(1)}m` : `${(v/1000).toFixed(1)}s` }
function fmtCtx(pct) {
  if (pct == null) return '—'
  const cls = pct < 50 ? 'ctx-green' : pct < 80 ? 'ctx-yellow' : 'ctx-red'
  return `${pct.toFixed(1)}% <span class="ctx-bar ${cls}" style="width:${Math.min(pct,100)*0.6}px"></span>`
}

async function loadStats() {
  const data = await api('GET', '/stats')

  // Totals bar
  document.getElementById('stats-totals').innerHTML = `
    <div class="stats-total-item"><div class="stats-total-label">Total Cost</div><div class="stats-total-value">${fmt$(data.totals.cost_usd)}</div></div>
    <div class="stats-total-item"><div class="stats-total-label">Tokens In</div><div class="stats-total-value">${fmtK(data.totals.tokens_in)}</div></div>
    <div class="stats-total-item"><div class="stats-total-label">Tokens Out</div><div class="stats-total-value">${fmtK(data.totals.tokens_out)}</div></div>
    <div class="stats-total-item"><div class="stats-total-label">Agent Runs</div><div class="stats-total-value">${data.totals.runs}</div></div>
  `

  // By-agent table
  document.getElementById('stats-by-agent').innerHTML = `
    <div class="stats-section-title">By Agent Type</div>
    <table class="stats-table">
      <tr><th>Agent</th><th>Runs</th><th>Tokens In</th><th>Tokens Out</th><th>Cost</th></tr>
      ${data.by_agent.map(a => `
        <tr>
          <td>${esc(a.agent)}</td>
          <td>${a.runs}</td>
          <td>${fmtK(a.tokens_in)}</td>
          <td>${fmtK(a.tokens_out)}</td>
          <td>${fmt$(a.cost_usd)}</td>
        </tr>
      `).join('')}
    </table>
  `

  // By-task collapsible table
  const taskRows = data.by_task.map((task, i) => {
    const agentRows = task.agents.map(a => `
      <tr class="agent-row hidden" data-task-idx="${i}">
        <td style="padding-left:28px">↳ ${esc(a.agent)}</td>
        <td></td>
        <td>${fmtK(a.tokens_in)}</td>
        <td>${fmtK(a.tokens_out)}</td>
        <td>${fmt$(a.cost_usd)}</td>
        <td>${fmtMs(a.duration_ms)}</td>
        <td>${fmtCtx(a.context_pct)}</td>
      </tr>
    `).join('')
    return `
      <tr class="task-row" onclick="toggleTaskAgents(${i})">
        <td>▶ ${esc(task.title)}</td>
        <td>${task.runs}</td>
        <td>${fmtK(task.tokens_in)}</td>
        <td>${fmtK(task.tokens_out)}</td>
        <td>${fmt$(task.cost_usd)}</td>
        <td></td><td></td>
      </tr>
      ${agentRows}
    `
  }).join('')

  document.getElementById('stats-by-task').innerHTML = `
    <div class="stats-section-title">By Task</div>
    <table class="stats-table">
      <tr><th>Task</th><th>Runs</th><th>Tokens In</th><th>Tokens Out</th><th>Cost</th><th>Duration</th><th>Context %</th></tr>
      ${taskRows || '<tr><td colspan="7" style="color:var(--text2);text-align:center;padding:20px">No agent runs yet</td></tr>'}
    </table>
  `
}

function toggleTaskAgents(idx) {
  document.querySelectorAll(`.agent-row[data-task-idx="${idx}"]`).forEach(row => {
    row.classList.toggle('hidden')
  })
}

function showStats() {
  document.getElementById('kanban').style.display = 'none'
  document.getElementById('stats-view').style.display = 'flex'
  document.getElementById('stats-view').style.flexDirection = 'column'
  document.getElementById('btn-stats').classList.add('active')
  loadStats()
}

function showKanban() {
  document.getElementById('kanban').style.display = 'flex'
  document.getElementById('stats-view').style.display = 'none'
  document.getElementById('btn-stats').classList.remove('active')
}
```

Also update the project-select `onchange` to call `showKanban()` when the user switches projects. Find the line in `loadProjects()` that sets `projectSelect.onchange` and ensure it calls `showKanban()`:

```js
projectSelect.onchange = () => {
  activeProjectId = projectSelect.value
  showKanban()
  loadTasks().then(renderKanban)
}
```

- [ ] **Step 4: Open browser and verify**

With `npm run dev` running, open `http://localhost:4000`. Click "📊 Stats":

- Topbar "Stats" button gets highlighted
- Kanban disappears, stats view appears
- Totals bar shows (may all be `—` if no agent runs with JSON output have happened yet)
- "By Agent Type" and "By Task" sections appear
- Click a task row → agent breakdown rows expand/collapse

Click the project selector → kanban reappears, stats hides.

- [ ] **Step 5: Commit**

```bash
git add ui/index.html ui/app.js ui/style.css
git commit -m "feat: add Stats page with token/cost/context breakdown per agent and task"
```
