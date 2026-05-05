// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// workers/db/queries/pats.ts — Personal Access Token queries.
//
// Owner-only by construction: every read/write filters on `userId`. The route
// layer (workers/routes/pats.ts) supplies the value from authzContext.user_id.
//
// T3.3 (2026-05-04) added `getActivePatByHash` + `touchPatLastUsedAt` for the
// bearer middleware's PAT-by-hash fallback path on /mcp.

import { and, eq, gt, isNull, or, desc } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";
import * as schema from "../control-plane/schema";

type Orm = ReturnType<typeof drizzle<typeof schema>>;

/** Public-facing PAT row (never includes hash or full token). */
export interface PatListRow {
  id: string;
  label: string;
  token_prefix: string;
  token_suffix: string;
  scopes: string[];
  mailbox_id: string | null;
  ip_allowlist: string[] | null;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
}

/** Newly-minted PAT — full token returned ONCE on create. */
export interface PatCreateResult {
  pat: PatListRow;
  /** Display-once plaintext. Caller MUST NOT log or persist. */
  token: string;
}

export interface PatInsert {
  id: string;
  userId: string;
  label: string;
  tokenHash: string;
  tokenPrefix: string;
  tokenSuffix: string;
  scopes: string[];
  mailboxId: string | null;
  ipAllowlist: string[] | null;
  createdAt: number;
  expiresAt: number | null;
}

/**
 * Parse a JSON-array TEXT column into a string[]; tolerate null/empty.
 * Mirrors the parseScopes pattern from grants.ts but does NOT fall through
 * to whitespace split — PAT scopes/ip_allowlist are always JSON-encoded by
 * this surface (no legacy/seeded rows).
 */
export function parseJsonStringArray(
  raw: string | null | undefined,
): string[] | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((s): s is string => typeof s === "string");
  } catch {
    return null;
  }
}

/** Project a raw DB row into the public PatListRow shape. */
export function projectPatRow(row: {
  id: string;
  label: string;
  tokenPrefix: string;
  tokenSuffix: string;
  scopes: string;
  mailboxId: string | null;
  ipAllowlist: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
}): PatListRow {
  return {
    id: row.id,
    label: row.label,
    token_prefix: row.tokenPrefix,
    token_suffix: row.tokenSuffix,
    scopes: parseJsonStringArray(row.scopes) ?? [],
    mailbox_id: row.mailboxId,
    ip_allowlist: parseJsonStringArray(row.ipAllowlist),
    created_at: row.createdAt,
    last_used_at: row.lastUsedAt,
    expires_at: row.expiresAt,
    revoked_at: row.revokedAt,
  };
}

/**
 * Insert a PAT. Returns the projected row (without the plaintext token —
 * the caller already has that and is responsible for one-time display).
 */
export async function insertPat(
  orm: Orm,
  input: PatInsert,
): Promise<PatListRow> {
  const values = {
    id: input.id,
    userId: input.userId,
    label: input.label,
    tokenHash: input.tokenHash,
    tokenPrefix: input.tokenPrefix,
    tokenSuffix: input.tokenSuffix,
    scopes: JSON.stringify(input.scopes),
    mailboxId: input.mailboxId,
    ipAllowlist:
      input.ipAllowlist == null ? null : JSON.stringify(input.ipAllowlist),
    createdAt: input.createdAt,
    lastUsedAt: null,
    expiresAt: input.expiresAt,
    revokedAt: null,
  } as const;

  await orm.insert(schema.oauth_personal_access_token).values(values);
  return projectPatRow({
    id: values.id,
    label: values.label,
    tokenPrefix: values.tokenPrefix,
    tokenSuffix: values.tokenSuffix,
    scopes: values.scopes,
    mailboxId: values.mailboxId,
    ipAllowlist: values.ipAllowlist,
    createdAt: values.createdAt,
    lastUsedAt: values.lastUsedAt,
    expiresAt: values.expiresAt,
    revokedAt: values.revokedAt,
  });
}

/**
 * List every PAT owned by `userId`. Includes revoked rows so the UI can
 * render a "Revoked" badge if it wants; route layer can filter post-hoc.
 * Newest-first by created_at.
 */
