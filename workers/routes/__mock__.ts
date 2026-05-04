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
