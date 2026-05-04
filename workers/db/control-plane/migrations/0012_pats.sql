-- Phase 3 (mcp-oauth) — Personal Access Tokens (PATs).
--
-- v0.1 headless-agent auth surface (per D-mcp-auth-2 / vWFkejELcRde8VOSt6ZwG).
-- GitHub-style display-once flow:
--   * POST /api/users/me/pats returns the full token ONCE.
--   * GET  /api/users/me/pats lists tokens with token_prefix/token_suffix
--     only — never the full token, never the hash.
--   * DELETE /api/users/me/pats/:id sets revoked_at (soft-delete).
--
-- Hash discipline (matches the existing agent_tokens pattern in
-- workers/routes/tokens.ts): the plaintext token is HMAC-SHA-256'd with
-- TOKEN_PEPPER on insert; the column stores the hex digest. T3.3 wires the
-- bearer middleware to look up `WHERE token_hash = ? AND revoked_at IS NULL
-- AND (expires_at IS NULL OR expires_at > now)` and updates last_used_at on
-- every successful match.
--
-- Token format: `pat_<base64url(32 random bytes)>`.
--   * token_prefix = first 4 chars AFTER the "pat_" prefix (display tag).
--   * token_suffix = last 4 chars of the full token (display tag).
-- Per-PAT optional scoping:
--   * mailbox_id: when set, the token is restricted to one mailbox; FK
--     CASCADE so deleting the mailbox revokes its tokens.
--   * ip_allowlist: JSON array of CIDR strings (T3.3 will validate against
--     CF-Connecting-IP). NULL = no IP restriction.

CREATE TABLE oauth_personal_access_token (
  id            TEXT    PRIMARY KEY,
  user_id       TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label         TEXT    NOT NULL,
  token_hash    TEXT    NOT NULL UNIQUE,
  token_prefix  TEXT    NOT NULL,
  token_suffix  TEXT    NOT NULL,
  scopes        TEXT    NOT NULL,
  mailbox_id    TEXT    REFERENCES mailboxes(id) ON DELETE CASCADE,
  ip_allowlist  TEXT,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  expires_at    INTEGER,
  revoked_at    INTEGER
);
CREATE INDEX oauth_personal_access_token_user_id_idx
  ON oauth_personal_access_token(user_id);
CREATE INDEX oauth_personal_access_token_token_hash_idx
  ON oauth_personal_access_token(token_hash);
