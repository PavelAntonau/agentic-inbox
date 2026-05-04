-- Phase 2 — Backfill agent_tokens → clients + client_grants
--
-- DEVIATION FROM BRIEF (documented):
--   • agent_tokens uses `issued_to_user` (not `user_id`) as the FK to users.
--   • agent_tokens uses `label` (not `name`) for the human-readable description.
--   • agent_tokens uses `last_seen_at` (not `last_used_at`) for the last-activity timestamp.
--   • agent_tokens.mailbox_id is NOT NULL (every token is scoped to one mailbox),
--     so the "WHERE at.mailbox_id IS NOT NULL" guard is a no-op but kept for safety.
--
-- Strategy (D-PLAT-6): 1 token → 1 client + 1 grant. agent_tokens stays read-only;
-- Phase 3 drops it after a one-day soak. The deterministic id prefix ('cl_' / 'cg_')
-- with the first 24 chars of the token id makes the INSERT idempotent.

-- 1. Add client_id FK column to agent_tokens (NULL until backfill; never re-used
--    after Phase 3 decommission).
ALTER TABLE agent_tokens ADD COLUMN client_id TEXT REFERENCES clients(id);

-- 2. Backfill one client row per agent token (idempotent via NOT EXISTS guard).
INSERT INTO clients (id, user_id, kind, name, oauth_client_id, last_seen_at, ip_address, user_agent, revoked_at, created_at)
SELECT
  'cl_' || substr(at.id, 1, 24),
  at.issued_to_user,
  'mcp',
  COALESCE(at.label, 'Legacy Agent Token'),
  NULL,
  at.last_seen_at,
  NULL,
  NULL,
  at.revoked_at,
  at.created_at
FROM agent_tokens at
WHERE NOT EXISTS (
  SELECT 1 FROM clients c WHERE c.id = 'cl_' || substr(at.id, 1, 24)
);

-- 3. Backfill one client_grant row per agent token (idempotent via NOT EXISTS guard).
--    Every agent token is scoped to exactly one mailbox (mailbox_id NOT NULL), so
--    the mailbox_id IS NOT NULL guard is kept as a defensive belt-and-suspenders check.
INSERT INTO client_grants (id, client_id, inbox_id, scope, granted_at, revoked_at)
SELECT
  'cg_' || substr(at.id, 1, 24),
  'cl_' || substr(at.id, 1, 24),
  at.mailbox_id,
  'write',
  at.created_at,
  at.revoked_at
FROM agent_tokens at
WHERE at.mailbox_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM client_grants cg WHERE cg.id = 'cg_' || substr(at.id, 1, 24)
  );

-- 4. Link agent_tokens back to their new clients rows (idempotent).
UPDATE agent_tokens
SET client_id = 'cl_' || substr(id, 1, 24)
WHERE client_id IS NULL;
