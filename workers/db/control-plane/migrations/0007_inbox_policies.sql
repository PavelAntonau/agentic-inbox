-- Phase 2 — Inbox policies: external inbound controls + internal inbound mode
--
-- Adds three policy columns to mailboxes with NOT NULL + DEFAULT so existing
-- rows are backfilled automatically (standard SQLite-on-D1 ADD COLUMN pattern,
-- same as 0006_rate_limit used for rate_limit). No data migration needed.
--
-- external_inbound_enabled  1 = accept external inbound; 0 = reject all external.
-- external_allow_mode       'all' = accept from anyone; 'allowlist' = only patterns in
--                           inbox_external_allowlist.
-- internal_inbound_mode     'everyone' | 'contacts_only' | 'none' — controls which
--                           internal senders may deliver to this inbox.

ALTER TABLE mailboxes ADD COLUMN external_inbound_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE mailboxes ADD COLUMN external_allow_mode TEXT NOT NULL DEFAULT 'all'
  CHECK (external_allow_mode IN ('all', 'allowlist'));
ALTER TABLE mailboxes ADD COLUMN internal_inbound_mode TEXT NOT NULL DEFAULT 'everyone'
  CHECK (internal_inbound_mode IN ('everyone', 'contacts_only', 'none'));

-- Allowlist entries for external_allow_mode = 'allowlist'.
-- kind = 'email' for exact match; kind = 'domain' for suffix match (@example.com).
CREATE TABLE IF NOT EXISTS inbox_external_allowlist (
  id             TEXT    PRIMARY KEY,
  inbox_id       TEXT    NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  sender_pattern TEXT    NOT NULL,
  kind           TEXT    NOT NULL CHECK (kind IN ('email', 'domain')),
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inbox_external_allowlist_inbox
  ON inbox_external_allowlist(inbox_id);
