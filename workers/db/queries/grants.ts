// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// workers/db/queries/grants.ts — OAuth-grant queries for the Connected Agents UI.
//
// "Agent authorization" = the (user, client) tuple of an oauth_consent row plus
// any access/refresh tokens minted from it. The Connected Agents card on
// /account renders one row per consent; the Revoke button calls DELETE which
// performs RFC 7009-style revocation across the (user, client) grant.
//
// Owner-only by construction: every query takes `userId` and scopes WHERE
// clauses to it. The route layer (workers/routes/agent-authorizations.ts)
// supplies the value from authzContext.user_id.

import { and, eq, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";
import * as schema from "../control-plane/schema";

type Orm = ReturnType<typeof drizzle<typeof schema>>;

export interface AgentAuthorizationRow {
  client_id: string;
  client_name: string | null;
  client_uri: string | null;
  client_icon: string | null;
  scopes: string[];
  granted_at: number | null;
  last_used_at: number | null;
}

export interface RevokeResult {
  consents_deleted: number;
  access_tokens_deleted: number;
  refresh_tokens_deleted: number;
}

/**
 * Parse the `scopes` column. Better-auth's drizzleAdapter writes string[] fields
 * as JSON-stringified arrays; some upstream code paths and historical rows use
 * the OAuth space-delimited convention. Tolerate both; ignore non-string members.
 */
export function parseScopes(scopes: string | null | undefined): string[] {
  if (!scopes) return [];
  const trimmed = scopes.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.filter((s): s is string => typeof s === "string");
      }
    } catch {
      // fall through to whitespace split
    }
  }
  return trimmed.split(/\s+/).filter(Boolean);
}

/**
 * Reduce a stream of (clientId, createdAt) access-token rows into a
 * client_id → max(createdAt) map. Skips null timestamps.
 */
export function maxCreatedByClient(
  rows: ReadonlyArray<{ clientId: string; createdAt: Date | number | null }>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    if (r.createdAt == null) continue;
    const ms =
      r.createdAt instanceof Date ? r.createdAt.getTime() : r.createdAt;
    const prev = out.get(r.clientId);
    if (prev == null || ms > prev) {
      out.set(r.clientId, ms);
    }
  }
  return out;
}

/**
 * List every OAuth grant owned by `userId`. One row per oauth_consent,
 * enriched with client metadata (name/uri/icon) and the most recent
 * access-token mint timestamp ("last_used_at").
 */
export async function listAgentAuthorizations(
  orm: Orm,
  userId: string,
): Promise<AgentAuthorizationRow[]> {
  const consents = await orm
    .select({
      clientId: schema.oauth_consent.clientId,
      scopes: schema.oauth_consent.scopes,
      createdAt: schema.oauth_consent.createdAt,
      clientName: schema.oauth_client.name,
      clientUri: schema.oauth_client.uri,
      clientIcon: schema.oauth_client.icon,
    })
    .from(schema.oauth_consent)
    .innerJoin(
      schema.oauth_client,
      eq(schema.oauth_client.clientId, schema.oauth_consent.clientId),
    )
    .where(eq(schema.oauth_consent.userId, userId))
    .all();

  if (consents.length === 0) return [];

  const tokenRows = await orm
    .select({
      clientId: schema.oauth_access_token.clientId,
      createdAt: schema.oauth_access_token.createdAt,
    })
    .from(schema.oauth_access_token)
    .where(eq(schema.oauth_access_token.userId, userId))
    .all();

  const lastUsedByClient = maxCreatedByClient(tokenRows);

  return consents.map((row) => ({
    client_id: row.clientId,
    client_name: row.clientName ?? null,
    client_uri: row.clientUri ?? null,
    client_icon: row.clientIcon ?? null,
    scopes: parseScopes(row.scopes),
    granted_at:
      row.createdAt instanceof Date
        ? row.createdAt.getTime()
        : (row.createdAt ?? null),
    last_used_at: lastUsedByClient.get(row.clientId) ?? null,
  }));
}

