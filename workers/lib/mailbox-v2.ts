// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase C1 / B-01 + B-02 — V2 mailbox-narrow gate.
//
// The V2 mailbox surface (`/api/mailboxes/:mailboxId/*`) hosts three routers:
//   • `routes/threads.ts`         — thread read + tip-message-write CAS
//   • `routes/inbox-policies.ts`  — external/internal inbound policy CRUD
//   • `routes/mailboxes.ts`       — D1-backed mailbox CRUD + share/transfer
//
// Each router has a `router.use("*", ...)` guard that requires an
// authzContext but does NOT narrow to `authorized_mailbox_ids`. Phase B's
// walkthrough caught the gap: any authenticated user could read or write
// any other mailbox via these surfaces (B-01 = thread GET, B-02 = thread
// tip-message POST, B-04 sibling = bare PUT/DELETE on the bare V2 path).
//
// This middleware is the V2 analogue of `workers/lib/mailbox.ts:requireMailbox`
// (V1's audit-P0-5 fix), narrowed for V2's needs:
//   • Resolves `:mailboxId` against D1 by UUID OR address (case-insensitive),
//     mirroring V1's resolution order. R2-only mailboxes are not part of
//     the V2 surface — they're legacy and outside the V2 routers' scope.
//   • Requires the caller's `authorized_mailbox_ids` to include the
//     resolved row id, OR the role to be a global one (`global_owner` /
//     `global_admin`). 403 otherwise, 404 when the mailbox doesn't exist.
//   • Stashes the resolved row's `id` and `address` on the context so
//     downstream routes can use them without re-resolving.
//   • Skips entirely when the segment is a known V2 RESERVED root word
//     (e.g. `tree`) — those resolve to parameterless sub-resources on
//     `mailboxesRouter`. Reserved words are NEVER a valid mailbox id and
//     never a valid mailbox address (no `@` sign), so this gate adds no
//     ambiguity.
//
// Auth absent (`authzContext === undefined`) → 401. The same "fail-closed
// when authzContext is missing" posture V1 takes (audit P0-5), to defend
// against any future code path that mounts these routers without an
// upstream auth middleware.

import { createMiddleware } from "hono/factory";
import { drizzle } from "drizzle-orm/d1";
import { or, eq, sql } from "drizzle-orm";
import * as schema from "../db/control-plane/schema";
import type { AuthzContext } from "../db/control-plane/forGroup";
import type { Env } from "../types";

export type MailboxV2Context = {
  Bindings: Env;
  Variables: {
    /** Set upstream by `workers/middleware/authz-context.ts`. Required. */
    authzContext?: AuthzContext;
    /** Set after resolution — D1 mailbox UUID. */
    resolvedMailboxId?: string;
    /** Set after resolution — canonical email address. */
    resolvedMailboxAddress?: string;
  };
};

/**
 * Segments under `/api/mailboxes/:segment` that are NOT mailbox ids — they
 * resolve to parameterless sub-resources on `mailboxesRouter` (currently
 * just `tree`). The middleware below skips authz narrowing for these so the
 * inner router sees them unchanged. Any future addition (e.g. `bulk`,
 * `search`) MUST be added here AND audited for its own authz posture inside
 * the corresponding router.
 */
export const V2_RESERVED_SEGMENTS: ReadonlySet<string> = new Set(["tree"]);

function isGlobal(role: AuthzContext["role"]): boolean {
  return role === "global_owner" || role === "global_admin";
}

export const requireMailboxV2 = createMiddleware<MailboxV2Context>(
  async (c, next) => {
    const rawId = c.req.param("mailboxId");
    if (!rawId) return c.json({ error: "Mailbox ID required" }, 400);

    // Reserved-segment fast path: e.g. `/api/mailboxes/tree` is not a
    // mailbox-targeted call. Pass through to the inner router whose own
    // `router.use("*", ...)` guard handles authentication.
    if (V2_RESERVED_SEGMENTS.has(rawId)) return next();

    const ctx = c.var.authzContext;
    if (!ctx) return c.json({ error: "Unauthorized" }, 401);

    const mailboxId = decodeURIComponent(rawId);

    if (!c.env.DB) {
      // V2 surface requires D1; fail-CLOSED rather than degrade silently.
      return c.json({ error: "Mailbox lookup unavailable" }, 503);
    }

    const orm = drizzle(c.env.DB, { schema });
    const row = await orm
      .select({
        id: schema.mailboxes.id,
        address: schema.mailboxes.address,
      })
      .from(schema.mailboxes)
      .where(
        or(
          eq(schema.mailboxes.id, mailboxId),
          eq(sql`lower(${schema.mailboxes.address})`, mailboxId.toLowerCase()),
        ),
      )
      .get();

    if (!row) return c.json({ error: "Not found" }, 404);

    if (!isGlobal(ctx.role) && !ctx.authorized_mailbox_ids.includes(row.id)) {
      return c.json({ error: "Forbidden" }, 403);
    }

    c.set("resolvedMailboxId", row.id);
    c.set("resolvedMailboxAddress", row.address);
    return next();
  },
);
