// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// T2.2 (mcp-oauth) — Audit-log writer for /mcp bearer-authenticated requests.
//
// Writes one row per /mcp request into the existing `audit_log` table
// (workers/db/control-plane/schema.ts:368). Schema is shared with the rest of
// the app's audit surface (workers/lib/audit-log.ts), which keeps observability
// queries unified.
//
// Row shape:
//   action       = "mcp.request"
//   actor_user_id= bearer.user_id
//   actor_token_id = bearer.client_id  (reuse this column to record the OAuth
//                  client_id; aligns with the existing semantic of "what
//                  programmatic identity ran the action" — the column existed
//                  for the legacy `agent_tokens` path being deprecated in
//                  T3.4, and the OAuth client_id is the natural successor).
//   target_type  = "mcp:tool" | "mcp:rpc"
//   target_id    = JSON-RPC method/tool name when extractable, else "(unknown)"
//   meta_json    = { jti, scopes, http_status, duration_ms, mcp_method }
//   ip           = best-effort client IP (cf-connecting-ip header)
//
// `target_type` distinguishes per-tool calls (`tools/call`) from generic RPC
// like `tools/list` so observability dashboards can split them.
//
// Failures are swallowed (console.error) — an audit failure must not block the
// MCP response, mirroring `appendAudit`'s fire-and-forget contract.

import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/control-plane/schema";
import type { BearerOk } from "./oauth-bearer";
import type { Env } from "../types";

export interface McpAuditRow {
  jti: string;
  user_id: string;
  client_id: string;
  scopes: string[];
  http_status: number;
  duration_ms: number;
  /** Extracted from the JSON-RPC body when the request is a parsable POST. */
  mcp_method: string | null;
  /** When `mcp_method === "tools/call"`, the called tool name. */
  tool_name: string | null;
  source_ip: string | null;
}

/**
 * Best-effort extract of the JSON-RPC method (and tool name when relevant)
 * from a request body. Returns nulls when the body isn't a parseable
 * JSON-RPC envelope — the audit row falls back to "(unknown)" for target_id.
 *
 * Operates on a CLONE of the request body so the caller can still consume
 * the original body downstream.
 */
export async function extractMcpMethod(
  request: Request,
): Promise<{ method: string | null; tool: string | null }> {
  if (request.method !== "POST") return { method: null, tool: null };
  const ct = request.headers.get("content-type") ?? "";
  if (!ct.includes("json")) return { method: null, tool: null };
  try {
    const cloned = request.clone();
    const body = (await cloned.json()) as
      | { method?: string; params?: { name?: string } }
      | { method?: string; params?: { name?: string } }[];
    const first = Array.isArray(body) ? body[0] : body;
    if (!first || typeof first.method !== "string")
      return { method: null, tool: null };
    const tool =
      first.method === "tools/call" && typeof first.params?.name === "string"
        ? first.params.name
        : null;
    return { method: first.method, tool };
  } catch {
    return { method: null, tool: null };
  }
}

/** Fire-and-forget audit write. Logs and swallows on failure. */
export async function writeMcpAuditRow(
  env: Env,
  row: McpAuditRow,
): Promise<void> {
  try {
    const orm = drizzle(env.DB, { schema });
    const meta = {
      jti: row.jti,
      scopes: row.scopes,
      http_status: row.http_status,
      duration_ms: row.duration_ms,
      mcp_method: row.mcp_method,
    };
    await orm
      .insert(schema.audit_log)
      .values({
        at: Date.now(),
        actor_user_id: row.user_id,
        actor_token_id: row.client_id,
        action: "mcp.request",
        target_type: row.tool_name ? "mcp:tool" : "mcp:rpc",
        target_id: row.tool_name ?? row.mcp_method ?? "(unknown)",
        scope_group_id: null,
        meta_json: JSON.stringify(meta),
        ip: row.source_ip,
      })
      .run();
  } catch (e) {
    // Never block the MCP response on audit failures.
    console.error("mcp.audit.write_failed", (e as Error).message);
  }
}

/**
 * Build a complete audit row from a successful bearer validation + a finished
 * /mcp request/response cycle. The handler does the time bookkeeping; this
 * helper just packages the values.
 */
export function buildAuditRow(args: {
  bearer: BearerOk;
  request: Request;
  http_status: number;
  duration_ms: number;
  mcp_method: string | null;
  tool_name: string | null;
}): McpAuditRow {
  const { bearer, request, http_status, duration_ms, mcp_method, tool_name } =
    args;
  return {
    jti: bearer.jti,
    user_id: bearer.user_id,
    client_id: bearer.client_id,
    scopes: bearer.scopes,
    http_status,
    duration_ms,
    mcp_method,
    tool_name,
    source_ip:
      request.headers.get("cf-connecting-ip") ??
      request.headers.get("x-forwarded-for") ??
      null,
  };
}
