-- Phase 2 — Clients + client_grants tables
--
-- clients: unified client registry (browser sessions projected separately at
--   read-time; only non-browser clients are persisted here).
--   kind: 'browser' | 'mcp' | 'ios' | 'desktop' | 'other'
--   revoked_at: NULL = active; set = revoked.
--
-- client_grants: per-client per-inbox scope grants.
--   scope: 'read' | 'write'
--   UNIQUE INDEX on (client_id, inbox_id, scope) WHERE revoked_at IS NULL
--   ensures only one active grant per (client, inbox, scope) triple.

CREATE TABLE IF NOT EXISTS clients (
  id              TEXT    PRIMARY KEY,
  user_id         TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            TEXT    NOT NULL CHECK (kind IN ('browser', 'mcp', 'ios', 'desktop', 'other')),
  name            TEXT    NOT NULL,
  oauth_client_id TEXT,
  last_seen_at    INTEGER,
  ip_address      TEXT,
  user_agent      TEXT,
  revoked_at      INTEGER,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_clients_user
  ON clients(user_id);
CREATE INDEX IF NOT EXISTS idx_clients_user_active
  ON clients(user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS client_grants (
  id          TEXT    PRIMARY KEY,
  client_id   TEXT    NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  inbox_id    TEXT    NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  scope       TEXT    NOT NULL CHECK (scope IN ('read', 'write')),
  granted_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_client_grants_active
  ON client_grants(client_id, inbox_id, scope) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_client_grants_client
  ON client_grants(client_id);
CREATE INDEX IF NOT EXISTS idx_client_grants_inbox
  ON client_grants(inbox_id);