export async function listPatsForUser(
  orm: Orm,
  userId: string,
): Promise<PatListRow[]> {
  const rows = await orm
    .select({
      id: schema.oauth_personal_access_token.id,
      label: schema.oauth_personal_access_token.label,
      tokenPrefix: schema.oauth_personal_access_token.tokenPrefix,
      tokenSuffix: schema.oauth_personal_access_token.tokenSuffix,
      scopes: schema.oauth_personal_access_token.scopes,
      mailboxId: schema.oauth_personal_access_token.mailboxId,
      ipAllowlist: schema.oauth_personal_access_token.ipAllowlist,
      createdAt: schema.oauth_personal_access_token.createdAt,
      lastUsedAt: schema.oauth_personal_access_token.lastUsedAt,
      expiresAt: schema.oauth_personal_access_token.expiresAt,
      revokedAt: schema.oauth_personal_access_token.revokedAt,
    })
    .from(schema.oauth_personal_access_token)
    .where(eq(schema.oauth_personal_access_token.userId, userId))
    .orderBy(desc(schema.oauth_personal_access_token.createdAt))
    .all();

  return rows.map(projectPatRow);
}

/**
 * Active PAT row returned by `getActivePatByHash`. Carries enough metadata
 * for the bearer middleware to apply scope / mailbox / IP-allowlist policy
 * downstream (mailbox + ip_allowlist enforcement is T3.6's e2e brief; this
 * row surfaces the columns so the path is plumbed end-to-end).
 */
export interface ActivePatRow {
  id: string;
  user_id: string;
  scopes: string[];
  mailbox_id: string | null;
  ip_allowlist: string[] | null;
  expires_at: number | null;
}

/**
 * Look up an active PAT by its token_hash.
 *
 * "Active" means: not revoked AND (no expiry OR expiry in the future relative
 * to `now`). The unique index on `token_hash` (migration 0012) makes this
 * O(log N) on D1. Returns null when no active row matches — the bearer
 * middleware surfaces that as `pat-not-found` / `invalid_token`.
 *
 * Pepper rotation note: rows are looked up by HMAC-SHA-256 hex digests, so
 * any pepper change invalidates the existing PATs en masse. T3.4's
 * decommissioning of `agent_tokens` does NOT touch `TOKEN_PEPPER` — the
 * shared secret stays stable across the migration.
 */
export async function getActivePatByHash(
  orm: Orm,
  tokenHash: string,
  now: number,
): Promise<ActivePatRow | null> {
  const row = await orm
    .select({
      id: schema.oauth_personal_access_token.id,
      userId: schema.oauth_personal_access_token.userId,
      scopes: schema.oauth_personal_access_token.scopes,
      mailboxId: schema.oauth_personal_access_token.mailboxId,
      ipAllowlist: schema.oauth_personal_access_token.ipAllowlist,
      expiresAt: schema.oauth_personal_access_token.expiresAt,
    })
    .from(schema.oauth_personal_access_token)
    .where(
      and(
        eq(schema.oauth_personal_access_token.tokenHash, tokenHash),
        isNull(schema.oauth_personal_access_token.revokedAt),
        or(
          isNull(schema.oauth_personal_access_token.expiresAt),
          gt(schema.oauth_personal_access_token.expiresAt, now),
        ),
      ),
    )
    .limit(1)
    .get();

  if (!row) return null;
  return {
    id: row.id,
    user_id: row.userId,
    scopes: parseJsonStringArray(row.scopes) ?? [],
    mailbox_id: row.mailboxId,
    ip_allowlist: parseJsonStringArray(row.ipAllowlist),
    expires_at: row.expiresAt,
  };
}

/**
 * Set `last_used_at = now` on the given PAT. Caller invokes via
 * `ctx.waitUntil(...)` so the /mcp response isn't blocked on the write;
 * a failure here is logged but does not invalidate the bearer outcome.
 *
 * No owner check — the row was already authenticated by hash match.
 */
export async function touchPatLastUsedAt(
  orm: Orm,
  patId: string,
  now: number,
): Promise<void> {
  await orm
    .update(schema.oauth_personal_access_token)
    .set({ lastUsedAt: now })
    .where(eq(schema.oauth_personal_access_token.id, patId));
}

/**
 * Revoke a PAT (soft-delete: set revoked_at). Returns the revocation
 * timestamp on success or null when the row does not belong to `userId`,
 * does not exist, or is already revoked. Owner-only by construction —
 * "wrong owner" and "already revoked" both surface as 404 at the route
 * layer (intentional info-non-disclosure, mirrors agent-authorizations).
 */
export async function revokePatForUser(
  orm: Orm,
  userId: string,
  patId: string,
  now: number,
): Promise<number | null> {
  const owned = await orm
    .select({ id: schema.oauth_personal_access_token.id })
    .from(schema.oauth_personal_access_token)
    .where(
      and(
        eq(schema.oauth_personal_access_token.id, patId),
        eq(schema.oauth_personal_access_token.userId, userId),
        isNull(schema.oauth_personal_access_token.revokedAt),
      ),
    )
    .limit(1)
    .get();

  if (!owned) return null;

  await orm
    .update(schema.oauth_personal_access_token)
    .set({ revokedAt: now })
    .where(eq(schema.oauth_personal_access_token.id, patId));

  return now;
}
