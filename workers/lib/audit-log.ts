// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/control-plane/schema";
import type { AuthzContext } from "../db/control-plane/forGroup";

/**
 * Phase C3 / TASK-C3.1 — unified audit-log helper.
 * Phase E / TASK-E.3 — full migration: every call site uses `writeAudit`
 *   directly. The legacy `appendAudit` shim is removed.
 * Phase G / G-3 — extended with status, tenant_id, user_agent columns and
 *   an Analytics Engine mirror via `ctx.waitUntil` (AUTH_ANALYTICS binding).
 *
 * `writeAudit` is the single chokepoint:
 *   • Insert is wrapped in an internal try/catch (fire-and-forget).
 *   • Pass an `AuthzContext` via `actor`, OR pass `actor_user_id` /
 *     `actor_token_id` explicitly (the MCP path does the latter so it can
 *     record both columns when a service token row carries both the user
 *     it was issued to AND the token id).
 *   • Source IP is `cf-connecting-ip` only; `x-forwarded-for` is dropped
 *     (the MCP helper had a spoofable fallback before — audit P2-3).
 *   • Size caps protect against a misbehaving client filling D1: tool_name
 *     truncated at 200 chars, mcp_method truncated at 100 chars, meta_json
 *     truncated at 8 KB after stringify, user_agent truncated at 500 chars.
 */

const TOOL_NAME_MAX = 200;
const MCP_METHOD_MAX = 100;
const META_JSON_MAX = 8 * 1024;
/** Phase G / G-3 — user-agent header cap (500 chars). */
const USER_AGENT_MAX = 500;

function truncate(s: string | null, max: number): string | null {
  if (s === null) return null;
  return s.length <= max ? s : s.slice(0, max);
}

/**
 * Stringify `meta` and cap its byte length.
 *
 * If the JSON exceeds `META_JSON_MAX`, drop in a sentinel object that records
 * the original byte length so observability dashboards can spot the
 * truncation — instead of silently shipping a malformed prefix.
 */
function safeMetaJson(meta: unknown): string | null {
  if (meta === undefined || meta === null) return null;
  let json: string;
  try {
    json = JSON.stringify(meta);
  } catch {
    return JSON.stringify({ error: "audit_meta_unstringifiable" });
  }
  if (json.length <= META_JSON_MAX) return json;
  return JSON.stringify({
    error: "audit_meta_truncated",
    original_bytes: json.length,
  });
}

/**
 * Best-effort client IP — Workers runtime only ever populates
 * `cf-connecting-ip`. The previous MCP helper also looked at
 * `x-forwarded-for` which is spoofable at the public edge (see audit P2-3).
 */
export function clientIp(request: Request): string | null {
  return request.headers.get("cf-connecting-ip");
}

export interface AuditWrite {
  /** Dot-namespaced action, e.g. `mailbox.create`, `mcp.request`. */
  action: string;
  /** Free-form target descriptor. `kind` becomes `target_type`, `id` becomes `target_id`. */
  target: { kind: string; id: string };
  /**
   * Phase E / TASK-E.3 — convenience: pass the AuthzContext directly and
   * the helper splits it into `actor_user_id` / `actor_token_id` using the
   * same rule the legacy shim used (token-issued requests record only the
   * token id; user-credential requests record only the user id). When you
   * already have the ids in hand (the MCP path does), pass them via the
   * explicit fields below instead.
   */
  actor?: AuthzContext;
  /** Explicit user-id override; pass when `actor` is not available. */
  actor_user_id?: string | null;
  /** Explicit token-id override; pass when `actor` is not available. */
  actor_token_id?: string | null;
  /** Group scope when the action is group-bound; null otherwise. */
  scope_group_id?: string | null;
  /** Free-form metadata. JSON.stringify'd; truncated past 8 KB. */
  meta?: unknown;
  /** Originating client IP. Only `cf-connecting-ip` is honoured. */
  ip?: string | null;
  /** MCP-specific overrides — when set, override target_type/target_id. */
  mcp_method?: string | null;
  tool_name?: string | null;
  /**
   * Phase G / G-3 — outcome classification.
   * "success" | "denied" | "error" — or omit for non-auth rows.
   */
  status?: "success" | "denied" | "error" | null;
  /**
   * Phase G / G-3 — group_id at audit time, denormalized for partitioned
   * alerter queries. Matches scope_group_id in most cases; separated so
   * auth events (which may not have a group scope) can still carry it.
   */
  tenant_id?: string | null;
  /**
   * Phase G / G-3 — User-Agent header value. Truncated at USER_AGENT_MAX
   * (500 chars) before storage.
   */
  user_agent?: string | null;
  /**
   * Phase G / G-3 — Analytics Engine binding and ExecutionContext for the
   * write-data-point mirror. When provided, a `writeDataPoint` call is
   * dispatched via `ctx.waitUntil()` and never blocks the D1 insert.
   * If the binding is absent the mirror is silently skipped.
   */
  analyticsEngine?: AnalyticsEngineDataset | null;
  ctx?: Pick<ExecutionContext, "waitUntil"> | null;
}

