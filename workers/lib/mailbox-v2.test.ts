// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase C1 / B-01 + B-02 — workers/lib/mailbox-v2.ts unit tests.
//
// Coverage:
//   • Reserved segment (`/api/mailboxes/tree`) passes through without authz.
//   • Missing authzContext → 401.
//   • Mailbox not found in D1 → 404.
//   • Non-global caller WITHOUT authorized_mailbox_ids match → 403.
//   • Non-global caller WITH authorized_mailbox_ids match → next() + ctx set.
//   • global_owner / global_admin bypass authorized_mailbox_ids → next().

import { describe, expect, it, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// ── Drizzle mock ──────────────────────────────────────────────────────────

type MailboxRow = { id: string; address: string };
let d1Row: MailboxRow | null = null;

function makeChain() {
  const chain = {
    select: vi.fn(() => chain),
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    get: vi.fn(async () => d1Row),
  };
  return chain;
}

vi.mock("drizzle-orm/d1", () => ({
  drizzle: vi.fn(() => makeChain()),
}));

// ── Imports under test (after mocks) ─────────────────────────────────────

import {
  requireMailboxV2,
  V2_RESERVED_SEGMENTS,
  type MailboxV2Context,
} from "./mailbox-v2";
import type { AuthzContext } from "../db/control-plane/forGroup";

function makeAuthz(
  role: AuthzContext["role"] = "user",
  authorized_mailbox_ids: string[] = [],
): AuthzContext {
  return {
    user_id: "user-test",
    role,
    group_ids: [],
    authorized_mailbox_ids,
  };
}

function makeApp(
  env: { DB: unknown },
  authz: AuthzContext | null = makeAuthz("user", []),
) {
  const app = new Hono<MailboxV2Context>();
  app.use("*", async (c, next) => {
    if (authz !== null) c.set("authzContext", authz);
    await next();
  });
  app.use("/api/mailboxes/:mailboxId", requireMailboxV2);
  app.use("/api/mailboxes/:mailboxId/*", requireMailboxV2);
  // Literal route MUST be registered before the parameterized one — Hono
  // matches in registration order, and the prod app's mailboxesRouter
  // registers `/tree` before `/:id` for the same reason.
  app.get("/api/mailboxes/tree", (c) => c.json({ tree: true }));
  app.get("/api/mailboxes/:mailboxId", (c) =>
    c.json({
      ok: true,
      resolvedMailboxId: c.var.resolvedMailboxId,
      resolvedMailboxAddress: c.var.resolvedMailboxAddress,
    }),
  );
  app.get("/api/mailboxes/:mailboxId/probe", (c) =>
    c.json({
      ok: true,
      resolvedMailboxId: c.var.resolvedMailboxId,
    }),
  );
  return {
    fetch: (path: string) =>
      app.fetch(
        new Request(`http://localhost${path}`),
        env as unknown as Parameters<typeof app.fetch>[1],
      ),
  };
}

beforeEach(() => {
  d1Row = null;
  vi.clearAllMocks();
});

describe("requireMailboxV2 (Phase C1 / B-01 + B-02)", () => {
  it("passes through reserved segment `/tree` without authz check", async () => {
    expect(V2_RESERVED_SEGMENTS.has("tree")).toBe(true);
    // Non-global caller without any authorized mailboxes — would 403 if the
    // gate fired. Reserved-segment fast path skips the check.
    const app = makeApp({ DB: {} }, makeAuthz("user", []));
    const res = await app.fetch("/api/mailboxes/tree");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tree: true });
  });

  it("returns 401 when authzContext is missing (auth-bypass posture)", async () => {
    const app = makeApp({ DB: {} }, null);
    const res = await app.fetch("/api/mailboxes/abc-123/probe");
    expect(res.status).toBe(401);
  });

  it("returns 404 when D1 has no row for the mailbox segment", async () => {
    d1Row = null;
    const app = makeApp({ DB: {} }, makeAuthz("user", []));
    const res = await app.fetch("/api/mailboxes/abc-123/probe");
    expect(res.status).toBe(404);
  });

  it("returns 403 when non-global caller lacks authorization for the resolved mailbox", async () => {
    d1Row = { id: "mailbox-A", address: "alice@actionnow.ai" };
    const app = makeApp({ DB: {} }, makeAuthz("user", ["mailbox-OTHER"]));
    const res = await app.fetch("/api/mailboxes/alice@actionnow.ai/threads/t1");
    expect(res.status).toBe(403);
  });

  it("forwards to the inner handler when caller has authorization", async () => {
    d1Row = { id: "mailbox-A", address: "alice@actionnow.ai" };
    const app = makeApp({ DB: {} }, makeAuthz("user", ["mailbox-A"]));
    const res = await app.fetch("/api/mailboxes/alice@actionnow.ai/probe");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resolvedMailboxId: string };
    expect(body.resolvedMailboxId).toBe("mailbox-A");
  });

  it("global_owner role bypasses authorized_mailbox_ids check", async () => {
    d1Row = { id: "mailbox-A", address: "alice@actionnow.ai" };
    const app = makeApp(
      { DB: {} },
      makeAuthz("global_owner", []), // empty authz set
    );
    const res = await app.fetch("/api/mailboxes/alice@actionnow.ai/probe");
    expect(res.status).toBe(200);
  });

  it("global_admin role bypasses authorized_mailbox_ids check", async () => {
    d1Row = { id: "mailbox-A", address: "alice@actionnow.ai" };
    const app = makeApp({ DB: {} }, makeAuthz("global_admin", []));
    const res = await app.fetch("/api/mailboxes/alice@actionnow.ai/probe");
    expect(res.status).toBe(200);
  });

  it("gates the bare `:mailboxId` (DELETE-equivalent) path same as the wildcard", async () => {
    d1Row = { id: "mailbox-A", address: "alice@actionnow.ai" };
    const app = makeApp({ DB: {} }, makeAuthz("user", ["mailbox-OTHER"]));
    // Non-owner hitting the bare path — must 403, NOT pass through.
    const res = await app.fetch("/api/mailboxes/alice@actionnow.ai");
    expect(res.status).toBe(403);
  });

  it("returns 503 when DB binding is unavailable (fail-CLOSED)", async () => {
    const app = makeApp({ DB: undefined }, makeAuthz("user", []));
    const res = await app.fetch("/api/mailboxes/abc/probe");
    expect(res.status).toBe(503);
  });
});
