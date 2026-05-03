// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// workers/routes/observability.ts — admin observability panel endpoints.
//
// Mounts at /api/admin/obs (see app.ts). All routes require global_owner or global_admin.
//
// Endpoints:
//   GET /api/admin/obs/active-sessions — AgentTokenLimiter + RevocationCache snapshots
//   GET /api/admin/obs/message-rate   — aggregate audit_log email action counts
//   GET /api/admin/obs/last-login     — users.last_login_at per user
//   GET /api/admin/obs/audit          — paginated audit_log with action/actor/target/group filters

import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { isNull, eq, desc, gte, like, and, sql } from "drizzle-orm";
import * as schema from "../db/control-plane/schema";
import type { AuthzContext } from "../db/control-plane/forGroup";
import type { Env } from "../types";

type AppVariables = {
  authzContext?: AuthzContext;
};

const router = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// ---------------------------------------------------------------------------
// Auth guard — all obs routes require global admin
// ---------------------------------------------------------------------------

router.use("*", async (c, next) => {
  const ctx = c.var.authzContext;
  if (!ctx) return c.json({ error: "Unauthorized" }, 401);
  if (ctx.role !== "global_owner" && ctx.role !== "global_admin") {
    return c.json({ error: "Forbidden — global admin required" }, 403);
  }
  return next();
});

// ---------------------------------------------------------------------------
// Simple 10-second in-memory cache (settings-cache.ts pattern)
// ---------------------------------------------------------------------------

interface ObsSnapshot {
  active_sessions: ActiveSessionsPayload;
  ts: number;
}

type ActiveSessionsPayload = {
  revoked_token_count: number;
  revoked_cf_client_ids: string[];
  active_token_entries: {
    token_id: string;
    instance_count: number;
    instances: {
      instance_id: string;
      fingerprint: string;
      last_seen_at: number;
    }[];
  }[];
};

let _obsCache: ObsSnapshot | null = null;
const OBS_TTL_MS = 10_000;

// ---------------------------------------------------------------------------
// GET /api/admin/obs/active-sessions — DO snapshot payloads
// ---------------------------------------------------------------------------

router.get("/active-sessions", async (c) => {
  const now = Date.now();

  if (_obsCache && now - _obsCache.ts < OBS_TTL_MS) {
    return c.json(_obsCache.active_sessions);
  }

  const db = drizzle(c.env.DB, { schema });

  // Get all tokens (with issued_to_user) so we can query their limiters
  // AND aggregate per-user RevocationCache snapshots (D-V2U-7).
  const tokens = await db
    .select({
      id: schema.agent_tokens.id,
      cf_client_id: schema.agent_tokens.cf_client_id,
      issued_to_user: schema.agent_tokens.issued_to_user,
    })
    .from(schema.agent_tokens)
    .where(isNull(schema.agent_tokens.revoked_at))
    .all();

  // RevocationCache snapshot — one DO per user (D-V2U-7).
  // Multi-tenancy ceiling: per-user, not per-account; future accounts table
  // will let us promote to account_id-keyed DOs. Cross-user leakage is
  // eliminated by keying — the global_owner who reads this aggregate sees
  // every user's revoked client IDs deliberately.
  const distinctUsers = Array.from(
    new Set(tokens.map((t) => t.issued_to_user)),
  );
  let revoked_cf_client_ids: string[] = [];
  await Promise.all(
    distinctUsers.map(async (userId) => {
      const cacheId = c.env.REVOCATION_CACHE.idFromName(userId);
      const cacheStub = c.env.REVOCATION_CACHE.get(cacheId);
      try {
        const res = await cacheStub.fetch(
          new Request("http://do/snapshot", { method: "GET" }),
        );
        const ids = (await res.json()) as string[];
        revoked_cf_client_ids.push(...ids);
      } catch {
        // Non-fatal — skip unreachable per-user DOs
      }
    }),
  );
  // Deduplicate in case a client_id somehow appears in multiple per-user DOs.
  revoked_cf_client_ids = Array.from(new Set(revoked_cf_client_ids));

  // AgentTokenLimiter snapshots (one DO per token)
  const active_token_entries: ActiveSessionsPayload["active_token_entries"] =
    [];
  await Promise.all(
    tokens.map(async (token) => {
      const limiterId = c.env.AGENT_TOKEN_LIMITER.idFromName(token.id);
      const limiterStub = c.env.AGENT_TOKEN_LIMITER.get(limiterId);
      try {
        const res = await limiterStub.fetch(
          new Request("http://do/snapshot", { method: "GET" }),
        );
        const instances = (await res.json()) as {
          instance_id: string;
          fingerprint: string;
          last_seen_at: number;
        }[];
        if (instances.length > 0) {
          active_token_entries.push({
            token_id: token.id,
            instance_count: instances.length,
            instances,
          });
        }
      } catch {
        // Skip unreachable limiter DOs
      }
    }),
  );

  const payload: ActiveSessionsPayload = {
    revoked_token_count: revoked_cf_client_ids.length,
    revoked_cf_client_ids,
    active_token_entries,
  };

  _obsCache = { active_sessions: payload, ts: now };
  return c.json(payload);
});

