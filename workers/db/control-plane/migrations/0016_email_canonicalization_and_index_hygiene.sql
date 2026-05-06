-- Phase C3 (agentic-inbox-security) — migration 0016.
--
-- ───────────────────────────────────────────────────────────────────────────
-- Bundled changes
-- ───────────────────────────────────────────────────────────────────────────
--
--  C3.3 (email canonicalization backfill):
--    Lower-case every existing `users.email` row that isn't already in
--    canonical form. The new `lib/email.ts:normalizeEmail` helper feeds
--    every read/write boundary going forward, but pre-existing rows from
--    Phase 6.1 onward may have been inserted with mixed case (CF Access
--    JWTs occasionally surface them; better-auth's signup gate did
--    normalize but a small handful of legacy rows came in via the
--    bootstrap-owner path before A-1 hardening). Without this backfill,
--    the `lower(email)` UNIQUE index would still match on read, but
--    `eq(schema.users.email, normalizedEmail)` (used in the authzContext
--    middleware after C3.3) would MISS those rows.
--
--    The UPDATE is idempotent (`WHERE email != LOWER(email)`) so re-runs
--    on a clean DB are no-ops. Better-auth's `account` table also stores
--    the email; we lowercase it too for consistency and so account-by-
--    email joins don't drift.
--
--  C3.24 (D-06): drop the redundant
--    `oauth_personal_access_token_token_hash_idx`. The `token_hash`
--    column already has `UNIQUE` (declared in migration 0012),
--    which SQLite materializes as `sqlite_autoindex_…`. The
--    explicit non-UNIQUE secondary index added nothing — every
--    HMAC-prefix lookup goes through the unique index. Dropping it
--    saves disk + write-amp on every PAT issue.
--
--  C3.24 (D-07): resolve `users.email` UNIQUE redundancy. The Drizzle
--    schema declared `email` as both `.unique()` (case-sensitive
--    auto-index) AND `users_email_nocase` (UNIQUE on `lower(email)`).
--    The former let mixed-case duplicates evade the case-INSENSITIVE
--    constraint depending on insert order. Migration 0016 drops the
--    case-sensitive index; only the `lower(email)` unique survives,
--    matching the agreed canonical form (lower + trim) the new
--    `normalizeEmail` helper produces.
--
--    NOTE: SQLite's auto-index on a `UNIQUE` column is named
--    `sqlite_autoindex_users_<n>` and CANNOT be dropped via
--    `DROP INDEX`. Removing it requires a table rebuild — same
--    full-recipe shape as migration 0015. The rebuild also lets us
--    declare `email TEXT NOT NULL` (no inline UNIQUE) so the
--    schema introspection matches Drizzle.
--
-- ───────────────────────────────────────────────────────────────────────────
-- Pre-flight (operator MUST verify on prod before running)
-- ───────────────────────────────────────────────────────────────────────────
--
--   1. After the LOWER backfill, any existing pair of rows that differ
--      ONLY in email casing would collide on the `lower(email)`
--      UNIQUE index. The backfill runs BEFORE the table rebuild so
--      we surface that as a hard failure, not data loss. Operator
--      should pre-check:
--
--        SELECT lower(email) AS canonical_email, COUNT(*) AS n
--          FROM users
--         GROUP BY canonical_email
--        HAVING n > 1;
--
--      If non-empty, manually merge the duplicate accounts before
--      running this migration (rare — Phase 6.1 invite gate prevents
--      new collisions; only legacy CF-Access-only sign-ins are at risk).
--
--   2. D1 backup before running (`wrangler d1 export DB --output …`).
--
-- ───────────────────────────────────────────────────────────────────────────

-- ===========================================================================
-- 1. C3.3 backfill — canonicalize existing email values
-- ===========================================================================

UPDATE users
   SET email = lower(trim(email))
 WHERE email != lower(trim(email));

-- Better-auth's `account` table mirrors the email for the email-OTP
-- provider. Keep it in sync with `users.email`.
UPDATE account
   SET account_id = lower(trim(account_id))
 WHERE provider_id = 'emailOTP'
   AND account_id != lower(trim(account_id));

-- group_invitations.invitee_email reads via lower() everywhere
-- (workers/auth/index.ts evaluateSignupGate; workers/routes/invitations.ts);
-- canonicalizing here aligns storage with read shape so we can drop the
-- per-query lower() in a follow-up without behaviour change.
UPDATE group_invitations
   SET invitee_email = lower(trim(invitee_email))
 WHERE invitee_email != lower(trim(invitee_email));

-- ===========================================================================
-- 2. C3.24 (D-06) — drop redundant token_hash index
-- ===========================================================================
-- Idempotent — `IF EXISTS` guards a re-run (the index is created in 0012).

DROP INDEX IF EXISTS oauth_personal_access_token_token_hash_idx;

-- ===========================================================================
-- 3. C3.24 (D-07) — rebuild users to drop the case-sensitive UNIQUE on email
-- ===========================================================================
-- The historic `email TEXT NOT NULL UNIQUE` produced an auto-index that
-- collides with `users_email_nocase`. Rebuild the table without the
-- inline UNIQUE; `users_email_nocase` (recreated below) becomes the sole
-- uniqueness constraint.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE users_new (
  id              TEXT    PRIMARY KEY,
  email           TEXT    NOT NULL,
  display_name    TEXT,
  role            TEXT    NOT NULL DEFAULT 'user',
  status          TEXT    NOT NULL DEFAULT 'active',
  visibility      TEXT    NOT NULL DEFAULT 'everyone',
  avatar_url      TEXT,
  account_type    TEXT    NOT NULL DEFAULT 'personal',
  company         TEXT,
  created_at      INTEGER NOT NULL,
  last_login_at   INTEGER,
  email_verified  INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL DEFAULT 0
);

INSERT INTO users_new (
  id, email, display_name, role, status, visibility, avatar_url,
  account_type, company, created_at, last_login_at, email_verified,
  updated_at
)
SELECT
  id, email, display_name, role, status, visibility, avatar_url,
  account_type, company, created_at, last_login_at, email_verified,
  updated_at
FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

-- Recreate the canonical case-insensitive uniqueness constraint. This
-- is now the SOLE uniqueness rule on `users.email`.
CREATE UNIQUE INDEX users_email_nocase
  ON users(lower(email));

PRAGMA defer_foreign_keys = OFF;
