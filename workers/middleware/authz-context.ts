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
import { bootstrapOwner } from "../lib/bootstrap-owner";
import { getSettings } from "../lib/settings-cache";
import { createAuth } from "../auth";

type Ctx = {
  Bindings: Env;
  Variables: { jwt?: JwtClaims; authzContext?: AuthzContext };
};

/**
 * Resolve the human-path authzContext fields (groups + mailboxes) for a
 * known-active user row. Shared by the better-auth session path and the CF
 * Access JWT path so the logic lives in one place.
 */
async function buildHumanAuthzContext(
  orm: ReturnType<typeof drizzle>,
  user: { id: string; role: string; status: string },
  extra?: { session_id?: string },
): Promise<AuthzContext> {
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

  const authorized_mailbox_ids = Array.from(
    new Set([
      ...ownMailboxes.map((m) => m.id),
      ...groupMailboxes.map((m) => m.mailbox_id),
    ]),
  );

  return {
    user_id: user.id,
    role: user.role as AuthzContext["role"],
    group_ids,
    authorized_mailbox_ids,
    ...(extra?.session_id ? { session_id: extra.session_id } : {}),
  };
}

export function authzContext(): MiddlewareHandler<Ctx> {
  return async (c, next) => {
    const orm = drizzle(c.env.DB, { schema });

    // ── Path 1: better-auth session cookie ──────────────────────────────────
    // Check for a valid better-auth session BEFORE the CF Access JWT path.
    // This allows the new auth surface to gate requests while CF Access remains
    // as a fallback (Phase 3 will remove CF Access entirely).
    try {
      const auth = createAuth(c.env);
      const baSession = await auth.api.getSession({
        headers: c.req.raw.headers,
      });
      if (baSession) {
        const user = await orm
          .select()
          .from(schema.users)
          .where(eq(schema.users.id, baSession.user.id))
          .get();
        if (user && user.status === "active") {
          const ctx = await buildHumanAuthzContext(orm, user, {
            session_id: baSession.session.id,
          });
          c.set("authzContext", ctx);
          return next();
        }
      }
    } catch {
      // better-auth unavailable or threw — fall through to CF Access path
    }

    const jwt = c.var.jwt;
    if (!jwt) return next(); // legacy dev-bypass; downstream handles it

    if (isServiceToken(jwt)) {
      const clientId = serviceTokenClientId(jwt);
      if (!clientId)
        return c.text("Service-token JWT missing common_name", 403);

      // Step 1: D1 lookup — reject if missing or revoked in DB
      const token = await orm
        .select()
        .from(schema.agent_tokens)
        .where(eq(schema.agent_tokens.cf_client_id, clientId))
        .get();
      if (!token) return c.text("Unknown service token", 401);
      if (token.revoked_at) return c.text("Token revoked", 401);

      // Step 2: RevocationCache hot-path check (faster than DB for in-flight revocations).
      // Keyed by issued_to_user so each user's revoked-set is isolated (D-V2U-7).
      // Multi-tenancy ceiling: this is per-user, not per-account; a future
      // accounts table will let us promote the key to account_id.
      try {
        const cacheId = c.env.REVOCATION_CACHE.idFromName(token.issued_to_user);
        const cacheStub = c.env.REVOCATION_CACHE.get(cacheId);
        const cacheRes = await cacheStub.fetch(
          new Request("http://do/is-revoked", {
            method: "POST",
            body: JSON.stringify({ cf_client_id: clientId }),
            headers: { "Content-Type": "application/json" },
          }),
        );
        if (cacheRes.ok) {
          const { revoked } = (await cacheRes.json()) as { revoked: boolean };
          if (revoked) return c.text("Token revoked", 401);
        }
      } catch {
        // RevocationCache unavailable — fall through to DB state (already checked above)
      }

      // Step 3: AgentTokenLimiter — enforce max_instances cap
      const fingerprint =
        c.req.header("x-agent-fingerprint") ??
        // Synthesize from IP + UA when header absent
        `${c.req.header("cf-connecting-ip") ?? "unknown"}:${c.req.header("user-agent") ?? ""}`;

      try {
        const settingsRows = await getSettings(c.env.DB);
        const idleSetting = settingsRows.find(
          (r) => r.key === "agent_token_idle_prune_minutes",
        );
        const idleMinutes = Number(idleSetting?.value ?? "60");
        const idlePruneMs = idleMinutes * 60_000;

        const limiterId = c.env.AGENT_TOKEN_LIMITER.idFromName(token.id);
        const limiterStub = c.env.AGENT_TOKEN_LIMITER.get(limiterId);
        const limiterRes = await limiterStub.fetch(
          new Request("http://do/register", {
            method: "POST",
            body: JSON.stringify({
              fingerprint,
              max_instances: token.max_instances,
              idle_prune_ms: idlePruneMs,
            }),
            headers: { "Content-Type": "application/json" },
          }),
        );
        if (limiterRes.ok) {
          const result = (await limiterRes.json()) as { accepted: boolean };
          if (!result.accepted) {
            return c.text(
              `Max instances (${token.max_instances}) reached for this token`,
              429,
            );
          }
        }
      } catch {
        // Limiter unavailable — allow through (fail-open for availability)
      }

      // Resolve the user the token was issued to.
      const user = await orm
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, token.issued_to_user))
        .get();
      if (!user || user.status !== "active")
        return c.text("Token user inactive", 403);

      // Service tokens are scoped to ONE mailbox; group_ids = []
      c.set("authzContext", {
        user_id: user.id,
        role: user.role,
        group_ids: [],
        authorized_mailbox_ids: [token.mailbox_id],
        agent_token_id: token.id,
      });
      return next();
    }

    // Human path
    const email = jwtEmail(jwt);
    if (!email) return c.text("JWT missing email", 403);

    let user = await orm
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .get();

    if (!user || user.status !== "active") {
      // First-login flow: if the email matches BOOTSTRAP_OWNER_EMAIL, promote
      // it to a global_owner row inside the same transaction and continue.
      // Any other email lands as 403 — admins must explicitly invite users
      // via the /admin/users API (V2.2).
      const promotedId = await bootstrapOwner(
        c.env.DB,
        c.env,
        email,
        Date.now(),
      );
      if (promotedId) {
        user = await orm
          .select()
          .from(schema.users)
          .where(eq(schema.users.id, promotedId))
          .get();
      }
      if (!user || user.status !== "active") {
        return c.text(
          "User not found or inactive — first-login flow required",
          403,
        );
      }
    }

    const ctx = await buildHumanAuthzContext(orm, user);
    c.set("authzContext", ctx);
    return next();
  };
}
