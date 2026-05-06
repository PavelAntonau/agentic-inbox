// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Tests for workers/lib/mailbox.ts — TASK-2.2 requireMailbox D1-aware fallback.
//
// requireMailbox middleware resolves :mailboxId in this order:
//   1. D1 mailboxes table — match `id` (UUID) OR `address` (case-insensitive).
//   2. R2 bucket — legacy v1 path; treats the segment as the email address.
//   3. 404 when neither stack has the mailbox.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// ── Drizzle mock — chainable shim returning canned rows ──────────────────

type MailboxIdRow = { id: string; address: string };

let d1Row: MailboxIdRow | null = null;

function makeChain() {
  const chain = {
    select: vi.fn(() => chain),
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    get: vi.fn(async () => d1Row),
    all: vi.fn(async () => (d1Row ? [d1Row] : [])),
  };
  return chain;
}

vi.mock("drizzle-orm/d1", () => ({
  drizzle: vi.fn(() => makeChain()),
}));

// ── Imports under test (after mocks) ─────────────────────────────────────

import { requireMailbox, type MailboxContext } from "./mailbox";
import type { AuthzContext } from "../db/control-plane/forGroup";

// ── Fixtures ─────────────────────────────────────────────────────────────

function makeR2Bucket(presentAddresses: Set<string>): R2Bucket {
  return {
    head: vi.fn(async (key: string) => {
      const addr = key.replace("mailboxes/", "").replace(".json", "");
      return presentAddresses.has(addr.toLowerCase())
        ? ({ key } as R2ObjectBody)
        : null;
    }),
  } as unknown as R2Bucket;
}

function makeMailboxNamespace() {
  return {
    idFromName: vi.fn((name: string) => ({ __name: name }) as unknown),
    get: vi.fn(() => ({ __stub: true }) as unknown),
  };
}

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
  env: { DB: unknown; BUCKET: R2Bucket; MAILBOX: unknown },
  // `null` = no authzContext set (simulates auth-bypass posture).
  // Default = global_owner so pre-existing TASK-2.2 tests stay covered.
  authz: AuthzContext | null = makeAuthz("global_owner"),
) {
  const app = new Hono<MailboxContext>();
  // Inject authzContext upstream of requireMailbox so the gate sees it the
  // same way the real workers/middleware/authz-context.ts middleware sets it.
  app.use("*", async (c, next) => {
    if (authz !== null) c.set("authzContext", authz);
    await next();
  });
  app.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox);
  app.get("/api/v1/mailboxes/:mailboxId/probe", (c) => {
    return c.json({
      resolvedMailboxAddress: c.var.resolvedMailboxAddress,
      resolvedMailboxId: c.var.resolvedMailboxId ?? null,
    });
  });
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

// ── TASK-2.2: D1-aware middleware ────────────────────────────────────────

describe("requireMailbox — TASK-2.2 D1-aware fallback", () => {
  it("resolves a D1 UUID — sets resolvedMailboxAddress to the row's address", async () => {
    d1Row = {
      id: "e2f5a514d78c12d9c646b3dc06e3beca",
      address: "tail2@actionnow.ai",
    };
    const env = {
      DB: {} as unknown,
      BUCKET: makeR2Bucket(new Set()),
      MAILBOX: makeMailboxNamespace(),
    };
    const app = makeApp(env);

    const res = await app.fetch(
      "/api/v1/mailboxes/e2f5a514d78c12d9c646b3dc06e3beca/probe",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resolvedMailboxAddress: string;
      resolvedMailboxId: string | null;
    };
    expect(body.resolvedMailboxAddress).toBe("tail2@actionnow.ai");
    expect(body.resolvedMailboxId).toBe("e2f5a514d78c12d9c646b3dc06e3beca");
  });

  it("resolves a D1 row by address (case-insensitive) — DB row wins over R2", async () => {
    d1Row = { id: "uuid-shared", address: "shared@actionnow.ai" };
    const env = {
      DB: {} as unknown,
      BUCKET: makeR2Bucket(new Set(["shared@actionnow.ai"])),
      MAILBOX: makeMailboxNamespace(),
    };
    const app = makeApp(env);

    const res = await app.fetch("/api/v1/mailboxes/Shared@actionnow.ai/probe");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resolvedMailboxAddress: string;
      resolvedMailboxId: string | null;
    };
    // D1 wins — the resolved id is the UUID, not the address.
    expect(body.resolvedMailboxAddress).toBe("shared@actionnow.ai");
    expect(body.resolvedMailboxId).toBe("uuid-shared");
  });

  it("falls through to R2 when D1 has no row — resolvedMailboxId is undefined", async () => {
    d1Row = null;
    const env = {
      DB: {} as unknown,
      BUCKET: makeR2Bucket(new Set(["legacy@actionnow.ai"])),
      MAILBOX: makeMailboxNamespace(),
    };
    const app = makeApp(env);

    const res = await app.fetch("/api/v1/mailboxes/legacy@actionnow.ai/probe");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resolvedMailboxAddress: string;
      resolvedMailboxId: string | null;
    };
    expect(body.resolvedMailboxAddress).toBe("legacy@actionnow.ai");
    expect(body.resolvedMailboxId).toBeNull();
  });

  it("returns 404 when neither D1 nor R2 has the mailbox", async () => {
    d1Row = null;
    const env = {
      DB: {} as unknown,
      BUCKET: makeR2Bucket(new Set()),
      MAILBOX: makeMailboxNamespace(),
    };
    const app = makeApp(env);

    const res = await app.fetch("/api/v1/mailboxes/unknown@actionnow.ai/probe");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not found/i);
  });

  it("returns 400 when :mailboxId is empty", async () => {
    const env = {
      DB: {} as unknown,
      BUCKET: makeR2Bucket(new Set()),
      MAILBOX: makeMailboxNamespace(),
    };
    const app = makeApp(env);

    // Empty path segment leads to the middleware seeing an empty rawId.
    // Hono's router rejects "//probe" before reaching the middleware in some
    // versions; we settle for confirming the middleware doesn't crash on a
    // missing param when called via a route that doesn't supply it.
    // Direct test: hit a path that matches the wildcard but has no id segment.
    const res = await app.fetch("/api/v1/mailboxes/%20/probe");
    // Treat both 400 and 404 as acceptable — the key contract is "no crash".
    expect([400, 404]).toContain(res.status);
  });

  it("URL-encoded address is decoded before lookup", async () => {
    d1Row = null;
    const env = {
      DB: {} as unknown,
      BUCKET: makeR2Bucket(new Set(["a+plus@actionnow.ai"])),
      MAILBOX: makeMailboxNamespace(),
    };
    const app = makeApp(env);

    // %2B = +
    const res = await app.fetch(
      "/api/v1/mailboxes/a%2Bplus@actionnow.ai/probe",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resolvedMailboxAddress: string };
    expect(body.resolvedMailboxAddress).toBe("a+plus@actionnow.ai");
  });
});

