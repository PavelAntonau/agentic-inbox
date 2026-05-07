-- Phase G / G-3 — Extend audit_log for auth-event observability.
--
-- ───────────────────────────────────────────────────────────────────────────
-- Goal
-- ───────────────────────────────────────────────────────────────────────────
--
-- Add three new columns to the existing audit_log table for auth-event
-- classification and partitioned querying, plus three compound indexes
-- that support the Cron alerter's tier-1 burst-detection queries.
--
-- IMPORTANT: This migration is purely additive (ALTER … ADD COLUMN).
-- Existing rows keep NULL in the new columns — that is the correct sentinel
-- for "recorded before Phase G" and must NOT be backfilled.
--
-- D1 backup: `wrangler d1 export DB --output <file>` before applying.
--
-- ───────────────────────────────────────────────────────────────────────────
-- Pre-flight checks
-- ───────────────────────────────────────────────────────────────────────────
--
-- Run `pnpm wrangler d1 migrations apply DB_NAME --local` to test locally.
-- The statements below are idempotent via `IF NOT EXISTS` on indexes; the
-- ALTER TABLE statements will fail if the column already exists — safe since
-- D1's migrations table tracks applied migrations and won't re-apply this
-- file once it has been stamped.
--
-- ===========================================================================
-- 1. New columns
-- ===========================================================================

-- "success" | "denied" | "error" | NULL (legacy rows, pre-Phase-G)
ALTER TABLE audit_log ADD COLUMN status TEXT;

-- group_id at audit time, denormalized for partitioned alerting queries
ALTER TABLE audit_log ADD COLUMN tenant_id TEXT;

-- User-Agent header, truncated at 500 chars (see USER_AGENT_MAX in audit-log.ts)
ALTER TABLE audit_log ADD COLUMN user_agent TEXT;

-- ===========================================================================
-- 2. Compound indexes for alerter queries
-- ===========================================================================

-- Supports: SELECT … WHERE action = ? ORDER BY at  (e.g. otp_failed bursts)
CREATE INDEX IF NOT EXISTS audit_log_action_at
  ON audit_log (action, at);

-- Supports: SELECT … WHERE tenant_id = ? AND … ORDER BY at
CREATE INDEX IF NOT EXISTS audit_log_tenant_at
  ON audit_log (tenant_id, at);

-- Supports: SELECT … WHERE ip = ? ORDER BY at  (IP-burst detection)
CREATE INDEX IF NOT EXISTS audit_log_ip_at
  ON audit_log (ip, at);
