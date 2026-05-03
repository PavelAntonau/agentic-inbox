-- Phase 4: mailbox_acls table
-- Per-mailbox per-user access level.
-- Phase 4 writes only the implicit "owner = admin" row at mailbox creation.
-- Explicit ACL overrides (read-only viewer, etc.) ship in Phase 6.
CREATE TABLE `mailbox_acls` (
  `mailbox_id` text NOT NULL,
  `user_id` text NOT NULL,
  `level` text NOT NULL DEFAULT 'write',
  `granted_at` integer NOT NULL,
  `granted_by` text,
  PRIMARY KEY(`mailbox_id`, `user_id`),
  FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`granted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