/**
 * Derive the (user_id, token_id) pair the D1 insert needs from whichever
 * shape the caller supplied. Order of precedence:
 *   1. Explicit `actor_user_id` / `actor_token_id` — both default to null
 *      when missing.
 *   2. `actor: AuthzContext` — token-issued contexts record only the token,
 *      user-credential contexts record only the user.
 *   3. Both null when neither is supplied (system-emitted audit rows).
 */
function deriveActor(row: AuditWrite): {
  user: string | null;
  token: string | null;
} {
  if (row.actor_user_id !== undefined || row.actor_token_id !== undefined) {
    return {
      user: row.actor_user_id ?? null,
      token: row.actor_token_id ?? null,
    };
  }
  if (row.actor) {
    return {
      user: row.actor.agent_token_id ? null : row.actor.user_id,
      token: row.actor.agent_token_id ?? null,
    };
  }
  return { user: null, token: null };
}

/**
 * Single audit-log writer. Wraps the D1 insert in try/catch so callers never
 * have to worry about audit failures bubbling up — fire-and-forget by
 * construction.
 *
 * Phase G / G-3: also mirrors the row to Analytics Engine via
 * `ctx.waitUntil(analyticsEngine.writeDataPoint(...))`. The mirror is best-
 * effort — any error is swallowed and never propagates. If the binding or
 * ctx is absent, the mirror is silently skipped.
 */
export async function writeAudit(
  db: D1Database,
  row: AuditWrite,
): Promise<void> {
  // Snapshot `at` once so the D1 row and AE datapoint share the same timestamp.
  const at = Date.now();

  try {
    const orm = drizzle(db, { schema });

    // MCP overrides: the audit-log-mcp call site records the JSON-RPC method
    // and tool name in `target_type` / `target_id` so observability can split
    // tools/call from tools/list.
    const target_type =
      row.tool_name !== undefined && row.tool_name !== null
        ? "mcp:tool"
        : row.mcp_method !== undefined && row.mcp_method !== null
          ? "mcp:rpc"
          : row.target.kind;
    const target_id_raw =
      row.tool_name !== undefined && row.tool_name !== null
        ? row.tool_name
        : row.mcp_method !== undefined && row.mcp_method !== null
          ? row.mcp_method
          : row.target.id;
    const target_id = truncate(target_id_raw, TOOL_NAME_MAX) ?? row.target.id;

    // For mcp.request rows we always store the rpc-method-or-tool-name in the
    // target columns; meta_json carries the secondary one + scopes/duration.
    const meta_json = safeMetaJson(
      row.meta !== undefined
        ? row.meta
        : row.mcp_method
          ? { mcp_method: truncate(row.mcp_method, MCP_METHOD_MAX) }
          : undefined,
    );

    const { user, token } = deriveActor(row);

    // Phase G / G-3 — new columns.
    const status = row.status ?? null;
    const tenant_id = row.tenant_id ?? null;
    const user_agent = truncate(row.user_agent ?? null, USER_AGENT_MAX);

    await orm
      .insert(schema.audit_log)
      .values({
        at,
        actor_user_id: user,
        actor_token_id: token,
        action: row.action,
        target_type,
        target_id,
        scope_group_id: row.scope_group_id ?? null,
        meta_json,
        ip: row.ip ?? null,
        // Phase G / G-3
        status,
        tenant_id,
        user_agent,
      })
      .run();
  } catch (e) {
    // Fire-and-forget: never block the operation on audit failures. Log so
    // observability can spot a sustained outage; the row is lost on purpose.
    console.error("audit.write_failed", (e as Error).message);
  }

  // Phase G / G-3 — Analytics Engine mirror (best-effort, never blocks D1).
  // Guards: binding may be absent in tests or non-auth paths.
  if (row.analyticsEngine && row.ctx) {
    const ae = row.analyticsEngine;
    const { user, token } = deriveActor(row);
    const mirror = async (): Promise<void> => {
      try {
        ae.writeDataPoint({
          indexes: [row.action, row.status ?? "null", row.tenant_id ?? "null"],
          doubles: [at],
          blobs: [
            user ?? "",
            token ?? "",
            row.target?.kind ?? "",
            row.target?.id ?? "",
            row.ip ?? "",
            truncate(row.user_agent ?? null, USER_AGENT_MAX) ?? "",
          ],
        });
      } catch {
        // Intentionally swallowed — AE failure must not propagate.
      }
    };
    row.ctx.waitUntil(mirror());
  }
}

// Phase E / TASK-E.3 — the legacy `appendAudit(db, actor, action, target,
// meta?)` shim has been REMOVED. Every call site uses `writeAudit(db, {
// action, target, actor, meta })` directly. The migration-completeness test
// at `workers/lib/audit-log.test.ts` asserts no `appendAudit` reference
// remains anywhere in `workers/`.
