-- Phase 1 — better-auth rate-limit table
--
-- better-auth uses this table when rateLimit.storage = "database".
-- Columns match the library's expected shape exactly (rateLimitTableFields):
--   id          TEXT   PRIMARY KEY
--   key         TEXT   UNIQUE (rate-limit key, e.g. IP:path)
--   count       INTEGER (requests in the current window)
--   lastRequest INTEGER (epoch ms of last request)
--
-- See: https://www.better-auth.com/docs/concepts/rate-limit
--      rateLimitTableFields definition in the better-auth source

CREATE TABLE IF NOT EXISTS rate_limit (
  id          TEXT    PRIMARY KEY,
  key         TEXT    NOT NULL UNIQUE,
  count       INTEGER NOT NULL DEFAULT 0,
  last_request INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS rate_limit_key_idx ON rate_limit(key);
