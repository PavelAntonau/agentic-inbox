// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * /__mock/* router — local testing harness surface.
 *
 * Mounted in workers/app.ts ONLY when MOCK_MODE=1. Production never sees it.
 * Provides:
 *   GET  /__mock/health          → readiness probe + mock-mode confirmation
 *   POST /__mock/reset           → clear D1 control-plane tables + outbox + OTP tee
 *   GET  /__mock/outbox          → list recent mock-email entries
 *   POST /__mock/inbox           → synthesize an inbound email (routes via Email Routing)
 *   GET  /__mock/otp-latest      → fetch the most-recent OTP for an address
 *
 * Also exports a /cdn-cgi/access/logout handler (sister surface) — Cloudflare
 * Access normally serves this URL, but in MOCK_MODE we route it ourselves so
 * the ProfileMenu sign-out link doesn't 404.
 *
 * See `.research/mock-mode-architecture.md` § 6.
 */

import { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import type { Env } from "../types";
import { isMockMode } from "../lib/mock-mode";
import {
  clearOutbox,
  getLatestOtp,
  listOutboxEntries,
} from "../lib/mocks/outbox-writer";

const mockRouter = new Hono<{ Bindings: Env }>();

/**
 * Module-level guard: every /__mock/* route MUST 404 in production. The
 * mount point in workers/app.ts only registers this router when MOCK_MODE=1,
 * but defensive depth means the routes also self-gate so a config mistake
 * still fails closed.
 */
mockRouter.use("/*", async (c, next) => {
  if (!isMockMode(c.env)) return c.text("Not Found", 404);
  await next();
});

mockRouter.get("/health", (c) => {
  return c.json({
    status: "ok",
    mock_mode: true,
    ts_ms: Date.now(),
  });
});

mockRouter.get("/outbox", async (c) => {
  const limit = Number(c.req.query("limit") ?? "100");
  const entries = await listOutboxEntries(c.env, { limit });
  return c.json({
    count: entries.length,
    entries: entries.map((e) => ({
      key: e.key,
      size: e.size,
      uploaded_iso: e.uploaded.toISOString(),
    })),
  });
});

mockRouter.get("/otp-latest", async (c) => {
  const email = c.req.query("email");
  if (!email) return c.json({ error: "email query param required" }, 400);
  const otp = await getLatestOtp(c.env, email);
  if (!otp) return c.json({ error: "no OTP recorded for this email" }, 404);
  return c.json(otp);
});

/**
 * POST /__mock/seed-session — directly insert a row into the better-auth `session`
 * table for an existing user, with a caller-supplied `expires_at`.
 *
 * The dev-mode picker (`/login` POST identity=...) sets the `x-mock-user-email`
 * cookie but does NOT create a row in the `session` table — that table is only
 * populated by the better-auth OTP flow. As a result, the
 * `GET /api/users/me/sessions` and `GET /api/users/me/clients` endpoints have
 * no test surface in MOCK_MODE without a way to seed sessions directly.
 *
 * This endpoint exists ONLY to give scenarios that need a controlled set of
 * sessions (S-AUTH-4 expired-session filter, future S-AUTH-* multi-session
 * tests) a deterministic seed path. Production never sees /__mock/* — the
 * router is only mounted when MOCK_MODE=1 (workers/app.ts) AND every route
 * defends with isMockMode(c.env) above.
 *
 * Body: { email: string, expires_at: number, ip_address?: string, user_agent?: string }
 *  - email       — must resolve to an existing users row (caller logs in first)
 *  - expires_at  — epoch ms; pass a past value to seed an expired session
 *  - ip_address  — optional, defaults to "127.0.0.1"
 *  - user_agent  — optional, defaults to "S-AUTH-4-seed/1.0"
 *
 * Returns: { id, user_id, expires_at, ip_address, user_agent, created_at, updated_at }
 */
mockRouter.post("/seed-session", async (c) => {
  let body: {
    email?: unknown;
    expires_at?: unknown;
    ip_address?: unknown;
    user_agent?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { email, expires_at, ip_address, user_agent } = body;
  if (typeof email !== "string" || email.trim().length === 0) {
    return c.json({ error: "email is required" }, 400);
  }
  if (typeof expires_at !== "number" || !Number.isFinite(expires_at)) {
    return c.json(
      { error: "expires_at must be a finite number (epoch ms)" },
      400,
    );
  }
  const ipAddress =
    typeof ip_address === "string" && ip_address.length > 0
      ? ip_address
      : "127.0.0.1";
  const userAgent =
    typeof user_agent === "string" && user_agent.length > 0
      ? user_agent
      : "S-AUTH-4-seed/1.0";

  // Look up the user row.
  const userRow = await c.env.DB.prepare(
    "SELECT id FROM users WHERE email = ?1",
  )
    .bind(email)
    .first<{ id: string }>();
  if (!userRow) {
    return c.json(
      { error: `no users row for email=${email} (caller must log in first)` },
      404,
    );
  }

  // Build a session row. Hex-from-random for id + token (ASCII-safe and
  // unique enough for a test seed; never used as a real auth credential).
  const rand = (n: number): string => {
    const buf = new Uint8Array(n);
    crypto.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  };
  const id = `seed-${rand(8)}`;
  const token = `seedtok-${rand(16)}`;
  const now = Date.now();

  await c.env.DB.prepare(
    `INSERT INTO session (id, user_id, expires_at, token, ip_address, user_agent, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
  )
    .bind(id, userRow.id, expires_at, token, ipAddress, userAgent, now)
    .run();

  return c.json({
    id,
    user_id: userRow.id,
    expires_at,
    ip_address: ipAddress,
    user_agent: userAgent,
    created_at: now,
    updated_at: now,
  });
});

/**
 * POST /__mock/seed-user — directly insert a row into the `users` table.
 *
 * The dev-mode picker only auto-promotes BOOTSTRAP_OWNER_EMAIL via
 * bootstrapOwner; every other email lands as 403 in authzContext. As a
 * result, multi-user scenarios (S-INBOX-3-INTERNAL-MODE, contacts flows,
 * group sharing, mailbox transfer) have no way to seed a SECOND user
 * without going through admin endpoints that don't exist yet in MOCK_MODE.
 *
 * This endpoint exists ONLY to give such scenarios a deterministic seed
 * path. Production never sees /__mock/* — the router is only mounted
 * when MOCK_MODE=1 (workers/app.ts) AND every route defends with
 * isMockMode(c.env) above.
 *
 * Body: { email: string, display_name?: string, role?: 'global_owner' | 'global_admin' | 'user' }
 *  - email        — primary key (collapsed via UNIQUE(lower(email)))
 *  - display_name — optional, defaults to null
 *  - role         — optional, defaults to 'user'
 *
 * Idempotent: calling with the same email returns the existing row.
 *
 * Returns: { id, email, role, status, created_at }
 */
mockRouter.post("/seed-user", async (c) => {
  let body: { email?: unknown; display_name?: unknown; role?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { email, display_name, role } = body;
  if (typeof email !== "string" || email.trim().length === 0) {
    return c.json({ error: "email is required" }, 400);
  }
  const trimmedEmail = email.trim();
  const resolvedRole =
    role === "global_owner" || role === "global_admin" || role === "user"
      ? role
      : "user";
  const resolvedDisplayName =
    typeof display_name === "string" && display_name.length > 0
      ? display_name
      : null;

  // Collapse on UNIQUE(lower(email)) — return the existing row if present.
  const existing = await c.env.DB.prepare(
    "SELECT id, email, role, status, created_at FROM users WHERE lower(email) = lower(?1)",
  )
    .bind(trimmedEmail)
    .first<{
      id: string;
      email: string;
      role: string;
      status: string;
      created_at: number;
    }>();
  if (existing) {
    return c.json(existing);
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO users (id, email, display_name, role, status, visibility, account_type, created_at, last_login_at, email_verified, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'active', 'everyone', 'personal', ?5, ?5, 0, ?5)`,
  )
    .bind(id, trimmedEmail, resolvedDisplayName, resolvedRole, now)
    .run();

  return c.json({
    id,
    email: trimmedEmail,
    role: resolvedRole,
    status: "active",
    created_at: now,
  });
});

/**
 * POST /__mock/impersonate — swap the `x-mock-user-email` cookie.
 *
 * The dev-mode picker at /login sets `x-mock-user-email` to whichever
 * preset (or custom email) the user chose. Once set, every subsequent
 * request resolves to that identity via the mock-access shim
 * (workers/lib/mock-access.ts).
 *
 * Multi-user UI scenarios — contacts handshake (recipient accepts a
 * pending request), group invitation acceptance, mailbox transfer,
 * share-with-group — need to flip identity mid-test without stepping
 * through the picker form again. This endpoint is the cheap helper.
 *
 * Production never sees /__mock/* — the router is only mounted when
 * MOCK_MODE=1 (workers/app.ts) AND every route defends with
 * isMockMode(c.env).
 *
 * Body: { email: string }
 *   - Must be a syntactically valid email. The endpoint does NOT verify
 *     the user exists in the `users` table; callers that need a real
 *     row should POST /__mock/seed-user first.
 *
 * Returns: { ok: true, email } and Set-Cookie header that overrides the
 * existing x-mock-user-email cookie.
 */
mockRouter.post("/impersonate", async (c) => {
  let body: { email?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const { email } = body;
  if (typeof email !== "string" || email.trim().length === 0) {
    return c.json({ error: "email is required" }, 400);
  }
  const trimmed = email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return c.json({ error: "invalid email syntax" }, 400);
  }
  const cookie = `x-mock-user-email=${encodeURIComponent(trimmed)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`;
  c.header("Set-Cookie", cookie);
  return c.json({ ok: true, email: trimmed });
});

mockRouter.post("/inbox", async (c) => {
  const body = await c.req.json<{
    to: string;
    from: string;
    subject: string;
    body: string;
  }>();
  if (!body.to || !body.from || !body.subject) {
    return c.json({ error: "to, from, subject required" }, 400);
  }
  // Build the full RFC-822 message and pass its TOTAL byte length as
  // rawSize. receiveEmail → streamToArrayBuffer reads up to rawSize bytes
  // and throws "Stream exceeds declared size" if the stream produces more,
  // so an undersized rawSize (e.g. body-only) breaks ingest.
  const blob = new Blob([
    `From: ${body.from}\r\n`,
    `To: ${body.to}\r\n`,
    `Subject: ${body.subject}\r\n`,
    `\r\n`,
    body.body ?? "",
  ]);
  const { receiveEmail } = await import("../index");
  await receiveEmail(
    { raw: blob.stream(), rawSize: blob.size },
    c.env,
    c.executionCtx as ExecutionContext,
  );
  return c.json({ ok: true, ingested: { to: body.to, from: body.from } });
});

/**
 * Wipes every dev-state surface so a scenario can start from a known baseline.
 * Returns counts so the smoke verifier can assert the reset actually fired.
 */
mockRouter.post("/reset", async (c) => {
  // 1) Outbox + OTP tee in R2.
  const outboxResult = await clearOutbox(c.env);

  // 2) D1 control-plane tables. Truncate in dependency order so FKs don't
  //    block. The list mirrors the schema spine; non-existent tables 404 in
  //    Miniflare but error out — wrap each in try so the reset is best-effort
  //    but always returns SOMETHING the verifier can assert against.
  const tables = [
    "audit_log",
    "client_grants",
    "clients",
    "agent_tokens",
    "inbox_policies",
    "mailbox_acls",
    "mailboxes",
    "group_invitations",
    "group_memberships",
    "groups",
    "user_contacts",
    "user_sessions",
    "users",
  ];
  const cleared: Record<string, number | string> = {};
  for (const t of tables) {
    try {
      const r = await c.env.DB.prepare(`DELETE FROM ${t}`).run();
      cleared[t] = r.meta.changes ?? 0;
    } catch (e) {
      cleared[t] = `skip: ${(e as Error).message.slice(0, 80)}`;
    }
  }

  return c.json({
    ok: true,
    outbox: outboxResult,
    d1: cleared,
  });
});

export default mockRouter;

/**
 * Sister handler: serve /cdn-cgi/access/logout when MOCK_MODE=1.
 *
 * Cloudflare Access serves this URL in production; in MOCK_MODE there is no
 * Access layer, so the ProfileMenu sign-out link would 404. We clear all
 * better-auth + mock-access cookies and redirect to /login, mirroring what
 * the real Access logout does.
 *
 * Mounted in workers/app.ts via `app.all("/cdn-cgi/access/logout", ...)`.
 */
export function mockAccessLogoutHandler(): (
  c: import("hono").Context<{ Bindings: Env }>,
) => Response | Promise<Response> {
  return (c) => {
    if (!isMockMode(c.env)) return c.text("Not Found", 404);
    // Wipe known cookie surfaces — better-auth session, mock-access pin.
    for (const name of [
      "better-auth.session_token",
      "better-auth.session_data",
      "x-mock-user-email",
      "CF_Authorization",
    ]) {
      deleteCookie(c, name, { path: "/" });
    }
    return c.redirect("/login", 303);
  };
}
