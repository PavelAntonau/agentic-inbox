-- Phase C2 (agentic-inbox-security) — schema migration bundle.
--
-- ───────────────────────────────────────────────────────────────────────────
-- Bundled changes
-- ───────────────────────────────────────────────────────────────────────────
--
--  D-03 (audit Phase B P1):
--    Explicit ON DELETE actions on FKs that lack them or have implicit
--    NO ACTION.  SQLite cannot ALTER an FK in place, so this is the
--    canonical full-table-rebuild recipe.  Tables touched:
--      * agent_tokens.issued_to_user → ON DELETE CASCADE
--          A user removed from the workspace must lose their service
--          tokens; otherwise the row keeps authenticating.
--      * groups.created_by              → ON DELETE SET NULL
--      * mailbox_groups.added_by        → ON DELETE SET NULL
--      * group_invitations.invited_by   → ON DELETE SET NULL
--      * group_invitations.decided_by   → ON DELETE SET NULL
--      * group_invitations.invitee_user_id → ON DELETE SET NULL
--          These columns are audit/provenance only — no behaviour
--          attaches to a non-NULL value.  Setting to NULL keeps the
--          row visible (so admins can see who joined a group) without
--          blocking user deletion.
--      * groups.owner_user_id stays ON DELETE RESTRICT (intentional —
--          deleting a user that owns groups is a data-integrity issue
--          the admin user-delete handler MUST surface).
--      * mailboxes.owner_user_id stays ON DELETE RESTRICT (same
--          rationale).
--
--  Audit P1-1 (JWT revocation Path 2):
--    New `oauth_grant_tombstone` table.  When a (user, client) grant
--    is revoked end-to-end (consent + access tokens + refresh tokens),
--    a tombstone row is written with `revoked_at` (epoch ms).
--    workers/middleware/oauth-bearer.ts reads the tombstone on every
--    /mcp request and rejects bearers with `iat * 1000 <= revoked_at`,
--    so an in-flight access JWT minted before the revoke is honoured
--    BUT one minted after a previous revoke (different rotation chain)
--    is rejected.  Combined with TASK-C2.2 (transactional revoke), the
--    revoke + tombstone INSERT is one D1 batch — no partial-revoke
--    window.
--
--  Audit P1-3 (admin user-delete batch):
--    The CASCADE / SET NULL FK changes above implicitly fix the audit
--    P1-3 finding.  The handler at workers/routes/admin/users.ts:520
--    can now `delete from users where id = ?` and the dependent rows
--    (agent_tokens, group_invitations.*, groups.created_by,
--    mailbox_groups.added_by) cascade or set-null automatically.  No
--    code change needed in the handler — the schema does the work.
--
--  oauth_consent UNIQUE (TASK-C2.2):
--    Add a partial UNIQUE index on (user_id, client_id) where
--    user_id IS NOT NULL.  Better-auth's oauth-provider plugin treats
--    consent as upsertable per (user, client) but doesn't enforce
--    uniqueness at the schema level.  Without UNIQUE, a race in the
--    consent flow can persist two rows; the revoke handler only
--    deletes by (user_id, client_id) so a second row would survive
--    the revoke and continue to authorize new token mints.  Mirrors
--    the S-1 (oauth_refresh_token.token UNIQUE) and S-6 (account
--    provider_id, account_id UNIQUE) discipline from migration 0014.
--
-- ───────────────────────────────────────────────────────────────────────────
-- Pre-flight (operator MUST verify on prod before running)
-- ───────────────────────────────────────────────────────────────────────────
--
--   1. Verify no duplicate (user_id, client_id) rows in oauth_consent
--      where user_id IS NOT NULL — the new UNIQUE will fail otherwise:
--
--        SELECT user_id, client_id, COUNT(*) AS n
--          FROM oauth_consent
--         WHERE user_id IS NOT NULL
--         GROUP BY user_id, client_id
--        HAVING n > 1;
--
--      A non-empty result is a real data incident — investigate before
--      deduping.
--
--   2. The table-rebuild deletes-and-recreates affected tables.  The
--      operator MUST take a D1 backup (`wrangler d1 export DB --output …`)
--      before running this migration on prod.  The rebuild copies all
--      rows, but a botched migration is much easier to roll back from
--      a fresh export than from binlogs.
--
-- ───────────────────────────────────────────────────────────────────────────

-- Defer FK enforcement during rebuild — the standard SQLite recipe.
PRAGMA defer_foreign_keys = ON;

-- ===========================================================================
-- 1. agent_tokens — add ON DELETE CASCADE on issued_to_user
-- ===========================================================================

