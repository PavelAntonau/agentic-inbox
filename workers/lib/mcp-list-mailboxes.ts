// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// T3.6 — short-circuit handler for list_mailboxes on /mcp.
//
// Closes audit P0-4 (security audit 2026-05-06): the EmailMCP wrapper at
// workers/mcp/index.ts:117 calls toolListMailboxes(env) WITHOUT
// authzContext. workers/lib/email-helpers.ts:107 treats the absent-context
// path as a "trusted internal caller" and returns the entire workspace.
// On the bearer-authenticated /mcp surface that becomes a workspace-wide
// enumeration leak (state file: PAT-as-alice → 13 mailboxes returned).
//
// Fix: the dispatch layer (workers/app.ts:dispatchMcpRequest) detects
// `tool === "list_mailboxes"` and calls `serveListMailboxes` here
// instead of forwarding to the DO. We build an authzContext from
// bearer.user_id (mirroring buildHumanAuthzContext) and narrow it by
// any PAT mailbox_id constraint, then run toolListMailboxes through
// the normal D1+R2 union path. The DO is bypassed entirely for this
// tool — there is no DO state to interact with.

import { drizzle } from "drizzle-orm/d1";
import { eq, inArray } from "drizzle-orm";
import * as schema from "../db/control-plane/schema";
import { toolListMailboxes } from "./tools";
import type { AuthzContext } from "../db/control-plane/forGroup";
import type { Env } from "../types";

/**
 * Build an AuthzContext for an /mcp bearer principal.
 *
 * Mirrors workers/middleware/authz-context.ts:buildHumanAuthzContext
 * (which is Hono-context-coupled via the consent-side bootstrapDb path);
 * this copy is dependency-free so the bearer surface can call it without
 * dragging in middleware machinery.
 *
 * Returns null when the user does not exist or is not active. The bearer
 * middleware has already confirmed the underlying token row references a
 * valid user; an inactive-user case here means the user was disabled
 * AFTER the token was minted but BEFORE the call. Treat as zero-mailbox.
 *
 * `patMailboxId` (when supplied) narrows authorized_mailbox_ids to the
 * intersection {[patMailboxId]} ∩ user-authorized-set. The intersection
 * is critical: a PAT cannot grant access to a mailbox the user does not
 * already own (e.g. a stale PAT minted before the user lost ACL).
 */
export async function buildAuthzContextFromUserId(
  env: Env,
  userId: string,
  patMailboxId: string | null = null,
): Promise<AuthzContext | null> {
  if (!env.DB) return null;
  const orm = drizzle(env.DB, { schema });

  const user = await orm
    .select({
      id: schema.users.id,
      role: schema.users.role,
      status: schema.users.status,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .get();
  if (!user || user.status !== "active") return null;

  const memberships = await orm
    .select({ group_id: schema.group_members.group_id })
    .from(schema.group_members)
    .where(eq(schema.group_members.user_id, user.id))
    .all();
  const group_ids = memberships.map((m) => m.group_id);

  const ownMailboxes = await orm
    .select({ id: schema.mailboxes.id })
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.owner_user_id, user.id))
    .all();
  const groupMailboxes =
    group_ids.length > 0
      ? await orm
          .select({ mailbox_id: schema.mailbox_groups.mailbox_id })
          .from(schema.mailbox_groups)
          .where(inArray(schema.mailbox_groups.group_id, group_ids))
          .all()
      : [];

  let authorized_mailbox_ids = Array.from(
    new Set([
      ...ownMailboxes.map((m) => m.id),
      ...groupMailboxes.map((m) => m.mailbox_id),
    ]),
  );

  // PAT mailbox_id constraint = intersection narrowing.
  if (patMailboxId !== null) {
    authorized_mailbox_ids = authorized_mailbox_ids.filter(
      (id) => id === patMailboxId,
    );
  }

  return {
    user_id: user.id,
    role: user.role as AuthzContext["role"],
    group_ids,
    authorized_mailbox_ids,
  };
}

/**
 * Construct the JSON-RPC envelope the McpAgent would normally produce for
 * a tools/call result. Mirrors `mcpText(result)` in workers/mcp/index.ts.
 */
function mcpListMailboxesEnvelope(
  rpcId: string | number | null,
  payload: unknown,
): unknown {
  return {
    jsonrpc: "2.0",
    id: rpcId,
    result: {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    },
  };
}

/**
 * Serve a list_mailboxes tools/call response WITHOUT going through the DO.
 *
 * Returns a Response with `application/json`. When buildAuthzContextFromUserId
 * returns null (user inactive / DB missing), we synthesise an empty
 * authzContext so listMailboxes hits the "authenticated but no authorized
 * mailboxes → return empty" branch rather than the trusted-internal "return
 * everything" branch. This is the load-bearing posture: if anything goes
 * wrong looking up the user, return [], NEVER the full workspace.
 */
export async function serveListMailboxes(
  env: Env,
  bearerUserId: string,
  patMailboxId: string | null,
  rpcId: string | number | null,
): Promise<Response> {
  const authzContext = (await buildAuthzContextFromUserId(
    env,
    bearerUserId,
    patMailboxId,
  )) ?? {
    user_id: bearerUserId,
    role: "user" as const,
    group_ids: [],
    authorized_mailbox_ids: [],
  };
  const result = await toolListMailboxes(env, authzContext);
  const body = JSON.stringify(mcpListMailboxesEnvelope(rpcId, result));
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
