-- Phase 5 — Privacy-preserving discovery + sender-blind handshake
--
-- D12 (sender-blind decline): decline no longer deletes the row. Instead the
-- recipient sets contacts.declined_at = now, the row stays at status='pending',
-- the recipient's GET /api/contacts filters it out, and the sender's view of
-- their outgoing request continues to read 'pending' indefinitely.

ALTER TABLE contacts ADD COLUMN declined_at INTEGER;
