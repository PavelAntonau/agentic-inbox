// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// T3.6 — workers/lib/mcp-list-mailboxes.ts unit tests.
//
// Coverage matrix (closes audit P0-4 verification):
//   - buildAuthzContextFromUserId
//       · happy path: own mailboxes + group-shared mailboxes union, deduped
//       · inactive user → null
//       · missing user → null
//       · PAT mailbox_id constraint = intersection narrowing (drops mailboxes
//         the user has lost ACL on; keeps the constrained one when authorized;
//         returns [] when constraint outside user-authorized set)
//       · DB unset → null
//   - serveListMailboxes
//       · authzContext narrows the listMailboxes output to only authorized
//         mailbox ids (smoke through toolListMailboxes / listMailboxes)
//       · failure path (user inactive) returns 200 with empty mailbox list,
//         NEVER the trusted-internal "return everything" branch — this is the
//         load-bearing behavior the audit's P0-4 finding turned on
//       · response shape: 200 + application/json + JSON-RPC envelope
//         { jsonrpc: "2.0", id, result.content[0].text = JSON-stringified payload }
//
// Drizzle mock strategy: queue-based dispatch. Each test seeds an ordered
// list of expected `.all()` / `.get()` results matching the query order in
// the function under test. This keeps the mock dependency-free of drizzle's
// actual table-marker internals while still asserting the correct number
// of round-trips.

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Drizzle mock — queue-based dispatch ────────────────────────────────────

type QueueEntry =
  | { kind: "get"; result: unknown }
  | { kind: "all"; result: unknown };

let queryQueue: QueueEntry[] = [];
let r2Objects: { key: string }[] = [];

function makeChain() {
  const chain = {
    select: vi.fn(() => chain),
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    all: vi.fn(async () => {
      const next = queryQueue.shift();
      if (!next || next.kind !== "all") {
        throw new Error(
          `Unexpected .all() call (queue head=${JSON.stringify(next)})`,
        );
      }
      return next.result;
    }),
    get: vi.fn(async () => {
      const next = queryQueue.shift();
      if (!next || next.kind !== "get") {
        throw new Error(
          `Unexpected .get() call (queue head=${JSON.stringify(next)})`,
        );
      }
      return next.result;
    }),
  };
  return chain;
}

vi.mock("drizzle-orm/d1", () => ({
  drizzle: vi.fn(() => makeChain()),
}));

vi.mock("drizzle-orm", async () => {
  const actual =
    await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return {
    ...actual,
    eq: vi.fn(() => ({ __kind: "eq" })),
    inArray: vi.fn(() => ({ __kind: "inArray" })),
    sql: Object.assign(
      vi.fn((..._: unknown[]) => ({ __kind: "sql" })),
      { raw: vi.fn(() => ({ __kind: "sql" })) },
    ),
  };
});

// ── Imports under test (after mocks) ──────────────────────────────────────

import {
  buildAuthzContextFromUserId,
  serveListMailboxes,
} from "./mcp-list-mailboxes";

function makeEnv() {
  return {
    DB: {} as unknown as D1Database,
    BUCKET: {
      list: vi.fn(async () => ({ objects: r2Objects })),
    } as unknown as R2Bucket,
  };
}

beforeEach(() => {
  queryQueue = [];
  r2Objects = [];
  vi.clearAllMocks();
});

// Helper to enqueue the canonical 4-query sequence (or 3 when no groups)
// that buildAuthzContextFromUserId produces:
//   1. users (get)
//   2. group_members (all)
//   3. mailboxes-by-owner (all)
//   4. mailbox_groups (all) — only when groups non-empty
function enqueueAuthzLookup(opts: {
  user: { id: string; role: string; status: string } | null;
  groups: { group_id: string }[];
  ownMailboxes: { id: string }[];
  groupMailboxes: { mailbox_id: string }[];
}): void {
  queryQueue.push({ kind: "get", result: opts.user });
  if (!opts.user || opts.user.status !== "active") return;
  queryQueue.push({ kind: "all", result: opts.groups });
  queryQueue.push({ kind: "all", result: opts.ownMailboxes });
  if (opts.groups.length > 0) {
    queryQueue.push({ kind: "all", result: opts.groupMailboxes });
  }
}

