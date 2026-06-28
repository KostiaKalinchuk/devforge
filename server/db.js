const initSqlJs = require('sql.js')
const fs   = require('fs')
const path = require('path')

const DB_PATH = path.resolve(process.env.DB_PATH || './devforge.db')

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    local_path TEXT NOT NULL,
    git_url TEXT,
    description TEXT,
    internal_port INTEGER DEFAULT 80,
    health_check TEXT DEFAULT '/health',
    test_command TEXT DEFAULT 'php artisan test',
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id),
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'inbox',
    current_agent TEXT,
    retry_count INTEGER DEFAULT 0,
    branch TEXT,
    env_port INTEGER,
    env_container_prefix TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    updated_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS agent_logs (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    agent TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS pm_questions (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    question TEXT NOT NULL,
    answer TEXT,
    order_num INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS allocated_ports (
    port INTEGER PRIMARY KEY,
    task_id TEXT,
    allocated_at INTEGER DEFAULT (strftime('%s','now'))
  );
`

let _db = null

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

function _save() {
  if (_db) fs.writeFileSync(DB_PATH, Buffer.from(_db.export()))
}

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

const db = {
  prepare(sql) {
    return {
      run(...p)  { _db.run(sql, p); _save() },
      get(...p)  {
        const s = _db.prepare(sql); s.bind(p)
        const row = s.step() ? s.getAsObject() : undefined
        s.free(); return row
      },
      all(...p)  {
        const rows = [], s = _db.prepare(sql); s.bind(p)
        while (s.step()) rows.push(s.getAsObject())
        s.free(); return rows
      }
    }
  },
  exec(sql) { _db.run(sql); _save() },
  pragma()   {}
}

module.exports = { init, db }
