-- Phase F (one-inbox-one-client) — migration 0017.
--
-- ───────────────────────────────────────────────────────────────────────────
-- Goal
-- ───────────────────────────────────────────────────────────────────────────
--
-- Enforce: per (user, mailbox), at most ONE active MCP credential, and
-- exclusively one of {PAT, OAuth-client}. The user-facing model is "one
-- inbox, one client". This sentinel table makes the rule a database
-- invariant rather than an application-layer convention.
--
-- The binding is independent of `oauth_consent` — that table is owned by
-- `@better-auth/oauth-provider` and treats consent as upsertable per
-- (user, client). Trusted MCP clients (Claude Code, Cursor, etc.) bypass
-- the consent screen entirely (`skip_consent=1`), so we cannot intercept
-- "user binds OAuth client X to mailbox Y" at the consent layer. Instead,
-- the binding is created **at first /mcp call** by `dispatchMcpRequest`
-- once the JWT carries a resolved `mailboxId`. Race-protected by the
-- (user_id, mailbox_id) PRIMARY KEY.
--
-- ───────────────────────────────────────────────────────────────────────────
-- Lifecycle
-- ───────────────────────────────────────────────────────────────────────────
--
--   PAT mint for mailbox X
--     d1.batch([
--       INSERT INTO oauth_personal_access_token (...) VALUES (...),
--       INSERT INTO mcp_inbox_binding (user_id, mailbox_id, kind, pat_id, ...)
--         VALUES (?, ?, 'pat', ?, ?)
--     ])
--   Pre-existing binding(user, X) → SQLITE_CONSTRAINT (PRIMARY KEY violation)
--   → routes/pats.ts translates to 409 `inbox-credential-exists`.
--
--   PAT delete (hard, the user spec)
--     DELETE FROM oauth_personal_access_token WHERE id=? AND user_id=?
--   ON DELETE CASCADE drops the binding row. Audit_log row stays — that's
--   the "server log" retained per spec.
--
--   OAuth /mcp first call for mailbox X
--     dispatcher resolves mailbox → looks up binding(user, X)
--       missing  → INSERT binding('oauth', oauth_client_id=jwt.client_id)
--                  → proceed
--       'pat'    → 403 `inbox-bound-to-pat`
--       'oauth' AND oauth_client_id matches → proceed
--       'oauth' AND oauth_client_id differs → 403 `inbox-bound-to-other-client`
--
--   User revoke (DELETE /api/users/me/mailboxes/:id/mcp-credential)
--     - kind='pat' → DELETE pat row → CASCADE drops binding.
--     - kind='oauth' → DELETE oauth_consent row(s) for (user, oauth_client_id)
--                      + write tombstone (JWT-iat defense, migration 0015)
--                      + DELETE binding (oauth_client refs not cascaded by
--                        oauth_consent delete because consent != client).
--
-- ───────────────────────────────────────────────────────────────────────────
-- Pre-flight
-- ───────────────────────────────────────────────────────────────────────────
--
-- The table is empty on creation (no backfill). Existing PATs in
-- `oauth_personal_access_token` will not have binding rows; the existing
-- bearer middleware ignores the binding entirely (binding is consulted
-- only by `dispatchMcpRequest` for the new mutual-exclusion check). Once
-- a user re-mints a PAT for a mailbox, the new code path creates the
-- binding row. A future migration may backfill existing PATs into bindings
-- if the operator wants strict enforcement on the legacy set.
--
-- D1 backup: `wrangler d1 export DB --output …` before applying.
--
-- ===========================================================================
-- 1. Create the sentinel table
-- ===========================================================================

CREATE TABLE mcp_inbox_binding (
  user_id          TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mailbox_id       TEXT    NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  kind             TEXT    NOT NULL CHECK (kind IN ('pat', 'oauth')),
  pat_id           TEXT    REFERENCES oauth_personal_access_token(id) ON DELETE CASCADE,
  oauth_client_id  TEXT    REFERENCES oauth_client(client_id) ON DELETE CASCADE,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (user_id, mailbox_id),
  CHECK (
    (kind = 'pat'   AND pat_id IS NOT NULL AND oauth_client_id IS NULL)
    OR
    (kind = 'oauth' AND oauth_client_id IS NOT NULL AND pat_id IS NULL)
  )
);

-- Secondary indexes for the cascade-cleanup paths and for the
-- per-mailbox-credential lookups in the new MCPPanel API.
CREATE INDEX mcp_inbox_binding_pat_id_idx
  ON mcp_inbox_binding(pat_id);
CREATE INDEX mcp_inbox_binding_oauth_client_id_idx
  ON mcp_inbox_binding(oauth_client_id);
