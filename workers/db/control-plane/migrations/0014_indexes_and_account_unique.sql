-- agentic-inbox-hardening Phase 2 — schema migration bundle.
-- Audit findings: S-2, S-3, S-6 (S-4 is schema-only annotation; SQLite
-- cannot ALTER FK constraints in place — see workers/db/control-plane/schema.ts
-- and DECISIONS.md "D-aih-S4-onDelete").
--
-- Re-assessment outcome (vs original audit):
--   * DB-1 splits out to the per-mailbox DO schema (workers/durableObject/migrations.ts
--     migration 10) — the control-plane DB is unaffected.
--   * S-4 is schema-annotation only. The drizzle declaration documents intent;
--     existing prod databases keep their current implicit "no-action" behaviour
--     (which matches "restrict" semantics for our DELETE flows).
--   * S-2, S-3, S-6 are the actual SQL changes applied here.
--
-- ──────────────────────────────────────────────────────────────────────────
-- S-2 — contacts: add index on contact_user_id.
--
-- The PK on (owner_user_id, contact_user_id) covers prefix scans by
-- owner_user_id but cannot serve queries that filter by contact_user_id
-- alone. Those queries appear in the visibility-filter and bidirectional-
-- handshake checks ("does B have A as a contact?"). On a populated
-- contacts table this becomes a full scan.
CREATE INDEX IF NOT EXISTS contacts_contact_user_id_idx
  ON contacts(contact_user_id);

-- ──────────────────────────────────────────────────────────────────────────
-- S-3 — group_invitations: add index on invitee_user_id.
--
-- Hot path: GET /api/notifications/unseen (polled on every page load)
-- counts pending invitations where invitee_user_id = ?. Without an index
-- this is a full scan on every poll.
CREATE INDEX IF NOT EXISTS group_invitations_invitee_user_idx
  ON group_invitations(invitee_user_id);

-- ──────────────────────────────────────────────────────────────────────────
-- S-6 — account: promote (provider_id, account_id) index to UNIQUE.
--
-- Better-auth manages this table; the (provider_id, account_id) tuple is the
-- caller's natural identity. A duplicate row indicates a bug the ORM cannot
-- catch (mirrors the S-1 / L-AIA-2 lesson on oauth_refresh_token.token).
--
-- Pre-flight (operator MUST run on prod before applying — the CREATE UNIQUE
-- INDEX below will FAIL if any duplicate (provider_id, account_id) rows exist):
--
--   SELECT provider_id, account_id, COUNT(*) AS n
--     FROM account
--    GROUP BY provider_id, account_id
--    HAVING n > 1;
--
-- A non-empty result is a real data incident, not a migration bug — investigate
-- via audit_log + better-auth signin trail before deduping.
DROP INDEX IF EXISTS account_provider_idx;
CREATE UNIQUE INDEX account_provider_idx
  ON account(provider_id, account_id);