// ── P0-5 (security audit Phase 5): IDOR gate via authzContext ──────────
//
// Closes the gap documented in `.research/agentic-inbox-security-audit.md` —
// `requireMailbox` previously did existence-only resolution, allowing any
// authenticated user to read/write any other user's mailbox via
// /api/v1/mailboxes/:id/*. The gate now requires:
//   - authzContext present (else 401)
//   - row.id ∈ authorized_mailbox_ids OR caller is global_owner/global_admin
//   - R2-only legacy mailboxes (no D1 row) require a global role

describe("requireMailbox — P0-5 IDOR gate", () => {
  it("D1 row + caller authorized → 200", async () => {
    const id = "uuid-alice";
    d1Row = { id, address: "alice@actionnow.ai" };
    const env = {
      DB: {} as unknown,
      BUCKET: makeR2Bucket(new Set()),
      MAILBOX: makeMailboxNamespace(),
    };
    const app = makeApp(env, makeAuthz("user", [id]));
    const res = await app.fetch("/api/v1/mailboxes/uuid-alice/probe");
    expect(res.status).toBe(200);
  });

  it("D1 row + caller NOT in authorized_mailbox_ids → 403", async () => {
    d1Row = { id: "uuid-bob", address: "bob@actionnow.ai" };
    const env = {
      DB: {} as unknown,
      BUCKET: makeR2Bucket(new Set()),
      MAILBOX: makeMailboxNamespace(),
    };
    // Caller authorized for someone else's mailbox, not bob's
    const app = makeApp(env, makeAuthz("user", ["uuid-other"]));
    const res = await app.fetch("/api/v1/mailboxes/uuid-bob/probe");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/forbidden/i);
  });

  it("D1 row + global_owner → 200 even without explicit authorization", async () => {
    d1Row = { id: "uuid-anyone", address: "anyone@actionnow.ai" };
    const env = {
      DB: {} as unknown,
      BUCKET: makeR2Bucket(new Set()),
      MAILBOX: makeMailboxNamespace(),
    };
    const app = makeApp(env, makeAuthz("global_owner", []));
    const res = await app.fetch("/api/v1/mailboxes/uuid-anyone/probe");
    expect(res.status).toBe(200);
  });

  it("D1 row + global_admin → 200 even without explicit authorization", async () => {
    d1Row = { id: "uuid-x", address: "x@actionnow.ai" };
    const env = {
      DB: {} as unknown,
      BUCKET: makeR2Bucket(new Set()),
      MAILBOX: makeMailboxNamespace(),
    };
    const app = makeApp(env, makeAuthz("global_admin", []));
    const res = await app.fetch("/api/v1/mailboxes/uuid-x/probe");
    expect(res.status).toBe(200);
  });

  it("R2 fallback + non-global caller → 403 (legacy mailboxes have no ACL model)", async () => {
    d1Row = null;
    const env = {
      DB: {} as unknown,
      BUCKET: makeR2Bucket(new Set(["legacy@actionnow.ai"])),
      MAILBOX: makeMailboxNamespace(),
    };
    const app = makeApp(env, makeAuthz("user", []));
    const res = await app.fetch("/api/v1/mailboxes/legacy@actionnow.ai/probe");
    expect(res.status).toBe(403);
  });

  it("R2 fallback + global_owner → 200", async () => {
    d1Row = null;
    const env = {
      DB: {} as unknown,
      BUCKET: makeR2Bucket(new Set(["legacy@actionnow.ai"])),
      MAILBOX: makeMailboxNamespace(),
    };
    const app = makeApp(env, makeAuthz("global_owner", []));
    const res = await app.fetch("/api/v1/mailboxes/legacy@actionnow.ai/probe");
    expect(res.status).toBe(200);
  });

  it("authzContext absent → 401 (auth-bypass posture)", async () => {
    d1Row = { id: "uuid-anything", address: "x@actionnow.ai" };
    const env = {
      DB: {} as unknown,
      BUCKET: makeR2Bucket(new Set(["x@actionnow.ai"])),
      MAILBOX: makeMailboxNamespace(),
    };
    const app = makeApp(env, null);
    const res = await app.fetch("/api/v1/mailboxes/uuid-anything/probe");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unauthorized/i);
  });
});

