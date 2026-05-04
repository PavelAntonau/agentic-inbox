// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const folders = sqliteTable("folders", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  is_deletable: integer("is_deletable").notNull().default(1),
});

export const emails = sqliteTable("emails", {
  id: text("id").primaryKey(),
  folder_id: text("folder_id")
    .notNull()
    .references(() => folders.id, { onDelete: "cascade" }),
  subject: text("subject"),
  sender: text("sender"),
  recipient: text("recipient"),
  cc: text("cc"),
  bcc: text("bcc"),
  date: text("date"),
  read: integer("read").default(0),
  starred: integer("starred").default(0),
  body: text("body"),
  in_reply_to: text("in_reply_to"),
  email_references: text("email_references"),
  thread_id: text("thread_id"),
  message_id: text("message_id"),
  raw_headers: text("raw_headers"),
  /**
   * In-thread linear predecessor (D-PLAT-3).
   * Set to the previous tip_message_id when a message is appended via
   * MailboxDO.appendToThread. Distinct from RFC 5322 in_reply_to which
   * is preserved as inbound DAG metadata. Nullable — pre-thread emails
   * have no predecessor.
   */
  parent_id: text("parent_id"),
});

export const attachments = sqliteTable("attachments", {
  id: text("id").primaryKey(),
  email_id: text("email_id")
    .notNull()
    .references(() => emails.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  mimetype: text("mimetype").notNull(),
  size: integer("size").notNull(),
  content_id: text("content_id"),
  disposition: text("disposition"),
});

/**
 * Per-mailbox thread table (D-PLAT-3 / D-PLAT-5).
 *
 * Linear chain: tip_message_id always points at the newest email.id in the
 * thread. version is a monotone counter used for ff-only CAS writes
 * (USR-directive-1). parent_thread_id is nullable — set when a thread is
 * forked or linked to another thread.
 *
 * Logical FK: tip_message_id → emails.id. SQLite does not enforce FK
 * constraints in the Durable Object context (pragma foreign_keys is off),
 * but the application invariant is maintained by appendToThread.
 */
export const threads = sqliteTable("threads", {
  id: text("id").primaryKey(),
  subject: text("subject"),
  /** Logical FK → emails.id — the most-recently appended message. */
  tip_message_id: text("tip_message_id"),
  /** Monotone version counter. CAS guard for ff-only thread writes. */
  version: integer("version").notNull().default(0),
  created_at: integer("created_at").notNull(),
  updated_at: integer("updated_at").notNull(),
  /** Nullable — set for forks or cross-thread linkage. */
  parent_thread_id: text("parent_thread_id"),
});
