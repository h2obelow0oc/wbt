-- WorkBuddy 管理面板 D1 schema
CREATE TABLE IF NOT EXISTS accounts (
  id           TEXT PRIMARY KEY,
  uid          TEXT NOT NULL,
  realm        TEXT NOT NULL,
  domain       TEXT NOT NULL,
  nickname     TEXT DEFAULT '',
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  enabled      INTEGER DEFAULT 1,
  models       TEXT DEFAULT '[]',
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_accounts_uid ON accounts(uid);

CREATE TABLE IF NOT EXISTS apikeys (
  id          TEXT PRIMARY KEY,
  apikey      TEXT NOT NULL UNIQUE,
  name        TEXT DEFAULT '',
  account_ids TEXT DEFAULT '[]',
  enabled     INTEGER DEFAULT 1,
  created_at  INTEGER NOT NULL,
  note        TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_apikeys_key ON apikeys(apikey);

CREATE TABLE IF NOT EXISTS task_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  account_id TEXT,
  at         INTEGER NOT NULL,
  ok         INTEGER NOT NULL,
  msg        TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_tasklog_at ON task_log(at);

CREATE TABLE IF NOT EXISTS credits_snap (
  account_id TEXT PRIMARY KEY,
  at         INTEGER NOT NULL,
  credits    REAL NOT NULL,
  expiries   TEXT DEFAULT '[]'
);