// ── buildAuthzContextFromUserId ────────────────────────────────────────────

describe("buildAuthzContextFromUserId", () => {
  it("returns null when DB binding is missing", async () => {
    const ctx = await buildAuthzContextFromUserId(
      { DB: undefined } as never,
      "u-alice",
    );
    expect(ctx).toBeNull();
  });

  it("returns null when user is missing", async () => {
    enqueueAuthzLookup({
      user: null,
      groups: [],
      ownMailboxes: [],
      groupMailboxes: [],
    });
    const ctx = await buildAuthzContextFromUserId(
      makeEnv() as never,
      "u-ghost",
    );
    expect(ctx).toBeNull();
  });

  it("returns null when user is not active", async () => {
    enqueueAuthzLookup({
      user: { id: "u-alice", role: "user", status: "disabled" },
      groups: [],
      ownMailboxes: [],
      groupMailboxes: [],
    });
    const ctx = await buildAuthzContextFromUserId(
      makeEnv() as never,
      "u-alice",
    );
    expect(ctx).toBeNull();
  });

  it("unions own + group-shared mailboxes, deduped", async () => {
    enqueueAuthzLookup({
      user: { id: "u-alice", role: "user", status: "active" },
      groups: [{ group_id: "g-marketing" }],
      ownMailboxes: [{ id: "mb-1" }, { id: "mb-2" }],
      groupMailboxes: [{ mailbox_id: "mb-2" }, { mailbox_id: "mb-3" }],
    });

    const ctx = await buildAuthzContextFromUserId(
      makeEnv() as never,
      "u-alice",
    );

    expect(ctx).not.toBeNull();
    expect(ctx!.user_id).toBe("u-alice");
    expect(ctx!.role).toBe("user");
    expect(ctx!.group_ids).toEqual(["g-marketing"]);
    expect(new Set(ctx!.authorized_mailbox_ids)).toEqual(
      new Set(["mb-1", "mb-2", "mb-3"]),
    );
  });

  it("PAT mailbox_id constraint narrows to the intersection", async () => {
    enqueueAuthzLookup({
      user: { id: "u-alice", role: "user", status: "active" },
      groups: [],
      ownMailboxes: [{ id: "mb-1" }, { id: "mb-2" }],
      groupMailboxes: [],
    });

    const ctx = await buildAuthzContextFromUserId(
      makeEnv() as never,
      "u-alice",
      "mb-2",
    );

    expect(ctx!.authorized_mailbox_ids).toEqual(["mb-2"]);
  });

  it("PAT mailbox_id constraint outside user-authorized set returns []", async () => {
    enqueueAuthzLookup({
      user: { id: "u-alice", role: "user", status: "active" },
      groups: [],
      ownMailboxes: [{ id: "mb-1" }],
      groupMailboxes: [],
    });

    const ctx = await buildAuthzContextFromUserId(
      makeEnv() as never,
      "u-alice",
      "mb-OTHER",
    );

    // Stale PAT — user lost ACL since mint. Must not regrant access.
    expect(ctx!.authorized_mailbox_ids).toEqual([]);
  });

  it("skips group_mailboxes lookup when user has no groups", async () => {
    enqueueAuthzLookup({
      user: { id: "u-alice", role: "user", status: "active" },
      groups: [],
      ownMailboxes: [{ id: "mb-1" }],
      // groupMailboxes intentionally not enqueued — assert no extra .all() fires.
      groupMailboxes: [],
    });

    const ctx = await buildAuthzContextFromUserId(
      makeEnv() as never,
      "u-alice",
    );

    expect(ctx!.authorized_mailbox_ids).toEqual(["mb-1"]);
    // Queue must be drained — no extra mailbox_groups query was made.
    expect(queryQueue).toHaveLength(0);
  });
});

// ── serveListMailboxes ────────────────────────────────────────────────────

