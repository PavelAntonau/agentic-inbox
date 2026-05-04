// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Tests for workers/lib/email-helpers.ts — TASK-2.1 listMailboxes D1+R2 union.
//
// listMailboxes is an IO-heavy function (drizzle + R2). We fake the ORM and the
// bucket surfaces to exercise the union/dedupe/filter semantics without a real
// database. The drizzle mock returns a chainable shim whose terminal `.all()`
// resolves to canned rows seeded per-test.

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AuthzContext } from "../db/control-plane/forGroup";

// ── Mocks ─────────────────────────────────────────────────────────────────

type MailboxRow = {
  id: string;
  address: string;
  owner_user_id: string;
  external_inbound_enabled: boolean;
  external_send_enabled: boolean;
  external_allow_mode: "all" | "allowlist";
  internal_inbound_mode: "everyone" | "contacts_only" | "none";
};

// State the drizzle mock reads on each .all() resolution.
let d1Rows: MailboxRow[] = [];
let lastFilterIds: string[] | null = null;

function makeChain() {
  const chain = {
    select: vi.fn(() => chain),
    from: vi.fn(() => chain),
    where: vi.fn((arg: unknown) => {
      // Capture the inArray() call's id list when present so tests can assert
      // the correct filter was applied. drizzle's inArray returns an SQL
      // expression; here we only need to confirm filter happened — the actual
      // narrowing is simulated via test-side seeding.
      const maybeWhereCall = arg as { values?: unknown[] };
      if (maybeWhereCall && Array.isArray(maybeWhereCall.values)) {
        lastFilterIds = maybeWhereCall.values.map(String);
      }
      return chain;
    }),
    all: vi.fn(async () => d1Rows),
    get: vi.fn(async () => d1Rows[0] ?? null),
  };
  return chain;
}

vi.mock("drizzle-orm/d1", () => ({
  drizzle: vi.fn(() => makeChain()),
}));

vi.mock("drizzle-orm", async () => {
  // Pass through the real exports for sql / eq / or / etc. (mailbox.ts uses
  // them outside of listMailboxes); only the chain calls go through our mock.
  const actual =
    await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return {
    ...actual,
    // inArray returns a tagged value our chain.where() hook can introspect.
    inArray: vi.fn((_col: unknown, values: unknown[]) => ({
      __kind: "inArray",
      values,
    })),
  };
});

// ── Imports under test (after mocks) ─────────────────────────────────────

import { listMailboxes } from "./email-helpers";

// ── Fixtures ─────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<MailboxRow> & { id: string }): MailboxRow {
  return {
    address: `${overrides.id}@actionnow.ai`,
    owner_user_id: "u-alice",
    external_inbound_enabled: false,
    external_send_enabled: false,
    external_allow_mode: "all",
    internal_inbound_mode: "everyone",
    ...overrides,
  };
}

function makeBucket(addresses: string[]): R2Bucket {
  return {
    list: vi.fn(async () => ({
      objects: addresses.map((a) => ({ key: `mailboxes/${a}.json` })),
    })),
  } as unknown as R2Bucket;
}

function makeEnv(addresses: string[]) {
  return {
    BUCKET: makeBucket(addresses),
    DB: {} as unknown as D1Database,
  };
}

function makeCtx(overrides: Partial<AuthzContext> = {}): AuthzContext {
  return {
    user_id: "u-alice",
    role: "user",
    group_ids: [],
    authorized_mailbox_ids: [],
    ...overrides,
  };
}

beforeEach(() => {
  d1Rows = [];
  lastFilterIds = null;
  vi.clearAllMocks();
});

// ── TASK-2.1: D1+R2 union with JWT filtering ─────────────────────────────

