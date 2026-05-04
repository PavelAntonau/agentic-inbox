-- Phase 4: Profile vs Account separation
-- Adds two profile fields surfaced on the public-ish /profile route:
--   account_type — 'personal' | 'company' (Drizzle-level enum, no DB CHECK
--                  to stay consistent with the existing role / visibility
--                  columns; PATCH handler validates).
--   company     — optional free-text company name, shown when
--                  account_type = 'company'.
-- Both columns are independent of /account (private settings: email,
-- visibility, sessions, notifications) per D13.
ALTER TABLE `users` ADD COLUMN `account_type` text NOT NULL DEFAULT 'personal';
ALTER TABLE `users` ADD COLUMN `company` text;