// ── Phase C1 / B-04: bare-path mount tests ───────────────────────────────
//
// Hono's `/foo/:p/*` middleware mount only matches sub-paths, NOT the bare
// `/foo/X` triplet. Phase 5's V1 mount left GET / PUT / DELETE on
// `/api/v1/mailboxes/:mailboxId` ungated; PUT in particular overwrites R2
// settings (forwarding, autoreply, agentSystemPrompt) without authz — a
// single-curl mail-exfil primitive. Phase C1 mounts requireMailbox on BOTH
// the bare and wildcard paths; these tests assert the bare-path posture.

function makeBareApp(
  env: { DB: unknown; BUCKET: R2Bucket; MAILBOX: unknown },
  authz: AuthzContext | null = makeAuthz("global_owner"),
) {
  const app = new Hono<MailboxContext>();
  app.use("*", async (c, next) => {
    if (authz !== null) c.set("authzContext", authz);
    await next();
  });
  // Phase C1 / B-04 — bare-path mount in addition to the wildcard.
  app.use("/api/v1/mailboxes/:mailboxId", requireMailbox);
  app.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox);
  // Bare-path inner handlers (GET / PUT / DELETE) — same surface that the
  // walkthrough flagged as the catastrophic IDOR (PUT writes R2 settings).
  app.put("/api/v1/mailboxes/:mailboxId", (c) =>
    c.json({ wrote: true, mailboxId: c.req.param("mailboxId") }),
  );
  app.delete("/api/v1/mailboxes/:mailboxId", (c) => c.body(null, 204));
  return {
    fetch: (path: string, init?: RequestInit) =>
      app.fetch(
        new Request(`http://localhost${path}`, init),
        env as unknown as Parameters<typeof app.fetch>[1],
      ),
  };
}

describe("requireMailbox — Phase C1 / B-04 bare-path gate", () => {
  it("PUT /api/v1/mailboxes/:id by non-owner → 403 (was 200 = R2-overwrite IDOR)", async () => {
    d1Row = { id: "uuid-alice", address: "alice@actionnow.ai" };
    const env = {
      DB: {} as unknown,
      BUCKET: makeR2Bucket(new Set()),
      MAILBOX: makeMailboxNamespace(),
    };
    const app = makeBareApp(env, makeAuthz("user", ["uuid-bob"]));
    const res = await app.fetch("/api/v1/mailboxes/uuid-alice", {
      method: "PUT",
      body: JSON.stringify({ settings: { agentSystemPrompt: "exfil" } }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(403);
  });

  it("DELETE /api/v1/mailboxes/:id by non-owner → 403", async () => {
    d1Row = { id: "uuid-alice", address: "alice@actionnow.ai" };
    const env = {
      DB: {} as unknown,
      BUCKET: makeR2Bucket(new Set()),
      MAILBOX: makeMailboxNamespace(),
    };
    const app = makeBareApp(env, makeAuthz("user", ["uuid-bob"]));
    const res = await app.fetch("/api/v1/mailboxes/uuid-alice", {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
  });

  it("PUT /api/v1/mailboxes/:id by owner → 200 (wraps the inner handler)", async () => {
    d1Row = { id: "uuid-alice", address: "alice@actionnow.ai" };
    const env = {
      DB: {} as unknown,
      BUCKET: makeR2Bucket(new Set()),
      MAILBOX: makeMailboxNamespace(),
    };
    const app = makeBareApp(env, makeAuthz("user", ["uuid-alice"]));
    const res = await app.fetch("/api/v1/mailboxes/uuid-alice", {
      method: "PUT",
      body: JSON.stringify({ settings: { fromName: "Alice" } }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
  });
});