describe("listMailboxes — TASK-2.1 D1+R2 union, JWT-filtered", () => {
  it("returns D1-only mailbox when authzContext authorises it", async () => {
    d1Rows = [makeRow({ id: "uuid-tail2", address: "tail2@actionnow.ai" })];
    const env = makeEnv([]); // no R2 entries
    const ctx = makeCtx({ authorized_mailbox_ids: ["uuid-tail2"] });

    const result = await listMailboxes(env as never, ctx);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "uuid-tail2",
      email: "tail2@actionnow.ai",
      address: "tail2@actionnow.ai",
      kind: "d1",
    });
  });

  it("returns R2-only mailbox even with empty D1", async () => {
    d1Rows = [];
    const env = makeEnv(["testbox@actionnow.ai"]);
    const ctx = makeCtx({ authorized_mailbox_ids: [] });

    const result = await listMailboxes(env as never, ctx);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "testbox@actionnow.ai",
      email: "testbox@actionnow.ai",
      address: "testbox@actionnow.ai",
      kind: "r2",
    });
  });

  it("dedupes on lowercase address — D1 wins on collision", async () => {
    d1Rows = [makeRow({ id: "uuid-shared", address: "shared@actionnow.ai" })];
    const env = makeEnv([
      "Shared@actionnow.ai", // R2 has the same address (different case)
      "r2-only@actionnow.ai",
    ]);
    const ctx = makeCtx({ authorized_mailbox_ids: ["uuid-shared"] });

    const result = await listMailboxes(env as never, ctx);

    // 2 entries: the D1 row (winner on collision) + the unique R2 entry.
    expect(result).toHaveLength(2);
    const shared = result.find(
      (m) => m.address.toLowerCase() === "shared@actionnow.ai",
    );
    expect(shared?.kind).toBe("d1");
    expect(shared?.id).toBe("uuid-shared");
    const r2only = result.find((m) => m.address === "r2-only@actionnow.ai");
    expect(r2only?.kind).toBe("r2");
  });

  it("hides unauthorised D1 mailboxes when authzContext.authorized_mailbox_ids is non-empty", async () => {
    // Simulate: D1 has 2 rows but the caller is only authorised for one of them.
    // The drizzle mock returns whatever d1Rows is set to; we simulate the
    // filter semantics by only seeding the row(s) the inArray() filter would
    // include.
    d1Rows = [makeRow({ id: "uuid-mine", address: "mine@actionnow.ai" })];
    const env = makeEnv([]);
    const ctx = makeCtx({ authorized_mailbox_ids: ["uuid-mine"] });

    const result = await listMailboxes(env as never, ctx);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("uuid-mine");

    // The drizzle mock captured the filter: caller asked for inArray(["uuid-mine"]).
    expect(lastFilterIds).toEqual(["uuid-mine"]);
  });

  it("returns empty when authzContext exists but authorised_mailbox_ids is empty", async () => {
    d1Rows = [makeRow({ id: "uuid-other", address: "other@actionnow.ai" })];
    const env = makeEnv([]);
    const ctx = makeCtx({ authorized_mailbox_ids: [] });

    const result = await listMailboxes(env as never, ctx);
    expect(result).toEqual([]);
  });

  it("returns ALL D1 rows when called without authzContext (trusted internal)", async () => {
    d1Rows = [
      makeRow({ id: "uuid-1", address: "one@actionnow.ai" }),
      makeRow({ id: "uuid-2", address: "two@actionnow.ai" }),
    ];
    const env = makeEnv([]);

    const result = await listMailboxes(env as never);

    expect(result).toHaveLength(2);
    expect(result.every((m) => m.kind === "d1")).toBe(true);
  });

  it("legacy R2Bucket-only call style still works (no DB)", async () => {
    d1Rows = []; // even if the mock had rows, R2Bucket call style won't query D1
    const bucket = makeBucket(["legacy@actionnow.ai"]);

    const result = await listMailboxes(bucket);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "legacy@actionnow.ai",
      address: "legacy@actionnow.ai",
      kind: "r2",
    });
  });

  it("returns the union when both D1 and R2 contain different addresses", async () => {
    d1Rows = [makeRow({ id: "uuid-d1", address: "d1@actionnow.ai" })];
    const env = makeEnv(["r2@actionnow.ai"]);
    const ctx = makeCtx({ authorized_mailbox_ids: ["uuid-d1"] });

    const result = await listMailboxes(env as never, ctx);

    expect(result).toHaveLength(2);
    const d1 = result.find((m) => m.address === "d1@actionnow.ai");
    const r2 = result.find((m) => m.address === "r2@actionnow.ai");
    expect(d1?.kind).toBe("d1");
    expect(r2?.kind).toBe("r2");
  });

  it("response shape includes address + kind for both stores", async () => {
    d1Rows = [makeRow({ id: "uuid-d1", address: "d1@actionnow.ai" })];
    const env = makeEnv(["r2@actionnow.ai"]);
    const ctx = makeCtx({ authorized_mailbox_ids: ["uuid-d1"] });

    const result = await listMailboxes(env as never, ctx);

    for (const m of result) {
      expect(m).toHaveProperty("id");
      expect(m).toHaveProperty("email");
      expect(m).toHaveProperty("address");
      expect(m).toHaveProperty("kind");
    }
  });
});
