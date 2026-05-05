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
    // Phase 6.1: better-auth required fields. email_verified is flipped to 1
    // when an email-OTP sign-in succeeds. updated_at is bumped on every
    // mutation; better-auth handles this for the rows it owns.
    email_verified: integer("email_verified", { mode: "boolean" })
      .notNull()
      .default(false),
    updated_at: integer("updated_at").notNull().default(0),
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
    // Phase 2 — inbox policy columns (migration 0007)
    external_inbound_enabled: integer("external_inbound_enabled", {
      mode: "boolean",
    })
      .notNull()
      .default(true),
    external_allow_mode: text("external_allow_mode", {
      enum: ["all", "allowlist"],
    })
      .notNull()
      .default("all"),
    internal_inbound_mode: text("internal_inbound_mode", {
      enum: ["everyone", "contacts_only", "none"],
    })
      .notNull()
      .default("everyone"),
    // Outbound policy (migration 0010). Default 0 = internal-only; flip to 1
    // to allow toolSendEmail / toolSendReply to fall through to env.EMAIL.send()
    // when the destination address is external.
    external_send_enabled: integer("external_send_enabled", { mode: "boolean" })
      .notNull()
      .default(false),
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
// Phase 3 will drop this table after the client_id backfill soak (D-PLAT-6).
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
  // Phase 2 (migration 0009): FK pointing at the backfilled clients row.
  // NULL until the backfill runs; read-only after that.
  // Note: clients table is defined later in this file; the lazy () => clients.id
  // reference is the standard Drizzle pattern for forward references.
  // eslint-disable-next-line @typescript-eslint/no-use-before-define
  client_id: text("client_id").references(() => clients.id),
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

// Phase 6.1 — better-auth tables.
// Field names use camelCase in TS (better-auth's expected JS-side shape),
// snake_case in DB (matches existing project convention). better-auth's
// drizzleAdapter resolves the mapping via the column-builder name argument.

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at").notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    userIdIdx: index("session_user_id_idx").on(t.userId),
    tokenIdx: index("session_token_idx").on(t.token),
    expiresAtIdx: index("session_expires_at_idx").on(t.expiresAt),
  }),
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at"),
    refreshTokenExpiresAt: integer("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    userIdIdx: index("account_user_id_idx").on(t.userId),
    providerIdx: index("account_provider_idx").on(t.providerId, t.accountId),
  }),
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    identifierIdx: index("verification_identifier_idx").on(t.identifier),
    expiresAtIdx: index("verification_expires_at_idx").on(t.expiresAt),
  }),
);

// 13. rate_limit — better-auth rate-limit storage (Phase 1)
//
// better-auth writes to this table when rateLimit.storage = "database".
// Column names must match the library's internal field mapping:
//   id          → PK
//   key         → unique rate-limit identifier (e.g. IP + path hash)
//   count       → requests in the current window
//   lastRequest → epoch ms of last request (camelCase in JS, snake_case in DB)
export const rate_limit = sqliteTable(
  "rate_limit",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull().unique(),
    count: integer("count").notNull().default(0),
    lastRequest: integer("last_request").notNull().default(0),
  },
  (t) => ({
    keyIdx: index("rate_limit_key_idx").on(t.key),
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

// Phase 2 — Inbox external allowlist (migration 0007)
// Entries for mailboxes where external_allow_mode = 'allowlist'.
// kind = 'email' → exact match; kind = 'domain' → suffix match.
export const inboxExternalAllowlist = sqliteTable(
  "inbox_external_allowlist",
  {
    id: text("id").primaryKey(),
    inbox_id: text("inbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    sender_pattern: text("sender_pattern").notNull(),
    kind: text("kind", { enum: ["email", "domain"] }).notNull(),
    created_at: integer("created_at").notNull(),
  },
  (t) => ({
    inboxIdx: index("idx_inbox_external_allowlist_inbox").on(t.inbox_id),
  }),
);

// Phase 2 — Clients table (migration 0008)
// Persists non-browser clients (mcp, ios, desktop, other).
// Browser sessions are projected as kind='browser' at read-time from the
// better-auth session table; they are NOT stored here (D-PLAT-7).
export const clients = sqliteTable(
  "clients",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: ["browser", "mcp", "ios", "desktop", "other"],
    }).notNull(),
    name: text("name").notNull(),
    oauth_client_id: text("oauth_client_id"),
    last_seen_at: integer("last_seen_at"),
    ip_address: text("ip_address"),
    user_agent: text("user_agent"),
    revoked_at: integer("revoked_at"),
    created_at: integer("created_at").notNull(),
  },
  (t) => ({
    userIdx: index("idx_clients_user").on(t.user_id),
    userActiveIdx: index("idx_clients_user_active")
      .on(t.user_id)
      .where(sql`${t.revoked_at} IS NULL`),
  }),
);

