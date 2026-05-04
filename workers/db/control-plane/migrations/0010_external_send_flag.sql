-- Phase Hardening — Per-mailbox external_send_enabled flag (default 0 = internal-only)
--
-- Companion to 0007_inbox_policies.sql, which added external_inbound_enabled
-- DEFAULT 1. Outbound policy default is the inverse: internal-only unless the
-- owner explicitly opts a mailbox into external sending. New rows ship with
-- external_send_enabled=0; existing rows are backfilled to 0 by SQLite's
-- ADD COLUMN ... DEFAULT 0 semantics.
--
-- The flag is read by toolSendEmail / toolSendReply (workers/lib/tools.ts) when
-- the destination address is external (i.e. not resolvable to a mailbox in our
-- D1 mailboxes table or R2 v1 bucket). Internal sends bypass this flag and
-- short-circuit through workers/lib/internal-delivery.ts.

ALTER TABLE mailboxes ADD COLUMN external_send_enabled INTEGER NOT NULL DEFAULT 0;
