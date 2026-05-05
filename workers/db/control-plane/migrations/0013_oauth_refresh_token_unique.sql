-- agentic-inbox-hardening Phase 1, fix S-1 (audit graph: ABfhYiMFim3q0u77iasH2).
--
-- Add UNIQUE on oauth_refresh_token.token. Mirrors the .unique() discipline
-- on session.token and oauth_access_token.token. Closes the silent-duplicate
-- → token-replay surface called out in .research/audit-report-agentic-inbox.md.
--
-- Pre-flight (operator MUST run on prod before applying this migration —
-- the CREATE UNIQUE INDEX below will FAIL if any duplicate token rows exist):
--
--   SELECT token, COUNT(*) AS n FROM oauth_refresh_token
--    GROUP BY token HAVING n > 1;
--
-- A non-empty result = a real security incident, not a migration bug.
-- Investigate via audit_log + access-token issuance trail before deduping.
--
-- The migration drops the existing non-unique INDEX and creates a UNIQUE
-- INDEX on the same column. SQLite cannot ALTER a column to add UNIQUE in
-- place; UNIQUE INDEX is the canonical D1-compatible substitute.

DROP INDEX IF EXISTS oauth_refresh_token_token_idx;
CREATE UNIQUE INDEX oauth_refresh_token_token_unique
  ON oauth_refresh_token(token);