CREATE TABLE agent_tokens_new (
  id                   TEXT    PRIMARY KEY,
  cf_service_token_id  TEXT    UNIQUE,
  cf_client_id         TEXT    UNIQUE,
  secret_hash          TEXT,
  mailbox_id           TEXT    NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  issued_to_user       TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label                TEXT,
  max_instances        INTEGER NOT NULL DEFAULT 1,
  created_at           INTEGER NOT NULL,
  last_seen_at         INTEGER,
  revoked_at           INTEGER,
  client_id            TEXT    REFERENCES clients(id)
);
INSERT INTO agent_tokens_new (
  id, cf_service_token_id, cf_client_id, secret_hash, mailbox_id,
  issued_to_user, label, max_instances, created_at, last_seen_at,
  revoked_at, client_id
)
SELECT
  id, cf_service_token_id, cf_client_id, secret_hash, mailbox_id,
  issued_to_user, label, max_instances, created_at, last_seen_at,
  revoked_at, client_id
FROM agent_tokens;
DROP TABLE agent_tokens;
ALTER TABLE agent_tokens_new RENAME TO agent_tokens;

-- ===========================================================================
-- 2. groups — change created_by FK action to SET NULL
-- ===========================================================================

CREATE TABLE groups_new (
  id             TEXT    PRIMARY KEY,
  name           TEXT    NOT NULL,
  description    TEXT,
  owner_user_id  TEXT    NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at     INTEGER NOT NULL,
  created_by     TEXT    REFERENCES users(id) ON DELETE SET NULL
);
INSERT INTO groups_new (id, name, description, owner_user_id, created_at, created_by)
SELECT id, name, description, owner_user_id, created_at, created_by FROM groups;
DROP TABLE groups;
ALTER TABLE groups_new RENAME TO groups;

-- ===========================================================================
-- 3. mailbox_groups — change added_by FK action to SET NULL
-- ===========================================================================

CREATE TABLE mailbox_groups_new (
  mailbox_id  TEXT    NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  group_id    TEXT    NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  added_at    INTEGER NOT NULL,
  added_by    TEXT    REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (mailbox_id, group_id)
);
INSERT INTO mailbox_groups_new (mailbox_id, group_id, added_at, added_by)
SELECT mailbox_id, group_id, added_at, added_by FROM mailbox_groups;
DROP TABLE mailbox_groups;
ALTER TABLE mailbox_groups_new RENAME TO mailbox_groups;

-- ===========================================================================
-- 4. group_invitations — invited_by/decided_by/invitee_user_id SET NULL
-- ===========================================================================
-- invited_by becomes nullable because the FK action is SET NULL; same for
-- decided_by and invitee_user_id (already nullable before).

CREATE TABLE group_invitations_new (
  id                TEXT    PRIMARY KEY,
  group_id          TEXT    NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  invitee_email     TEXT    NOT NULL,
  invitee_user_id   TEXT    REFERENCES users(id) ON DELETE SET NULL,
  invited_by        TEXT    REFERENCES users(id) ON DELETE SET NULL,
  status            TEXT    NOT NULL DEFAULT 'pending',
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  decided_at        INTEGER,
  decided_by        TEXT    REFERENCES users(id) ON DELETE SET NULL
);
INSERT INTO group_invitations_new (
  id, group_id, invitee_email, invitee_user_id, invited_by, status,
  created_at, expires_at, decided_at, decided_by
)
SELECT
  id, group_id, invitee_email, invitee_user_id, invited_by, status,
  created_at, expires_at, decided_at, decided_by
FROM group_invitations;
DROP TABLE group_invitations;
ALTER TABLE group_invitations_new RENAME TO group_invitations;

-- Recreate indexes that lived on group_invitations.
CREATE UNIQUE INDEX group_invitations_pending
  ON group_invitations(group_id, invitee_email)
  WHERE status = 'pending';
CREATE INDEX group_invitations_invitee_user_idx
  ON group_invitations(invitee_user_id);

-- ===========================================================================
-- 5. oauth_grant_tombstone — JWT revocation Path 2 (audit P1-1)
-- ===========================================================================

CREATE TABLE oauth_grant_tombstone (
  user_id     TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id   TEXT    NOT NULL REFERENCES oauth_client(client_id) ON DELETE CASCADE,
  revoked_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, client_id)
);
CREATE INDEX oauth_grant_tombstone_revoked_at_idx
  ON oauth_grant_tombstone(revoked_at);

-- ===========================================================================
-- 6. oauth_consent — UNIQUE on (user_id, client_id)
-- ===========================================================================
-- Partial UNIQUE: oauth_consent.user_id is nullable for client-credentials
-- grants (no user-bound consent).  The UNIQUE applies only to user-scoped
-- rows — those are the ones the revoke handler joins on.

CREATE UNIQUE INDEX oauth_consent_user_client_unique
  ON oauth_consent(user_id, client_id)
  WHERE user_id IS NOT NULL;

-- Re-enable FK enforcement.
PRAGMA defer_foreign_keys = OFF;