async function readJsonRpcResult<T>(r: Response): Promise<T> {
  const body = (await r.json()) as {
    jsonrpc: string;
    id: unknown;
    result: { content: { type: string; text: string }[] };
  };
  expect(body.jsonrpc).toBe("2.0");
  return JSON.parse(body.result.content[0].text) as T;
}

describe("serveListMailboxes", () => {
  it("returns 200 with JSON-RPC envelope echoing the request id", async () => {
    enqueueAuthzLookup({
      user: { id: "u-alice", role: "user", status: "active" },
      groups: [],
      ownMailboxes: [{ id: "mb-1" }],
      groupMailboxes: [],
    });
    // listMailboxes will fetch mailbox rows by id (filtered branch).
    queryQueue.push({
      kind: "all",
      result: [
        {
          id: "mb-1",
          address: "alice@actionnow.ai",
          owner_user_id: "u-alice",
        },
      ],
    });

    const r = await serveListMailboxes(makeEnv() as never, "u-alice", null, 42);

    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toBe("application/json");
    const body = await r.json();
    expect((body as { id: unknown }).id).toBe(42);
    expect((body as { jsonrpc: string }).jsonrpc).toBe("2.0");
  });

  it("returns ONLY the user's authorized mailboxes (closes P0-4)", async () => {
    enqueueAuthzLookup({
      user: { id: "u-alice", role: "user", status: "active" },
      groups: [],
      ownMailboxes: [{ id: "mb-1" }],
      groupMailboxes: [],
    });
    // listMailboxes filters by authorized_mailbox_ids = ["mb-1"]; the D1
    // result is whatever rows the (mocked) inArray query returns. We seed
    // only mb-1 so workspace enumeration would have to come from a code
    // bug — not from the mock leaking unfiltered rows.
    queryQueue.push({
      kind: "all",
      result: [
        {
          id: "mb-1",
          address: "alice@actionnow.ai",
          owner_user_id: "u-alice",
        },
      ],
    });

    const r = await serveListMailboxes(
      makeEnv() as never,
      "u-alice",
      null,
      "rpc-1",
    );

    const payload =
      await readJsonRpcResult<{ id: string; address: string }[]>(r);
    expect(payload).toHaveLength(1);
    expect(payload[0].id).toBe("mb-1");
  });

  it("inactive user returns 200 with empty list (NOT trusted-internal full workspace)", async () => {
    enqueueAuthzLookup({
      user: { id: "u-alice", role: "user", status: "disabled" },
      groups: [],
      ownMailboxes: [],
      groupMailboxes: [],
    });
    // No further queries enqueued — the synthesised empty authzContext
    // takes the "authorized_mailbox_ids.length === 0 → d1Rows=[]" branch.

    const r = await serveListMailboxes(makeEnv() as never, "u-alice", null, 1);

    expect(r.status).toBe(200);
    const payload = await readJsonRpcResult<unknown[]>(r);
    // Audit P0-4: ON FAILURE TO BUILD AUTHZ, return empty — never fall
    // through to "trusted internal caller, return everything".
    expect(payload).toEqual([]);
  });

  it("PAT mailbox_id constraint narrows the result to {[constraint]}", async () => {
    enqueueAuthzLookup({
      user: { id: "u-alice", role: "user", status: "active" },
      groups: [],
      ownMailboxes: [{ id: "mb-1" }, { id: "mb-2" }],
      groupMailboxes: [],
    });
    // After PAT-narrowing, authorized_mailbox_ids = ["mb-2"]; D1 returns
    // only the mb-2 row (the mock honors the inArray filter implicitly via
    // the test's seed).
    queryQueue.push({
      kind: "all",
      result: [
        {
          id: "mb-2",
          address: "alias@actionnow.ai",
          owner_user_id: "u-alice",
        },
      ],
    });

    const r = await serveListMailboxes(
      makeEnv() as never,
      "u-alice",
      "mb-2",
      1,
    );

    const payload = await readJsonRpcResult<{ id: string }[]>(r);
    expect(payload).toHaveLength(1);
    expect(payload[0].id).toBe("mb-2");
  });
});
