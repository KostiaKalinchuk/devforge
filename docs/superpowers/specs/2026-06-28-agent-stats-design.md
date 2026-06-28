# Agent Statistics Dashboard — Design Spec

## Goal

Capture per-agent token usage, cost, and context-window % for every agent run, and expose them in a dedicated Stats page in the DevForge UI.

## Architecture

**Data flow:** runner switches to `--output-format json` → parses token counts + cost from CLI response → stores in `agent_logs` → `GET /api/stats` aggregates → Stats view renders.

No new tables. Four new columns in `agent_logs`. One new API endpoint.

## Global Constraints

- Claude CLI: `--output-format json` returns `result` (text), `cost_usd` (float), `duration_ms` (int), and token counts (exact field names confirmed at implementation time by printing a sample response).
- Context-window limits: Sonnet 4.6 → 200 000 tokens; Opus 4.8 → 200 000 tokens. Any unknown model defaults to 200 000.
- Context % = `tokens_in / model_context_limit × 100`, rounded to one decimal.
- Cost display: always 4 decimal places (`$0.0012`), totals 2 decimal places (`$1.23`).
- Stats page is read-only — no user actions.

---

## Task 1: Runner — switch to JSON output and persist stats

### Files

- Modify: `server/runner/adapters/claude-code.js`
- Modify: `server/orchestrator/index.js` (pass token data to `log()`)
- Modify: `server/db.js` (schema migration — add 4 columns to `agent_logs`)

### Changes

**`server/db.js`** — add migration guard on startup (run only if columns absent):

```sql
ALTER TABLE agent_logs ADD COLUMN tokens_in  INTEGER;
ALTER TABLE agent_logs ADD COLUMN tokens_out INTEGER;
ALTER TABLE agent_logs ADD COLUMN cost_usd   REAL;
ALTER TABLE agent_logs ADD COLUMN duration_ms INTEGER;
```

**`server/runner/adapters/claude-code.js`** — switch args:

```js
'--output-format', 'json'   // was 'text'
```

Parse response:

```js
proc.on('close', code => {
  let parsed = {}
  try { parsed = JSON.parse(stdout) } catch (_) {}

  const text     = parsed.result || stdout
  const costUsd  = parsed.cost_usd ?? null
  const durationMs = parsed.duration_ms ?? null
  // token field names differ by CLI version — try both
  const tokensIn  = parsed.input_tokens  ?? parsed.tokens_in  ?? null
  const tokensOut = parsed.output_tokens ?? parsed.tokens_out ?? null

  const statusMatch = text.match(/^STATUS:\s*(done|questions|failed)/m)
  const status  = statusMatch ? statusMatch[1] : 'done'
  const message = text.replace(/^STATUS:.*$/m, '').trim()

  resolve({ status, message, raw: stdout, tokensIn, tokensOut, costUsd, durationMs })
})
```

**`server/orchestrator/index.js`** — pass stats to `log()`:

```js
log(task.id, agentName, result.status, result.message?.slice(0, 500), {
  tokensIn:   result.tokensIn,
  tokensOut:  result.tokensOut,
  costUsd:    result.costUsd,
  durationMs: result.durationMs
})
```

Update `log()` signature and INSERT:

```js
function log(taskId, agent, status, message, stats = {}) {
  db.prepare(`INSERT INTO agent_logs
    (id, task_id, agent, status, message, tokens_in, tokens_out, cost_usd, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(uuid(), taskId, agent, status, message || '',
      stats.tokensIn ?? null, stats.tokensOut ?? null,
      stats.costUsd ?? null, stats.durationMs ?? null)
  // ... existing rotation logic unchanged
}
```

---

## Task 2: API — `GET /api/stats`

### Files

- Modify: `server/routes/tasks.js` (or create `server/routes/stats.js` and register in `server/index.js`)

### Response shape

```json
{
  "totals": {
    "cost_usd": 1.23,
    "tokens_in": 450000,
    "tokens_out": 120000,
    "runs": 18
  },
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
        { "agent": "pm", "tokens_in": 8000, "tokens_out": 2000, "cost_usd": 0.02,
          "duration_ms": 12000, "context_pct": 4.0 }
      ]
    }
  ]
}
```

### Query

```sql
-- totals
SELECT COUNT(*) as runs,
       SUM(tokens_in) as tokens_in, SUM(tokens_out) as tokens_out,
       SUM(cost_usd) as cost_usd
FROM agent_logs

-- by_agent
SELECT agent, COUNT(*) as runs,
       SUM(tokens_in), SUM(tokens_out), SUM(cost_usd)
FROM agent_logs GROUP BY agent ORDER BY SUM(cost_usd) DESC

-- by_task (join tasks for title)
SELECT t.id, t.title, SUM(l.cost_usd), SUM(l.tokens_in), SUM(l.tokens_out), COUNT(*) as runs
FROM agent_logs l JOIN tasks t ON l.task_id = t.id
GROUP BY t.id ORDER BY t.updated_at DESC
```

Context % per agent row: computed in JS, not SQL: `(tokens_in / 200000) * 100`.

---

## Task 3: Stats page in UI

### Files

- Modify: `ui/index.html` (add Stats nav button + stats-view section)
- Modify: `ui/app.js` (add `loadStats()`, nav switching)
- Modify: `ui/style.css` (stats table styles)

### Layout

```
[Projects]  [Stats]          ← nav buttons (existing + new)

┌─ ЗАГАЛЬНИЙ ПІДСУМОК ──────────────────────────┐
│  Витрачено: $1.23   Токенів: 450k in / 120k out   Запусків: 18  │
└───────────────────────────────────────────────┘

┌─ НайДОРОЖЧІ АГЕНТИ ───────────────────────────┐
│  architect  3 запуски  190k in  $0.45           │
│  developer  5 запусків 130k in  $0.31           │
│  ...                                            │
└───────────────────────────────────────────────┘

┌─ ПО ЗАДАЧАХ ──────────────────────────────────┐
│ ▶ Add hello world endpoint   $0.12  45k  6 runs │
│   └ pm         8k/2k  4.0%  $0.02  12s         │
│   └ architect  18k/4k 11.0% $0.04  34s         │
│   └ developer  22k/6k 14.0% $0.05  58s         │
│ ▶ Another task ...                              │
└───────────────────────────────────────────────┘
```

### Behavior

- Nav "Stats" button: hides projects-view, shows stats-view, calls `loadStats()`
- Task rows are collapsible (click to expand/collapse agent breakdown)
- Rows with `null` cost/tokens show `—` (for logs before this feature was added)
- Context % bar: colored green < 50%, yellow 50–80%, red > 80%

---

## Out of Scope

- Real-time token streaming during agent run
- Per-token cost breakdown (input vs output pricing)
- Export to CSV
- Date-range filtering
- Cost alerts / budgets