/**
 * Revoke the (userId, clientId) authorization end-to-end, transactionally.
 *
 * Phase C2 / TASK-C2.2 (audit A-03): rewritten as a single `db.batch([...])`
 * D1 statement so the four writes commit atomically.  The previous
 * sequential `await orm.delete(...).run()` chain left an observable window
 * after the access-token DELETE but before the refresh-token DELETE in
 * which a refresh-rotation by the revoked client could mint a fresh
 * access token from the still-present refresh row.  Audit's "race window
 * around revoke" finding closes here.
 *
 * Phase C2 / TASK-C2.12 (audit P1-1, JWT revocation Path 2): the same
 * batch INSERTs an `oauth_grant_tombstone` row keyed by (user, client)
 * with `revoked_at = now`.  The /mcp bearer middleware reads the
 * tombstone on every JWT request and rejects bearers whose iat predates
 * the tombstone, so an in-flight access JWT minted moments before the
 * revoke also gets cut off — without the tombstone, the JWT remains
 * signature-valid until its 15-minute expiry.
 *
 * Operations performed in one batch:
 *   1. INSERT INTO oauth_grant_tombstone — sets the iat-cutoff floor.
 *      ON CONFLICT (user, client) DO UPDATE refreshes the floor when
 *      the same grant is revoked twice (e.g. after the user re-grants
 *      and revokes again — the new floor moves forward in time).
 *   2. DELETE FROM oauth_access_token WHERE user_id=? AND client_id=?
 *   3. DELETE FROM oauth_refresh_token WHERE user_id=? AND client_id=?
 *   4. DELETE FROM oauth_consent       WHERE user_id=? AND client_id=?
 *
 * The pre-flight ownership lookup stays out of the batch — it's a SELECT
 * (D1 batch is for writes) and we want to short-circuit early on 404.
 *
 * RFC 7009 §2.1 second paragraph: "If the particular token is a refresh
 * token and the authorization server supports the revocation of access
 * tokens, then the authorization server SHOULD also invalidate all access
 * tokens based on the same authorization grant." We extend that to a
 * grant-level revoke initiated by the resource owner — every token
 * derived from the consent is invalidated atomically from the user's
 * perspective, AND in-flight JWTs honour the tombstone.
 *
 * Returns null when no matching consent is owned by `userId` (the route
 * surfaces 404). On success, returns row counts for audit / observability.
 *
 * The oauth_client row itself is intentionally NOT deleted — clients are
 * a global registration surface, not user-scoped.
 */
export async function revokeAgentAuthorization(
  orm: Orm,
  db: D1Database,
  userId: string,
  clientId: string,
  now: number = Date.now(),
): Promise<RevokeResult | null> {
  const owned = await orm
    .select({ id: schema.oauth_consent.id })
    .from(schema.oauth_consent)
    .where(
      and(
        eq(schema.oauth_consent.userId, userId),
        eq(schema.oauth_consent.clientId, clientId),
      ),
    )
    .limit(1)
    .get();

  if (!owned) return null;

  // Bind the four writes against the underlying D1 binding so they land
  // in a single D1 batch (atomic at the storage layer). Drizzle's
  // `delete().run()` would issue 3 round-trips; D1 batch is one.
  const tombstoneStmt = db
    .prepare(
      `INSERT INTO oauth_grant_tombstone (user_id, client_id, revoked_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(user_id, client_id) DO UPDATE SET revoked_at = excluded.revoked_at`,
    )
    .bind(userId, clientId, now);

  const accessStmt = db
    .prepare(
      `DELETE FROM oauth_access_token WHERE user_id = ?1 AND client_id = ?2`,
    )
    .bind(userId, clientId);

  const refreshStmt = db
    .prepare(
      `DELETE FROM oauth_refresh_token WHERE user_id = ?1 AND client_id = ?2`,
    )
    .bind(userId, clientId);

  const consentStmt = db
    .prepare(`DELETE FROM oauth_consent WHERE user_id = ?1 AND client_id = ?2`)
    .bind(userId, clientId);

  // Tombstone first — even if the deletes somehow failed mid-batch, the
  // tombstone alone would still cut off in-flight JWTs. D1 guarantees
  // atomicity, so this is belt-and-braces ordering, not a partial-fail
  // strategy.
  const results = await db.batch([
    tombstoneStmt,
    accessStmt,
    refreshStmt,
    consentStmt,
  ]);

  // results[0] is the tombstone INSERT (we don't read its rowCount).
  return {
    consents_deleted: rowCount(results[3]),
    access_tokens_deleted: rowCount(results[1]),
    refresh_tokens_deleted: rowCount(results[2]),
  };
}

// Suppress the "unused" lint on `sql` — it's intentionally imported for
// future query construction in this file (the batch above uses raw SQL,
// but follow-up additions should use the drizzle-tagged path when
// possible).
void sql;

interface MaybeD1Result {
  meta?: { changes?: number };
  rowsAffected?: number;
}

function rowCount(res: unknown): number {
  const r = res as MaybeD1Result;
  return r.meta?.changes ?? r.rowsAffected ?? 0;
}
