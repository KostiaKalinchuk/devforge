# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start      # production server
npm run dev    # development server with auto-restart (nodemon)
```

Server runs at `http://localhost:4000` (or `$PORT`). No test or lint scripts are configured.

To run in Docker:
```bash
docker compose up --build
```

## Architecture

DevForge is a local AI development team orchestrator. It polls a SQLite task queue and routes tasks through a pipeline of AI agents, each invoked by spawning the `claude` CLI.

### Request flow

1. User creates a task via the UI → REST API (`server/routes/tasks.js`) → `orchestrator.createTask()`
2. Orchestrator polling loop (`server/orchestrator/index.js`, every 5s) picks up active tasks (max 3 concurrent)
3. Each tick determines the correct agent from the task's current status, builds a prompt from the agent's markdown file + workspace context, and spawns `claude` via `server/runner/adapters/claude-code.js`
4. Agent writes files to `workspace/{taskId}/` and prints `STATUS: done|questions|failed` as its last line
5. State machine (`server/orchestrator/state-machine.js`) advances the task to the next status
6. Progress is broadcast to the UI over WebSocket

### Task state machine

```
inbox → pm_active → [pm_questioning ↔ pm_active] → architect_active
      → dev_active → qa_active → tests_active → review_active
      → awaiting_acceptance → done
                                              ↘ failed
```

- `pm_questioning`: PM has questions for the human; task pauses until answers are submitted
- `qa_active`: spins up an isolated Docker environment (project copy + dynamic port) for browser testing
- `review_active`: reviewer can send task back to `dev_active` (up to `MAX_REVIEW_RETRIES`)
- `awaiting_acceptance`: human reviews and accepts/rejects

### Key files

| Path | Purpose |
|------|---------|
| `server/index.js` | Express + WebSocket server entry point |
| `server/db.js` | SQLite via sql.js, file-persisted to `devforge.db` |
| `server/orchestrator/index.js` | Main polling loop, agent dispatch, human action handlers |
| `server/orchestrator/state-machine.js` | State transition logic and retry limits |
| `server/orchestrator/context.js` | Workspace file helpers (`workspace/{taskId}/`) |
| `server/agents/*.md` | System prompts for each agent role |
| `server/runner/adapters/claude-code.js` | Spawns `claude` CLI, parses STATUS from stdout |
| `server/environment/manager.js` | Docker environment lifecycle for QA (rsync + compose) |
| `server/routes/` | REST API: `/api/projects`, `/api/tasks` |
| `ui/` | Static frontend served by Express |

### Agent protocol

Each agent prompt file (`server/agents/<name>.md`) defines the agent's role and workflow. The runner appends current workspace file contents to the prompt. Agents must end their output with:

```
STATUS: done
```

or `STATUS: questions` (PM only, writes `PM_QUESTIONS.md`) or `STATUS: failed`.

### Database schema

Tables: `projects`, `tasks`, `agent_logs`, `pm_questions`, `allocated_ports`. The DB is loaded into memory on startup and flushed to `devforge.db` after every write (sql.js pattern in `server/db.js`).

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `4000` | HTTP server port |
| `WORKSPACE_DIR` | `./workspace` | Root for task workspaces |
| `DB_PATH` | `./devforge.db` | SQLite file location |
| `CLAUDE_BIN` | `claude` | Path to Claude Code CLI |
| `CLAUDE_FLAGS` | `--dangerously-skip-permissions` | Flags passed to every `claude` invocation |
| `AGENT_MODEL_PM` | `claude-sonnet-4-6` | Model override per agent role |
| `AGENT_MODEL_ARCHITECT` | `claude-opus-4-8` | (also DEVELOPER, QA, TESTS, REVIEWER) |
| `DOCKER_PORT_RANGE_START/END` | `3100`/`3999` | Port pool for QA containers |
| `CONTAINER_HEALTH_TIMEOUT` | `120` | Seconds to wait for QA container health |
