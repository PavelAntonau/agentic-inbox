// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// workers/db/queries/mcp-inbox-binding.ts — sentinel-table queries for the
// "one inbox, one client" rule (Phase F, migration 0017).
//
// The sentinel table `mcp_inbox_binding` enforces, per (user_id, mailbox_id),
// at most ONE active MCP credential — exclusively a PAT (`kind='pat'`) or an
// OAuth client (`kind='oauth'`). The migration's CHECK constraint guarantees
// the XOR; the composite PK guarantees the cardinality. This module is the
// single place that touches the table — routes/pats.ts (PAT mint + revoke),
// app.ts dispatchMcpRequest (OAuth bind-at-first-call), and the new
// /mcp-credential route all consult these helpers.
//
// Owner-only by construction: every query takes `userId` and scopes WHERE
// clauses to it. Mailbox membership is enforced upstream — this layer
// trusts that the caller already verified `userId` may act on `mailboxId`.

import { and, eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";
import * as schema from "../control-plane/schema";

type Orm = ReturnType<typeof drizzle<typeof schema>>;

/** Normalised binding row returned to route / dispatcher code. */
export interface InboxBindingRow {
  user_id: string;
  mailbox_id: string;
  kind: "pat" | "oauth";
  pat_id: string | null;
  oauth_client_id: string | null;
  created_at: number;
}

/** Outcomes of `bindOauthOnFirstCall`, one branch per dispatcher response. */
export type OauthBindOutcome =
  | { kind: "bound"; binding: InboxBindingRow } // INSERT landed (or already-matching)
  | { kind: "conflict-pat"; binding: InboxBindingRow } // existing PAT credential
  | { kind: "conflict-oauth"; binding: InboxBindingRow }; // different OAuth client

/**
 * Look up the binding row for a given (user, mailbox) pair, or return
 * `null` when none exists. Read-only; safe to call from any path.
 */
export async function getBindingForMailbox(
  orm: Orm,
  userId: string,
  mailboxId: string,
): Promise<InboxBindingRow | null> {
  const row = await orm
    .select({
      userId: schema.mcp_inbox_binding.userId,
      mailboxId: schema.mcp_inbox_binding.mailboxId,
      kind: schema.mcp_inbox_binding.kind,
      patId: schema.mcp_inbox_binding.patId,
      oauthClientId: schema.mcp_inbox_binding.oauthClientId,
      createdAt: schema.mcp_inbox_binding.createdAt,
    })
    .from(schema.mcp_inbox_binding)
    .where(
      and(
        eq(schema.mcp_inbox_binding.userId, userId),
        eq(schema.mcp_inbox_binding.mailboxId, mailboxId),
      ),
    )
    .limit(1)
    .get();

  if (!row) return null;
  return projectRow(row);
}

/**
 * D1-prepared statement that inserts a `kind='pat'` binding row.
 *
 * Returned as a `D1PreparedStatement` so routes/pats.ts can compose it into
 * a `db.batch([insertPatStmt, insertBindingStmt])` — the two writes commit
 * atomically. A pre-existing binding for (user, mailbox) raises
 * `SQLITE_CONSTRAINT_PRIMARYKEY`, which the route layer translates to
 * 409 `inbox-credential-exists`.
 *
 * Caller must already have validated mailbox ownership.
 */
export function buildPatBindingInsertStmt(
  db: D1Database,
  args: {
    userId: string;
    mailboxId: string;
    patId: string;
    now: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO mcp_inbox_binding
         (user_id, mailbox_id, kind, pat_id, oauth_client_id, created_at)
       VALUES (?1, ?2, 'pat', ?3, NULL, ?4)`,
    )
    .bind(args.userId, args.mailboxId, args.patId, args.now);
}

/**
 * Try to bind a (user, mailbox) pair to an OAuth client at first /mcp call.
 *
 * Pattern: `INSERT OR IGNORE` — race-protected by the composite primary key,
 * so two concurrent first-calls always settle on the row that won the race.
 * After the conditional insert we always re-select the canonical row and
 * classify the outcome:
 *
 *   - `bound`           — our INSERT landed, OR an existing oauth row already
 *                         matches `oauthClientId`. Dispatcher proceeds.
 *   - `conflict-pat`    — existing kind='pat' row. Dispatcher returns 403
 *                         `inbox-bound-to-pat`.
 *   - `conflict-oauth`  — existing kind='oauth' row but a different
 *                         `oauthClientId`. Dispatcher returns 403
 *                         `inbox-bound-to-other-client`.
 *
 * Both writes use the raw D1 binding (no drizzle) because the conditional
 * insert is the cheapest way to keep this race-free — drizzle's helper
 * would issue a SELECT-then-INSERT round-trip with no atomicity. Caller
 * must already have validated that `userId` may use `mailboxId`.
 */
export async function bindOauthOnFirstCall(
  db: D1Database,
  args: {
    userId: string;
    mailboxId: string;
    oauthClientId: string;
    now: number;
  },
): Promise<OauthBindOutcome> {
  const insertStmt = db
    .prepare(
      `INSERT OR IGNORE INTO mcp_inbox_binding
         (user_id, mailbox_id, kind, pat_id, oauth_client_id, created_at)
       VALUES (?1, ?2, 'oauth', NULL, ?3, ?4)`,
    )
    .bind(args.userId, args.mailboxId, args.oauthClientId, args.now);

  const selectStmt = db
    .prepare(
      `SELECT user_id, mailbox_id, kind, pat_id, oauth_client_id, created_at
       FROM mcp_inbox_binding
       WHERE user_id = ?1 AND mailbox_id = ?2`,
    )
    .bind(args.userId, args.mailboxId);

  // Batch the conditional INSERT with the SELECT so they hit the same
  // D1 replica view; no observable window between them.
  const [, selectResult] = await db.batch<{
    user_id: string;
    mailbox_id: string;
    kind: string;
    pat_id: string | null;
    oauth_client_id: string | null;
    created_at: number;
  }>([insertStmt, selectStmt]);

  const row = (selectResult.results ?? [])[0];
  if (!row) {
    // Should be impossible: the INSERT OR IGNORE either inserted our row
    // or left an existing row in place. If we still see nothing, something
    // outside this code path deleted the row between INSERT and SELECT.
    // Surface as a bind so the caller can retry on the next call.
    throw new Error(
      `mcp_inbox_binding race: row vanished after INSERT OR IGNORE for user=${args.userId} mailbox=${args.mailboxId}`,
    );
  }

  const binding = projectRawRow(row);

  if (binding.kind === "pat") {
    return { kind: "conflict-pat", binding };
  }
  if (binding.oauth_client_id !== args.oauthClientId) {
    return { kind: "conflict-oauth", binding };
  }
  return { kind: "bound", binding };
}

/**
 * Hard-delete the binding row for (user, mailbox). Used by the user-initiated
 * `/mcp-credential` revoke for the OAuth path — the OAuth `oauth_consent`
 * delete + tombstone do not cascade into `mcp_inbox_binding` because the
 * binding references `oauth_client.client_id`, not the consent row. PAT
 * deletes don't need to call this — `ON DELETE CASCADE` handles them.
 *
 * Returns true if a row was removed, false if there was none.
 */
export async function deleteBindingForMailbox(
  orm: Orm,
  userId: string,
  mailboxId: string,
): Promise<boolean> {
  const result = await orm
    .delete(schema.mcp_inbox_binding)
    .where(
      and(
        eq(schema.mcp_inbox_binding.userId, userId),
        eq(schema.mcp_inbox_binding.mailboxId, mailboxId),
      ),
    )
    .run();

  // drizzle-d1 surfaces the rowsAffected through `meta.changes`.
  const changes =
    (result as { meta?: { changes?: number }; rowsAffected?: number }).meta
      ?.changes ??
    (result as { rowsAffected?: number }).rowsAffected ??
    0;
  return changes > 0;
}

/**
 * Detect the SQLite primary-key violation raised by the PAT-mint batch when
 * the (user, mailbox) pair already has a binding. D1 surfaces the error as
 * a thrown `D1_ERROR` with the SQLite extended-error text in `message` —
 * sniff for `UNIQUE` / `PRIMARY KEY` and the table name.
 *
 * The route layer wraps the batch in a try/catch and uses this helper to
 * decide between 409 `inbox-credential-exists` and a generic 500.
 */
export function isInboxBindingPkConflict(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const msg = (err as { message?: string }).message ?? "";
  if (!msg) return false;
  // SQLite's exact text differs slightly across D1 versions; cover both
  // the "PRIMARY KEY" and "UNIQUE constraint" phrasings.
  const lower = msg.toLowerCase();
  if (!lower.includes("mcp_inbox_binding")) return false;
  return lower.includes("primary key") || lower.includes("unique");
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function projectRow(row: {
  userId: string;
  mailboxId: string;
  kind: string;
  patId: string | null;
  oauthClientId: string | null;
  createdAt: number;
}): InboxBindingRow {
  return {
    user_id: row.userId,
    mailbox_id: row.mailboxId,
    kind: normaliseKind(row.kind),
    pat_id: row.patId,
    oauth_client_id: row.oauthClientId,
    created_at: row.createdAt,
  };
}

function projectRawRow(row: {
  user_id: string;
  mailbox_id: string;
  kind: string;
  pat_id: string | null;
  oauth_client_id: string | null;
  created_at: number;
}): InboxBindingRow {
  return {
    user_id: row.user_id,
    mailbox_id: row.mailbox_id,
    kind: normaliseKind(row.kind),
    pat_id: row.pat_id,
    oauth_client_id: row.oauth_client_id,
    created_at: row.created_at,
  };
}

function normaliseKind(raw: string): "pat" | "oauth" {
  if (raw === "pat" || raw === "oauth") return raw;
  // Migration 0017 CHECK constraint guarantees this never happens; throw to
  // surface schema drift loudly rather than fall through with garbage.
  throw new Error(`mcp_inbox_binding.kind has unexpected value: ${raw}`);
}
