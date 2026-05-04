-- Phase 6.1 — better-auth foundation
--
-- Adds: email_verified + updated_at columns on users (better-auth requires both).
--       session, account, verification tables (better-auth defaults; field names
--       match the library's expected DB column shape).
--
-- Notes:
--   * better-auth maps `name` → users.display_name and `image` → users.avatar_url
--     via field overrides in createAuth() — no schema change needed there.
--   * `users.created_at` already exists. updated_at backfilled from created_at.
--   * The `account` table is used by better-auth even for email-only flows to
--     track the verification provider; minimal columns suffice.

ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
UPDATE users SET updated_at = created_at WHERE updated_at = 0;

CREATE TABLE session (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  ip_address TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX session_user_id_idx ON session(user_id);
CREATE INDEX session_token_idx ON session(token);
CREATE INDEX session_expires_at_idx ON session(expires_at);

CREATE TABLE account (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at INTEGER,
  refresh_token_expires_at INTEGER,
  scope TEXT,
  password TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX account_user_id_idx ON account(user_id);
CREATE INDEX account_provider_idx ON account(provider_id, account_id);

CREATE TABLE verification (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX verification_identifier_idx ON verification(identifier);
CREATE INDEX verification_expires_at_idx ON verification(expires_at);
