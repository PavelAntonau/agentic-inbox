// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { MiddlewareHandler } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, inArray } from "drizzle-orm";
import * as schema from "../db/control-plane/schema";
import type { Env } from "../types";
import type { JwtClaims } from "../lib/mock-access";
import { isServiceToken, jwtEmail, serviceTokenClientId } from "../lib/auth";
import type { AuthzContext } from "../db/control-plane/forGroup";

type Ctx = {
  Bindings: Env;
  Variables: { jwt?: JwtClaims; authzContext?: AuthzContext };
};

/**
 * Per-request middleware that resolves (user_id, role, group_ids,
 * authorized_mailbox_ids) from D1 and packs them into c.var.authzContext.
 *
 * Branches once on isServiceToken(jwt):
 *   - human path: lookup users by email; load their group memberships and
 *     authorized mailboxes (own private + shared via groups).
 *   - service-token path: lookup agent_tokens by cf_client_id; resolve to
 *     the issued_to_user; load that user's group memberships scoped to the
 *     token's mailbox.
 *
 * If the JWT is missing entirely (legacy dev-bypass path), authzContext is
 * left unset; downstream handlers MUST guard against it.
 */
export function authzContext(): MiddlewareHandler<Ctx> {
  return async (c, next) => {
    const jwt = c.var.jwt;
    if (!jwt) return next(); // legacy dev-bypass; downstream handles it

    const orm = drizzle(c.env.DB, { schema });

    if (isServiceToken(jwt)) {
      const clientId = serviceTokenClientId(jwt);
      if (!clientId)
        return c.text("Service-token JWT missing common_name", 403);

      const token = await orm
        .select()
        .from(schema.agent_tokens)
        .where(eq(schema.agent_tokens.cf_client_id, clientId))
        .get();
      if (!token) return c.text("Unknown service token", 403);
      if (token.revoked_at) return c.text("Token revoked", 403);

      // Resolve the user the token was issued to.
      const user = await orm
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, token.issued_to_user))
        .get();
      if (!user || user.status !== "active")
        return c.text("Token user inactive", 403);

      // Service tokens are scoped to ONE mailbox; group_ids is the set of
      // groups that mailbox belongs to.
      const links = await orm
        .select()
        .from(schema.mailbox_groups)
        .where(eq(schema.mailbox_groups.mailbox_id, token.mailbox_id))
        .all();

      c.set("authzContext", {
        user_id: user.id,
        role: user.role,
        group_ids: links.map((l) => l.group_id),
        authorized_mailbox_ids: [token.mailbox_id],
        agent_token_id: token.id,
      });
      return next();
    }

    // Human path
    const email = jwtEmail(jwt);
    if (!email) return c.text("JWT missing email", 403);

    const user = await orm
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .get();
    if (!user || user.status !== "active") {
      // First-login promotion path runs in workers/lib/bootstrap-owner.ts;
      // this middleware does NOT auto-create. The bootstrap helper is wired
      // separately by Phase 3 integration on the path it's relevant to.
      return c.text(
        "User not found or inactive — first-login flow required",
        403,
      );
    }

    const memberships = await orm
      .select({ group_id: schema.group_members.group_id })
      .from(schema.group_members)
      .where(eq(schema.group_members.user_id, user.id))
      .all();
    const group_ids = memberships.map((m) => m.group_id);

    // Authorized mailboxes = mailboxes I own + mailboxes shared via my groups.
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

    const authorized_mailbox_ids = Array.from(
      new Set([
        ...ownMailboxes.map((m) => m.id),
        ...groupMailboxes.map((m) => m.mailbox_id),
      ]),
    );

    c.set("authzContext", {
      user_id: user.id,
      role: user.role,
      group_ids,
      authorized_mailbox_ids,
    });
    return next();
  };
}