// ---------------------------------------------------------------------------
// GET /api/admin/obs/message-rate — email action counts over time windows
// ---------------------------------------------------------------------------

router.get("/message-rate", async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const now = Date.now();

  const windows = {
    last_24h: now - 24 * 60 * 60 * 1000,
    last_7d: now - 7 * 24 * 60 * 60 * 1000,
    last_30d: now - 30 * 24 * 60 * 60 * 1000,
  };

  async function countEmailActions(since: number): Promise<number> {
    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.audit_log)
      .where(
        and(
          gte(schema.audit_log.at, since),
          like(schema.audit_log.action, "email.%"),
        ),
      )
      .get();
    return Number(result?.count ?? 0);
  }

  const [count_24h, count_7d, count_30d] = await Promise.all([
    countEmailActions(windows.last_24h),
    countEmailActions(windows.last_7d),
    countEmailActions(windows.last_30d),
  ]);

  return c.json({
    windows: {
      last_24h: { since: windows.last_24h, count: count_24h },
      last_7d: { since: windows.last_7d, count: count_7d },
      last_30d: { since: windows.last_30d, count: count_30d },
    },
  });
});

// ---------------------------------------------------------------------------
// GET /api/admin/obs/last-login — users with last_login_at
// ---------------------------------------------------------------------------

router.get("/last-login", async (c) => {
  const db = drizzle(c.env.DB, { schema });

  const users = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      display_name: schema.users.display_name,
      role: schema.users.role,
      status: schema.users.status,
      last_login_at: schema.users.last_login_at,
    })
    .from(schema.users)
    .orderBy(desc(schema.users.last_login_at))
    .all();

  return c.json({ users });
});

// ---------------------------------------------------------------------------
// GET /api/admin/obs/audit — paginated audit log with filters
//
// Query params:
//   page     (default 1)
//   per_page (default 50, max 200)
//   action   filter: action LIKE '%<action>%'
//   actor    filter: actor_user_id = <actor>
//   target   filter: target_id = <target>
//   group    filter: scope_group_id = <group>
//   since    unix ms (default: 7 days ago)
//   until    unix ms (default: now)
// ---------------------------------------------------------------------------

router.get("/audit", async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const now = Date.now();
  const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

  const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10) || 1);
  const perPage = Math.min(
    200,
    Math.max(1, parseInt(c.req.query("per_page") ?? "50", 10) || 50),
  );
  const offset = (page - 1) * perPage;

  const since = c.req.query("since")
    ? parseInt(c.req.query("since")!, 10)
    : now - DEFAULT_WINDOW_MS;
  const until = c.req.query("until")
    ? parseInt(c.req.query("until")!, 10)
    : now;

  const actionFilter = c.req.query("action") ?? null;
  const actorFilter = c.req.query("actor") ?? null;
  const targetFilter = c.req.query("target") ?? null;
  const groupFilter = c.req.query("group") ?? null;

  // Build filter conditions
  const conditions = [
    gte(schema.audit_log.at, since),
    sql`${schema.audit_log.at} <= ${until}`,
  ];

  if (actionFilter) {
    conditions.push(like(schema.audit_log.action, `%${actionFilter}%`));
  }
  if (actorFilter) {
    conditions.push(eq(schema.audit_log.actor_user_id, actorFilter));
  }
  if (targetFilter) {
    conditions.push(eq(schema.audit_log.target_id, targetFilter));
  }
  if (groupFilter) {
    conditions.push(eq(schema.audit_log.scope_group_id, groupFilter));
  }

  const whereClause = and(...conditions);

  const [rows, countResult] = await Promise.all([
    db
      .select()
      .from(schema.audit_log)
      .where(whereClause)
      .orderBy(desc(schema.audit_log.at))
      .limit(perPage)
      .offset(offset)
      .all(),
    db
      .select({ count: sql<number>`count(*)` })
      .from(schema.audit_log)
      .where(whereClause)
      .get(),
  ]);

  const totalCount = Number(countResult?.count ?? 0);
  const totalPages = Math.ceil(totalCount / perPage);

  return c.json({
    rows,
    pagination: {
      page,
      per_page: perPage,
      total_count: totalCount,
      total_pages: totalPages,
    },
  });
});

export default router;
