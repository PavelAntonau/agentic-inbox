// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// T3.6 — per-tool scope map + PAT IP/mailbox constraints + JSON-RPC argument
// extraction. Pure helpers consumed by /mcp dispatch in workers/app.ts.
//
// Closes audit findings P0-2, P0-3, P0-4 (security audit 2026-05-06):
//   - P0-2: every MCP tool maps to exactly one required scope; the dispatch
//     layer asserts membership before forwarding to the McpAgent DO.
//   - P0-3: PAT mailbox_id + ip_allowlist columns surfaced by the bearer
//     middleware are now enforced here. mailbox_id check runs against the
//     resolved canonical id of the tools/call mailboxId argument.
//   - P0-4: list_mailboxes is short-circuited at dispatch (see
//     mcp-list-mailboxes.ts) so it never reaches the unauthzContext'd DO
//     wrapper. MAILBOX_BOUND_TOOLS deliberately excludes list_mailboxes.

import { drizzle } from "drizzle-orm/d1";
import { eq, sql } from "drizzle-orm";
import * as schema from "../db/control-plane/schema";
import { RESOURCE_METADATA_URL } from "../middleware/oauth-bearer";
import type { Env } from "../types";

/**
 * Required scope for each MCP tool. Read tools require `mcp:mailbox:read`,
 * write tools require `mcp:mailbox:write`. A token holding both can call
 * any tool.
 *
 * Tools NOT present here are treated as "unknown" by `getRequiredScope` —
 * the dispatch layer falls through to the McpAgent which returns the SDK's
 * native "tool not found" error. We deliberately do NOT default-allow on
 * unknown tools (would be a defense gap if a new tool ships without an
 * entry here) — the missing-entry case matches the missing-tool case.
 */
export const TOOL_REQUIRED_SCOPES: Readonly<Record<string, string>> = {
  // Read tools
  list_mailboxes: "mcp:mailbox:read",
  list_emails: "mcp:mailbox:read",
  get_email: "mcp:mailbox:read",
  get_thread: "mcp:mailbox:read",
  search_emails: "mcp:mailbox:read",
  // Write tools
  send_email: "mcp:mailbox:write",
  send_reply: "mcp:mailbox:write",
  delete_email: "mcp:mailbox:write",
  move_email: "mcp:mailbox:write",
  mark_email_read: "mcp:mailbox:write",
  create_draft: "mcp:mailbox:write",
  update_draft: "mcp:mailbox:write",
  draft_reply: "mcp:mailbox:write",
};

export function getRequiredScope(toolName: string): string | null {
  return Object.prototype.hasOwnProperty.call(TOOL_REQUIRED_SCOPES, toolName)
    ? TOOL_REQUIRED_SCOPES[toolName]
    : null;
}

/**
 * Tools that take a `mailboxId` argument and so participate in the
 * PAT mailbox_id-constraint check. `list_mailboxes` is intentionally
 * absent — it has no per-mailbox argument and is enforced via the
 * authzContext narrowing path.
 */
export const MAILBOX_BOUND_TOOLS: ReadonlySet<string> = new Set([
  "list_emails",
  "get_email",
  "get_thread",
  "search_emails",
  "send_email",
  "send_reply",
  "delete_email",
  "move_email",
  "mark_email_read",
  "create_draft",
  "update_draft",
  "draft_reply",
]);

export interface ToolCall {
  /** Tool name when method === "tools/call"; null otherwise. */
  name: string | null;
  /** Object map of tool arguments; null when malformed or absent. */
  arguments: Record<string, unknown> | null;
  /** JSON-RPC `id` echoed back in short-circuit responses. */
  id: string | number | null;
}

/**
 * Decode a tools/call JSON-RPC envelope. Returns nulls for non-tools/call
 * methods or non-parseable bodies.
 *
 * Operates on a CLONE of the request so the original body remains
 * consumable downstream (the McpAgent re-reads it).
 */