// Phase 2 — Client grants table (migration 0008)
// Per-client per-inbox scope grants. UNIQUE on (client_id, inbox_id, scope)
// where revoked_at IS NULL enforces only one active grant per triple.
export const clientGrants = sqliteTable(
  "client_grants",
  {
    id: text("id").primaryKey(),
    client_id: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    inbox_id: text("inbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    scope: text("scope", { enum: ["read", "write"] }).notNull(),
    granted_at: integer("granted_at").notNull(),
    revoked_at: integer("revoked_at"),
  },
  (t) => ({
    activeIdx: uniqueIndex("idx_client_grants_active")
      .on(t.client_id, t.inbox_id, t.scope)
      .where(sql`${t.revoked_at} IS NULL`),
    clientIdx: index("idx_client_grants_client").on(t.client_id),
    inboxIdx: index("idx_client_grants_inbox").on(t.inbox_id),
  }),
);

// Phase 1 (mcp-oauth) — better-auth/plugins/jwt key storage (migration 0011).
// Used while the jwt() plugin runs without a static signing key. T1.4 may
// switch to env-supplied keys, in which case this table stays present but
// unused. Schema mirrors better-auth's plugins/jwt/schema.mjs verbatim.
export const jwks = sqliteTable(
  "jwks",
  {
    id: text("id").primaryKey(),
    publicKey: text("public_key").notNull(),
    privateKey: text("private_key").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at"),
  },
  (t) => ({
    createdAtIdx: index("jwks_created_at_idx").on(t.createdAt),
  }),
);

// Phase 1 (mcp-oauth) — @better-auth/oauth-provider plugin tables (migration 0011).
// Schema mirrors @better-auth/oauth-provider/dist/index.mjs schema export.
// Field-name mapping: TS camelCase ↔ DB snake_case via drizzle column-builder
// (existing project convention; see 0005_better_auth.sql).
//
// JSON-array fields (redirectUris, scopes, grantTypes, responseTypes, contacts,
// postLogoutRedirectUris) and JSON-object metadata are stored as TEXT — better-
// auth's drizzleAdapter handles the encode/decode (string[] / json field types).

// 1. oauth_client — registered OAuth clients.
//    Logical identity is `client_id` (UNIQUE); FKs from tokens/consent target
//    that column. Public clients (PKCE-only, e.g. Claude Code desktop) leave
//    `client_secret` NULL.
export const oauth_client = sqliteTable(
  "oauth_client",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull().unique(),
    clientSecret: text("client_secret"),
    disabled: integer("disabled", { mode: "boolean" }),
    skipConsent: integer("skip_consent", { mode: "boolean" }),
    enableEndSession: integer("enable_end_session", { mode: "boolean" }),
    subjectType: text("subject_type"),
    scopes: text("scopes"),
    userId: text("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at"),
    updatedAt: integer("updated_at"),
    name: text("name"),
    uri: text("uri"),
    icon: text("icon"),
    contacts: text("contacts"),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    softwareStatement: text("software_statement"),
    redirectUris: text("redirect_uris").notNull(),
    postLogoutRedirectUris: text("post_logout_redirect_uris"),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    grantTypes: text("grant_types"),
    responseTypes: text("response_types"),
    public: integer("public", { mode: "boolean" }),
    type: text("type"),
    requirePKCE: integer("require_pkce", { mode: "boolean" }),
    referenceId: text("reference_id"),
    metadata: text("metadata"),
  },
  (t) => ({
    userIdIdx: index("oauth_client_user_id_idx").on(t.userId),
  }),
);

