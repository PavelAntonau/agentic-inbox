// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// workers/db/queries/pats.ts — Personal Access Token queries.
//
// Owner-only by construction: every read/write filters on `userId`. The route
// layer (workers/routes/pats.ts) supplies the value from authzContext.user_id.
//
// T3.3 will add a hash-lookup helper here for the bearer middleware
// (`getActivePatByHash`); T3.1 covers create/list/revoke only.

import { and, eq, isNull, desc } from "drizzle-orm";
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