export async function extractToolCall(request: Request): Promise<ToolCall> {
  if (request.method !== "POST") {
    return { name: null, arguments: null, id: null };
  }
  const ct = request.headers.get("content-type") ?? "";
  if (!ct.includes("json")) return { name: null, arguments: null, id: null };
  try {
    const cloned = request.clone();
    const body = (await cloned.json()) as
      | {
          method?: string;
          id?: string | number | null;
          params?: { name?: string; arguments?: Record<string, unknown> };
        }
      | {
          method?: string;
          id?: string | number | null;
          params?: { name?: string; arguments?: Record<string, unknown> };
        }[];
    const first = Array.isArray(body) ? body[0] : body;
    if (!first || first.method !== "tools/call") {
      return { name: null, arguments: null, id: null };
    }
    return {
      name: typeof first.params?.name === "string" ? first.params.name : null,
      arguments:
        first.params?.arguments &&
        typeof first.params.arguments === "object" &&
        !Array.isArray(first.params.arguments)
          ? first.params.arguments
          : null,
      id: first.id ?? null,
    };
  } catch {
    return { name: null, arguments: null, id: null };
  }
}

/**
 * Resolve a user-supplied mailboxId argument (UUID or address) to the
 * canonical D1 mailbox row id. Returns null when the mailbox is not in D1
 * (R2-only legacy mailboxes can't be PAT-constrained — the constraint
 * column is FK to mailboxes.id, structurally outside the constraint
 * surface).
 *
 * Address lookup uses `lower(address)` to match the
 * `mailboxes_address_nocase` unique index.
 */
export async function resolveMailboxToId(
  env: Env,
  mailboxArg: string,
): Promise<string | null> {
  if (!env.DB || !mailboxArg) return null;
  const orm = drizzle(env.DB, { schema });
  // UUID lookup first
  const byId = await orm
    .select({ id: schema.mailboxes.id })
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.id, mailboxArg))
    .get();
  if (byId) return byId.id;
  // Address lookup (case-insensitive)
  const byAddress = await orm
    .select({ id: schema.mailboxes.id })
    .from(schema.mailboxes)
    .where(
      eq(sql`lower(${schema.mailboxes.address})`, mailboxArg.toLowerCase()),
    )
    .get();
  return byAddress?.id ?? null;
}

/**
 * Test whether `ip` is matched by any allowlist entry.
 *
 * Each entry can be a literal IP (exact-match) or a CIDR (`a.b.c.d/n` or
 * `xxxx::/n`). Returns false when `ip` is null/empty or allowlist is empty.
 *
 * **Semantics — Phase C3 / C3.20 (C-04) update:**
 *
 *   - `allowlist === null` or `undefined` → **no IP gate configured**.
 *     The dispatch caller (workers/app.ts) checks `bearer.ip_allowlist`
 *     explicitly for nullishness BEFORE invoking this predicate, and
 *     skips the check entirely. This function still returns false on
 *     null input as a defense-in-depth fallback.
 *
 *   - `allowlist === []` → **empty allowlist; fail-CLOSED**. Previously
 *     this was treated as "no restriction" (a documented footgun); the
 *     dispatch caller now treats `length > 0` AND null-check together
 *     as "gate is active", and an empty array means *no IPs match the
 *     gate, so deny the request*. This predicate's contract reflects
 *     that: empty list returns false, dispatch caller refuses access.
 *
 *   - `allowlist === [...]` with entries → match each entry; return
 *     true on first hit. Each entry is either an exact IP or a CIDR.
 */
export function isIpInAllowlist(
  ip: string | null,
  allowlist: readonly string[] | null | undefined,
): boolean {
  if (!ip || !allowlist || allowlist.length === 0) return false;
  for (const entry of allowlist) {
    if (entry.includes("/")) {
      if (cidrMatch(ip, entry)) return true;
    } else if (entry === ip) {
      return true;
    }
  }
  return false;
}

/**
 * Phase C3 / C3.20 (C-04): canonical predicate for "is the ip_allowlist
 * column actively gating this request?".
 *
 *   - null/undefined → no gate (allow)
 *   - [] (empty)     → gate is configured but matches nothing → deny
 *   - non-empty      → gate is active → caller must `isIpInAllowlist`
 *
 * Use this at every dispatch site that consumes a PAT/agent-token's
 * `ip_allowlist` so the empty-array case can never accidentally fall
 * through as "no gate". Returns true when the caller MUST run an
 * `isIpInAllowlist` check (and reject on miss).
 */
