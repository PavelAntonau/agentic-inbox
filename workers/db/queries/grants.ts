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

import { and, eq } from "drizzle-orm";
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
  rows: ReadonlyArray<{ clientId: string; createdAt: number | null }>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    if (r.createdAt == null) continue;
    const prev = out.get(r.clientId);
    if (prev == null || r.createdAt > prev) {
      out.set(r.clientId, r.createdAt);
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
    granted_at: row.createdAt ?? null,
    last_used_at: lastUsedByClient.get(row.clientId) ?? null,
  }));
}

/**
 * Revoke the (userId, clientId) authorization end-to-end:
 *
 *  - delete every oauth_access_token  WHERE user_id = ? AND client_id = ?
 *  - delete every oauth_refresh_token WHERE user_id = ? AND client_id = ?
 *  - delete every oauth_consent       WHERE user_id = ? AND client_id = ?
 *
 * RFC 7009 §2.1 second paragraph: "If the particular token is a refresh token
 * and the authorization server supports the revocation of access tokens, then
 * the authorization server SHOULD also invalidate all access tokens based on
 * the same authorization grant." This implementation extends that to a
 * grant-level revoke initiated by the resource owner — every token derived
 * from the consent is invalidated atomically from the user's perspective.
 *
 * Returns null when no matching consent is owned by `userId` (the route
 * surfaces 404). On success, returns row counts for audit / observability.
 *
 * The oauth_client row itself is intentionally NOT deleted — clients are
 * a global registration surface, not user-scoped.
 */
export async function revokeAgentAuthorization(
  orm: Orm,
  userId: string,
  clientId: string,
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

  const accessRes = await orm
    .delete(schema.oauth_access_token)
    .where(
      and(
        eq(schema.oauth_access_token.userId, userId),
        eq(schema.oauth_access_token.clientId, clientId),
      ),
    )
    .run();

  const refreshRes = await orm
    .delete(schema.oauth_refresh_token)
    .where(
      and(
        eq(schema.oauth_refresh_token.userId, userId),
        eq(schema.oauth_refresh_token.clientId, clientId),
      ),
    )
    .run();

  const consentRes = await orm
    .delete(schema.oauth_consent)
    .where(
      and(
        eq(schema.oauth_consent.userId, userId),
        eq(schema.oauth_consent.clientId, clientId),
      ),
    )
    .run();

  return {
    consents_deleted: rowCount(consentRes),
    access_tokens_deleted: rowCount(accessRes),
    refresh_tokens_deleted: rowCount(refreshRes),
  };
}

interface MaybeD1Result {
  meta?: { changes?: number };
  rowsAffected?: number;
}

function rowCount(res: unknown): number {
  const r = res as MaybeD1Result;
  return r.meta?.changes ?? r.rowsAffected ?? 0;
}
