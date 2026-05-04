-- Phase 3b: avatar persistence
-- Adds avatar_url column to users for the profile-picture upload flow.
-- The actual image lives in R2 at avatars/<user_id>/<sha256>.<ext>; this
-- column stores the public URL the UI should fetch.
ALTER TABLE `users` ADD COLUMN `avatar_url` text;
