// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// workers/routes/sessions.ts — session management endpoints (Phase 1).
//
// Mounts at /api/users/me/sessions (see app.ts).
//
// Endpoints:
//   GET    /api/users/me/sessions          — list caller's sessions (marks current)
//   DELETE /api/users/me/sessions/:id      — revoke a specific session
//   POST   /api/users/me/sessions/revoke-others — revoke all except current

import { Hono } from "hono";
import { eq, and, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/control-plane/schema";
import type { AuthzContext } from "../db/control-plane/forGroup";
import type { Env } from "../types";

type AppVariables = {
  authzContext?: AuthzContext;
};

const router = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// ---------------------------------------------------------------------------
// Auth guard — all session routes require an authenticated user
// ---------------------------------------------------------------------------

router.use("*", async (c, next) => {
  const ctx = c.var.authzContext;
  if (!ctx) return c.json({ error: "Unauthorized" }, 401);
  return next();
});

// ---------------------------------------------------------------------------
// GET /api/users/me/sessions — list sessions
// ---------------------------------------------------------------------------
//
// Returns all active (non-expired) sessions for the current user.
// Each row includes a `is_current` flag: true when the row id matches the
// session_id set on authzContext by the better-auth middleware path.
//
// Expired sessions are excluded from the listing (they'll be cleaned up by
// better-auth's own housekeeping). The client is responsible for rendering
// a friendly UA name from the `user_agent` string.

router.get("/", async (c) => {
  const ctx = c.var.authzContext!;
  const orm = drizzle(c.env.DB, { schema });
  const now = Date.now();

  const rows = await orm
    .select({
      id: schema.session.id,
      createdAt: schema.session.createdAt,
      updatedAt: schema.session.updatedAt,
      expiresAt: schema.session.expiresAt,
      ipAddress: schema.session.ipAddress,
      userAgent: schema.session.userAgent,
    })
    .from(schema.session)
    .where(
      and(
        eq(schema.session.userId, ctx.user_id),
        // Only include non-expired rows. better-auth stores expiresAt as
        // epoch milliseconds (integer) in the D1 column.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        // We use a raw comparison — drizzle's `gt` works here.
      ),
    )
    .all();

  // Filter out expired sessions in application code (avoids a raw sql() call
  // on the integer timestamp column which stores epoch-ms).
  const active = rows.filter((r) => {
    const exp =
      typeof r.expiresAt === "number" ? r.expiresAt : Number(r.expiresAt);
    return exp > now;
  });

  const currentSessionId = ctx.session_id ?? null;

  return c.json(
    active.map((r) => ({
      id: r.id,
      is_current: r.id === currentSessionId,
      ip_address: r.ipAddress ?? null,
      user_agent: r.userAgent ?? null,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
      expires_at: r.expiresAt,
    })),
  );
});

// ---------------------------------------------------------------------------
// DELETE /api/users/me/sessions/:id — revoke a session
// ---------------------------------------------------------------------------
//
// Deletes the session row. 404 if the row doesn't exist or belongs to a
// different user. 204 on success.
//
// Revoking the current session is allowed — the client should redirect to
// /login after receiving 204.

router.delete("/:id", async (c) => {
  const ctx = c.var.authzContext!;
  const sessionId = c.req.param("id");
  const orm = drizzle(c.env.DB, { schema });

  const row = await orm
    .select({ id: schema.session.id, userId: schema.session.userId })
    .from(schema.session)
    .where(
      and(
        eq(schema.session.id, sessionId),
        eq(schema.session.userId, ctx.user_id),
      ),
    )
    .get();

  if (!row) {
    return c.json({ error: "Session not found" }, 404);
  }

  await orm
    .delete(schema.session)
    .where(eq(schema.session.id, sessionId))
    .run();

  return new Response(null, { status: 204 });
});

// ---------------------------------------------------------------------------
// POST /api/users/me/sessions/revoke-others — revoke all other sessions
// ---------------------------------------------------------------------------
//
// Deletes all session rows for the current user EXCEPT the current session.
// If the caller authenticated via CF Access (session_id is null/undefined),
// all sessions are deleted. Returns 200 with a count of deleted rows.

router.post("/revoke-others", async (c) => {
  const ctx = c.var.authzContext!;
  const orm = drizzle(c.env.DB, { schema });

  const currentSessionId = ctx.session_id;

  if (currentSessionId) {
    // Delete all sessions for this user except the current one
    await orm
      .delete(schema.session)
      .where(
        and(
          eq(schema.session.userId, ctx.user_id),
          ne(schema.session.id, currentSessionId),
        ),
      )
      .run();
  } else {
    // No current session id (CF Access path) — delete all sessions
    await orm
      .delete(schema.session)
      .where(eq(schema.session.userId, ctx.user_id))
      .run();
  }

  return c.json({ ok: true });
});

export default router;
