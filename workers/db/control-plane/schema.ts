// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// 1. users — Cloudflare Access OTP allowlist mirror, with role
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(), // COLLATE NOCASE applied via index below
    display_name: text("display_name"),
    // Three-value role: global_owner is the pinned bootstrap seat;
    // group_owner / group_admin are encoded via groups.owner_user_id
    // and group_members.role_in_group respectively — NOT in this column.
    role: text("role", {
      enum: ["global_owner", "global_admin", "user"],
    })
      .notNull()
      .default("user"),
    status: text("status", { enum: ["active", "disabled"] })
      .notNull()
      .default("active"),
    visibility: text("visibility", {
      enum: ["everyone", "contacts", "nobody"],
    })
      .notNull()
      .default("everyone"),
    avatar_url: text("avatar_url"),
    // Phase 4: profile fields surfaced on /profile (vs /account = private settings).
    account_type: text("account_type", { enum: ["personal", "company"] })
      .notNull()
      .default("personal"),
    company: text("company"),
    created_at: integer("created_at").notNull(),
    last_login_at: integer("last_login_at"),
  },
  (t) => ({
    emailIdx: uniqueIndex("users_email_nocase").on(sql`lower(${t.email})`),
  }),
);

// 2. contacts — symmetric handshake; two-row insert on accept
export const contacts = sqliteTable(
  "contacts",
  {
    owner_user_id: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    contact_user_id: text("contact_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["pending", "accepted", "blocked"],
    }).notNull(),
    initiated_by: text("initiated_by")
      .notNull()
      .references(() => users.id),
    created_at: integer("created_at").notNull(),
    accepted_at: integer("accepted_at"),
    // Phase 5 (D12): set by recipient on decline; row stays status='pending' and
    // the recipient view filters declined_at IS NOT NULL out. Sender never sees
    // this column — their view of their outgoing-request row continues to read
    // 'pending' forever.
    declined_at: integer("declined_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.owner_user_id, t.contact_user_id] }),
  }),
);

// 3. groups — isolation boundary
export const groups = sqliteTable("groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  owner_user_id: text("owner_user_id")
    .notNull()
    .references(() => users.id),
  created_at: integer("created_at").notNull(),
  created_by: text("created_by").references(() => users.id),
});

// 4. group_members
export const group_members = sqliteTable(
  "group_members",
  {
    group_id: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role_in_group: text("role_in_group", { enum: ["admin", "member"] })
      .notNull()
      .default("member"),
    joined_at: integer("joined_at").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.group_id, t.user_id] }),
  }),
);

// 5. group_invitations — privacy-preserving invite flow
export const group_invitations = sqliteTable(
  "group_invitations",
  {
    id: text("id").primaryKey(),
    group_id: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    invitee_email: text("invitee_email").notNull(),
    invitee_user_id: text("invitee_user_id").references(() => users.id),
    invited_by: text("invited_by")
      .notNull()
      .references(() => users.id),
    status: text("status", {
      enum: ["pending", "accepted", "declined", "expired", "cancelled"],
    })
      .notNull()
      .default("pending"),
    created_at: integer("created_at").notNull(),
    expires_at: integer("expires_at").notNull(),
    decided_at: integer("decided_at"),
    decided_by: text("decided_by").references(() => users.id),
  },
  (t) => ({
    // UNIQUE INDEX ON (group_id, invitee_email) WHERE status='pending'
    pendingIdx: uniqueIndex("group_invitations_pending")
      .on(t.group_id, t.invitee_email)
      .where(sql`${t.status} = 'pending'`),
  }),
);

// 6. mailboxes
export const mailboxes = sqliteTable(
  "mailboxes",
  {
    id: text("id").primaryKey(),
    address: text("address").notNull().unique(), // COLLATE NOCASE via index
    display_name: text("display_name"),
    owner_user_id: text("owner_user_id")
      .notNull()
      .references(() => users.id),
    created_at: integer("created_at").notNull(),
    created_by: text("created_by").references(() => users.id),
  },
  (t) => ({
    addressIdx: uniqueIndex("mailboxes_address_nocase").on(
      sql`lower(${t.address})`,
    ),
  }),
);

// 7. mailbox_groups
export const mailbox_groups = sqliteTable(
  "mailbox_groups",
  {
    mailbox_id: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    group_id: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    added_at: integer("added_at").notNull(),
    added_by: text("added_by").references(() => users.id),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.mailbox_id, t.group_id] }),
  }),
);

// 8. agent_tokens — Cloudflare Access service-token mirror
export const agent_tokens = sqliteTable("agent_tokens", {
  id: text("id").primaryKey(),
  cf_service_token_id: text("cf_service_token_id").unique(),
  cf_client_id: text("cf_client_id").unique(),
  secret_hash: text("secret_hash"),
  mailbox_id: text("mailbox_id")
    .notNull()
    .references(() => mailboxes.id, { onDelete: "cascade" }),
  issued_to_user: text("issued_to_user")
    .notNull()
    .references(() => users.id),
  label: text("label"),
  max_instances: integer("max_instances").notNull().default(1),
  created_at: integer("created_at").notNull(),
  last_seen_at: integer("last_seen_at"),
  revoked_at: integer("revoked_at"),
});

// 9. agent_instances — 1:N enforcement
export const agent_instances = sqliteTable("agent_instances", {
  id: text("id").primaryKey(),
  token_id: text("token_id")
    .notNull()
    .references(() => agent_tokens.id, { onDelete: "cascade" }),
  fingerprint: text("fingerprint"),
  connected_at: integer("connected_at").notNull(),
  last_seen_at: integer("last_seen_at"),
  ip: text("ip"),
  user_agent: text("user_agent"),
});

// 10. settings — live-configurable global owner / global admin
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updated_at: integer("updated_at").notNull(),
  updated_by: text("updated_by").references(() => users.id),
});

// 11. mailbox_acls — per-mailbox per-user access level (Phase 4: owner=admin only; explicit overrides in Phase 6)
export const mailbox_acls = sqliteTable(
  "mailbox_acls",
  {
    mailbox_id: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    level: text("level", { enum: ["read", "write", "admin"] })
      .notNull()
      .default("write"),
    granted_at: integer("granted_at").notNull(),
    granted_by: text("granted_by").references(() => users.id),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.mailbox_id, t.user_id] }),
  }),
);

// 12. audit_log — append-only
export const audit_log = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: integer("at").notNull(),
    actor_user_id: text("actor_user_id"),
    actor_token_id: text("actor_token_id"),
    action: text("action").notNull(),
    target_type: text("target_type"),
    target_id: text("target_id"),
    scope_group_id: text("scope_group_id"),
    meta_json: text("meta_json"),
    ip: text("ip"),
  },
  (t) => ({
    atIdx: index("audit_log_at").on(t.at),
  }),
);