export function ipAllowlistIsActive(
  allowlist: readonly string[] | null | undefined,
): boolean {
  return Array.isArray(allowlist);
}

function cidrMatch(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf("/");
  if (slash < 0) return false;
  const block = cidr.slice(0, slash);
  const mask = parseInt(cidr.slice(slash + 1), 10);
  if (!block || !Number.isFinite(mask)) return false;

  // IPv4
  if (ip.includes(".") && block.includes(".")) {
    if (mask < 0 || mask > 32) return false;
    const ipNum = ipv4ToNum(ip);
    const blockNum = ipv4ToNum(block);
    if (ipNum === null || blockNum === null) return false;
    if (mask === 0) return true;
    const shift = 32 - mask;
    return ipNum >>> shift === blockNum >>> shift;
  }

  // IPv6
  if (ip.includes(":") && block.includes(":")) {
    if (mask < 0 || mask > 128) return false;
    const ipBytes = ipv6ToBytes(ip);
    const blockBytes = ipv6ToBytes(block);
    if (!ipBytes || !blockBytes) return false;
    let bitsLeft = mask;
    for (let i = 0; i < 16; i++) {
      if (bitsLeft <= 0) return true;
      if (bitsLeft >= 8) {
        if (ipBytes[i] !== blockBytes[i]) return false;
        bitsLeft -= 8;
      } else {
        const shift = 8 - bitsLeft;
        return ipBytes[i] >>> shift === blockBytes[i] >>> shift;
      }
    }
    return true;
  }

  return false;
}

function ipv4ToNum(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = parseInt(p, 10);
    if (!Number.isFinite(v) || v < 0 || v > 255 || String(v) !== p) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

function ipv6ToBytes(ip: string): number[] | null {
  if (!ip.includes(":")) return null;
  const parts = ip.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  if (head.length + tail.length > 8) return null;
  const groups =
    parts.length === 2
      ? [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail]
      : head;
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const v = parseInt(g, 16);
    if (!Number.isFinite(v) || v < 0 || v > 0xffff) return null;
    bytes.push((v >> 8) & 0xff, v & 0xff);
  }
  return bytes;
}

/**
 * T3.6-specific reject reasons surfaced in the dispatch-layer 403 body.
 * Kept distinct from `BearerRejectReason` (oauth-bearer.ts) so the bearer
 * middleware tests stay stable; both reach the same RFC-6750
 * `insufficient_scope` error class.
 */
export type T36RejectReason =
  | "pat-ip-not-allowed"
  | "tool-scope-required"
  | "pat-mailbox-arg-required"
  | "pat-mailbox-mismatch"
  // Phase C1 / C-01 — generic mailbox-narrowing for OAuth JWT (and PAT
  // without mailbox_id binding). `tool-mailbox-arg-required` fires when a
  // MAILBOX_BOUND_TOOLS call omits its `mailboxId` argument; the bearer
  // is otherwise valid. `mailbox-not-authorized` fires when the resolved
  // mailbox is outside the caller's `authorized_mailbox_ids` (intersected
  // with PAT mailbox_id when set).
  | "tool-mailbox-arg-required"
  | "mailbox-not-authorized";

/**
 * Build a 403 `insufficient_scope` response with the same `WWW-Authenticate`
 * shape `bearerChallengeResponse` produces, plus a structured JSON body
 * carrying the T3.6-specific reason and any extra signal (e.g. the missing
 * scope name) for client-side error handling.
 */
export function insufficientScopeResponse(
  reason: T36RejectReason,
  extra: Record<string, unknown> = {},
): Response {
  const params = [
    'realm="mcp"',
    `resource_metadata="${RESOURCE_METADATA_URL}"`,
    `error="insufficient_scope"`,
    `error_description="${reason}"`,
  ];
  return new Response(
    JSON.stringify({ error: "insufficient_scope", reason, ...extra }),
    {
      status: 403,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer ${params.join(", ")}`,
        "Cache-Control": "no-store",
      },
    },
  );
}