// 2. oauth_consent — per-(client, user) scope grants (PKCE-bound).
export const oauth_consent = sqliteTable(
  "oauth_consent",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauth_client.clientId, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    referenceId: text("reference_id"),
    scopes: text("scopes").notNull(),
    createdAt: integer("created_at"),
    updatedAt: integer("updated_at"),
  },
  (t) => ({
    clientIdIdx: index("oauth_consent_client_id_idx").on(t.clientId),
    userIdIdx: index("oauth_consent_user_id_idx").on(t.userId),
  }),
);

// 3. oauth_refresh_token — refresh-token rotation chain (RFC 6749 §6).
//    `revoked` (date) is set on the previous refresh when issuing a new one.
//    session_id ON DELETE SET NULL preserves the audit trail past sign-out.
//    `token` is UNIQUE: lookup-by-token is the entire purpose of the column,
//    and a duplicate row is a token-replay surface (audit S-1, 2026-05-04).
//    Mirrors the .unique() discipline on session.token (L292) and
//    oauth_access_token.token (L594). Migration 0013 adds the index.
export const oauth_refresh_token = sqliteTable(
  "oauth_refresh_token",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauth_client.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => session.id, {
      onDelete: "set null",
    }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    expiresAt: integer("expires_at"),
    createdAt: integer("created_at"),
    revoked: integer("revoked"),
    authTime: integer("auth_time"),
    scopes: text("scopes").notNull(),
  },
  (t) => ({
    clientIdIdx: index("oauth_refresh_token_client_id_idx").on(t.clientId),
    userIdIdx: index("oauth_refresh_token_user_id_idx").on(t.userId),
  }),
);

// 4. oauth_access_token — issued bearer access tokens (JWT or opaque).
//    `token` UNIQUE-when-set: opaque tokens are looked up by it; JWT tokens
//    are validated by signature + aud and don't need table lookup.
export const oauth_access_token = sqliteTable(
  "oauth_access_token",
  {
    id: text("id").primaryKey(),
    token: text("token").unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauth_client.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => session.id, {
      onDelete: "set null",
    }),
    userId: text("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    referenceId: text("reference_id"),
    refreshId: text("refresh_id").references(() => oauth_refresh_token.id, {
      onDelete: "set null",
    }),
    expiresAt: integer("expires_at"),
    createdAt: integer("created_at"),
    scopes: text("scopes").notNull(),
  },
  (t) => ({
    clientIdIdx: index("oauth_access_token_client_id_idx").on(t.clientId),
    userIdIdx: index("oauth_access_token_user_id_idx").on(t.userId),
    expiresAtIdx: index("oauth_access_token_expires_at_idx").on(t.expiresAt),
  }),
);

// Phase 3 (mcp-oauth) — Personal Access Tokens (PATs).
// Migration 0012. v0.1 headless-agent auth (D-mcp-auth-2). Display-once
// flow: POST returns the full token ONCE, GET shows token_prefix/token_suffix
// only. token_hash = HMAC-SHA-256(TOKEN_PEPPER, plaintext) hex (matches the
// agent_tokens pattern). T3.3 wires the bearer middleware to look up by hash.
export const oauth_personal_access_token = sqliteTable(
  "oauth_personal_access_token",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    tokenPrefix: text("token_prefix").notNull(),
    tokenSuffix: text("token_suffix").notNull(),
    scopes: text("scopes").notNull(),
    mailboxId: text("mailbox_id").references(() => mailboxes.id, {
      onDelete: "cascade",
    }),
    ipAllowlist: text("ip_allowlist"),
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at"),
    expiresAt: integer("expires_at"),
    revokedAt: integer("revoked_at"),
  },
  (t) => ({
    userIdIdx: index("oauth_personal_access_token_user_id_idx").on(t.userId),
    tokenHashIdx: index("oauth_personal_access_token_token_hash_idx").on(
      t.tokenHash,
    ),
  }),
);
