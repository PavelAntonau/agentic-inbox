// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// T2.2 (mcp-oauth) — Audit-log writer for /mcp bearer-authenticated requests.
//
// Phase C3 / TASK-C3.1 — Migrated to the unified `writeAudit` helper in
// `workers/lib/audit-log.ts`. This module is now a thin shim that:
//   • extracts the JSON-RPC method/tool from the request body (clone-only),
//   • packages a `BearerOk` + http_status + duration_ms into an `McpAuditRow`,
//   • forwards to `writeAudit` which writes the D1 row, applies size caps,
//     uses `cf-connecting-ip` only for the source IP (no x-forwarded-for —
//     audit P2-3), and wraps the insert in its own try/catch.
//
// Schema (single chokepoint at `audit_log`):
//   action       = "mcp.request"
//   actor_user_id= bearer.user_id
//   actor_token_id = bearer.client_id  (OAuth client_id for JWTs; pat:<id> for PATs)
//   target_type  = "mcp:tool" when a tool was called; "mcp:rpc" otherwise
//   target_id    = tool name OR mcp_method (truncated at 200 chars)
//   meta_json    = { jti, scopes, http_status, duration_ms, mcp_method }
//                  (truncated at 8 KB by writeAudit)
//   ip           = cf-connecting-ip ONLY (audit P2-3)

import { writeAudit, clientIp } from "../lib/audit-log";
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

/**
 * Fire-and-forget audit write — delegates to the unified `writeAudit` helper
 * which carries the internal try/catch contract. Phase C3 / TASK-C3.1.
 */
export async function writeMcpAuditRow(
  env: Env,
  row: McpAuditRow,
): Promise<void> {
  await writeAudit(env.DB, {
    action: "mcp.request",
    target: {
      kind: row.tool_name ? "mcp:tool" : "mcp:rpc",
      id: row.tool_name ?? row.mcp_method ?? "(unknown)",
    },
    actor_user_id: row.user_id,
    actor_token_id: row.client_id,
    meta: {
      jti: row.jti,
      scopes: row.scopes,
      http_status: row.http_status,
      duration_ms: row.duration_ms,
      mcp_method: row.mcp_method,
    },
    ip: row.source_ip,
    mcp_method: row.mcp_method,
    tool_name: row.tool_name,
  });
}

/**
 * Build a complete audit row from a successful bearer validation + a finished
 * /mcp request/response cycle. The handler does the time bookkeeping; this
 * helper just packages the values.
 *
 * Phase C3 / TASK-C3.1: source IP comes from `cf-connecting-ip` only — the
 * previous fallback to `x-forwarded-for` is dropped (audit P2-3 — XFF is
 * spoofable at the public edge, cf-connecting-ip is set by Cloudflare and
 * cannot be tampered with by the client).
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
    source_ip: clientIp(request),
  };
}
