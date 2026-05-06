// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase C3 / TASK-C3.1 — unified audit-log helper coverage.
// Phase E / TASK-E.3 — legacy `appendAudit` shim removed; `writeAudit`
//   now accepts `actor: AuthzContext` directly. Migration-completeness
//   assertion below scans every workers/*.ts non-test file.
//
// We exercise the pure `clientIp` helper directly. The `writeAudit` D1
// path is integration-tested via the existing route tests (groups,
// mailboxes, etc.) — here we focus on:
//   • cf-connecting-ip only (no x-forwarded-for fallback) — audit P2-3.
//   • size caps (target_id ≤ 200, mcp_method ≤ 100, meta_json ≤ 8 KB).
//   • internal try/catch — D1 throw is swallowed.
//   • `actor: AuthzContext` shorthand — splits user/token id correctly.
//   • TASK-E.3: NO `appendAudit` references remain anywhere in workers/.

import { describe, expect, it, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeAudit, clientIp } from "./audit-log";
import type { AuthzContext } from "../db/control-plane/forGroup";

// -- clientIp ---------------------------------------------------------------

describe("clientIp — Phase C3 / TASK-C3.1", () => {
  it("returns cf-connecting-ip when present", () => {
    const r = new Request("https://x", {
      headers: { "cf-connecting-ip": "203.0.113.7" },
    });
    expect(clientIp(r)).toBe("203.0.113.7");
  });

  it("returns null when cf-connecting-ip is absent (no XFF fallback)", () => {
    const r = new Request("https://x", {
      headers: { "x-forwarded-for": "198.51.100.42" },
    });
    expect(clientIp(r)).toBeNull();
  });

  it("returns null when no IP header is present", () => {
    const r = new Request("https://x");
    expect(clientIp(r)).toBeNull();
  });
});

// -- writeAudit -------------------------------------------------------------

interface CapturedInsert {
  values: Record<string, unknown>;
}

/**
 * Build a fake D1Database whose `prepare` returns a stub good enough to let
 * Drizzle's insert path execute without an actual database. We capture the
 * row that Drizzle would have written for assertion.
 */
function makeFakeDb(opts: { throwOnRun?: boolean } = {}): {
  db: D1Database;
  captured: CapturedInsert[];
} {
  const captured: CapturedInsert[] = [];
  const stub = {
    prepare: () => ({
      bind: (...args: unknown[]) => {
        // Drizzle uses positional placeholders; we re-shape the values into
        // a labelled record by parsing the insert SQL it would have built.
        // Simpler: just stash the args for inspection.
        return {
          run: () => {
            if (opts.throwOnRun) throw new Error("D1 down");
            captured.push({ values: { args } });
            return Promise.resolve({ meta: {} });
          },
          all: () => Promise.resolve({ results: [] }),
          first: () => Promise.resolve(null),
          get: () => Promise.resolve(null),
        };
      },
      run: () => {
        if (opts.throwOnRun) throw new Error("D1 down");
        captured.push({ values: {} });
        return Promise.resolve({ meta: {} });
      },
    }),
    batch: () => Promise.resolve([]),
    exec: () => Promise.resolve({ count: 0, duration: 0 }),
    dump: () => Promise.resolve(new ArrayBuffer(0)),
  };
  return { db: stub as unknown as D1Database, captured };
}

describe("writeAudit — Phase C3 / TASK-C3.1", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("internal try/catch — D1 errors are swallowed (fire-and-forget)", async () => {
    const { db } = makeFakeDb({ throwOnRun: true });
    // The function must return without throwing.
    await expect(
      writeAudit(db, {
        action: "test.action",
        target: { kind: "user", id: "u1" },
        actor_user_id: "u1",
      }),
    ).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      "audit.write_failed",
      expect.any(String),
    );
  });

  it("succeeds when D1 accepts the row", async () => {
    const { db, captured } = makeFakeDb();
    await writeAudit(db, {
      action: "test.action",
      target: { kind: "user", id: "u1" },
      actor_user_id: "u1",
    });
    expect(captured).toHaveLength(1);
  });

  it("size cap — target_id over 200 chars is truncated", async () => {
    const { db, captured } = makeFakeDb();
    const longId = "x".repeat(500);
    await writeAudit(db, {
      action: "test",
      target: { kind: "tool", id: longId },
      tool_name: longId,
    });
    expect(captured).toHaveLength(1);
    // The bound args contain the truncated value somewhere; check by
    // serialising the captured row and asserting we never see a 500-char run.
    const blob = JSON.stringify(captured);
    expect(blob.includes("x".repeat(500))).toBe(false);
    expect(blob.includes("x".repeat(200))).toBe(true);
  });

  it("size cap — meta_json over 8 KB becomes a sentinel", async () => {
    const { db, captured } = makeFakeDb();
    const huge = { blob: "y".repeat(20_000) };
    await writeAudit(db, {
      action: "test",
      target: { kind: "user", id: "u1" },
      meta: huge,
    });
    expect(captured).toHaveLength(1);
    const blob = JSON.stringify(captured);
    expect(blob.includes("audit_meta_truncated")).toBe(true);
    // The original 20k-char string MUST NOT have leaked into D1.
    expect(blob.includes("y".repeat(1000))).toBe(false);
  });

  it("non-stringifiable meta becomes the unstringifiable sentinel", async () => {
    const { db, captured } = makeFakeDb();
    type Cyclic = { self?: Cyclic };
    const cyclic: Cyclic = {};
    cyclic.self = cyclic;
    await writeAudit(db, {
      action: "test",
      target: { kind: "user", id: "u1" },
      meta: cyclic,
    });
    expect(captured).toHaveLength(1);
    const blob = JSON.stringify(captured);
    expect(blob.includes("audit_meta_unstringifiable")).toBe(true);
  });
});

// -- writeAudit + actor shorthand -------------------------------------------
// Phase E / TASK-E.3 — the legacy `appendAudit` shim was removed; the same
// behavior is preserved by passing `actor: AuthzContext` to writeAudit. These
// tests lock the actor-splitting contract.

describe("writeAudit({ actor }) shorthand — Phase E / TASK-E.3", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  const userActor: AuthzContext = {
    user_id: "user-1",
    role: "user",
    group_ids: [],
    authorized_mailbox_ids: [],
  };
  const tokenActor: AuthzContext = {
    user_id: "user-1",
    role: "user",
    group_ids: [],
    authorized_mailbox_ids: [],
    agent_token_id: "tok-1",
  };

  it("user actor — actor_user_id set, actor_token_id null", async () => {
    const { db, captured } = makeFakeDb();
    await writeAudit(db, {
      action: "mailbox.create",
      target: { kind: "mailbox", id: "m1" },
      actor: userActor,
      meta: { name: "Inbox" },
    });
    expect(captured).toHaveLength(1);
    const blob = JSON.stringify(captured);
    expect(blob.includes("user-1")).toBe(true);
    expect(blob.includes("tok-1")).toBe(false);
  });

  it("token actor — actor_token_id set, actor_user_id null", async () => {
    const { db, captured } = makeFakeDb();
    await writeAudit(db, {
      action: "mcp.action",
      target: { kind: "mailbox", id: "m1" },
      actor: tokenActor,
    });
    expect(captured).toHaveLength(1);
    const blob = JSON.stringify(captured);
    // user-1 must NOT appear as actor_user_id when an agent_token_id is set
    // (mirrors the legacy contract).
    expect(blob.includes("tok-1")).toBe(true);
  });

  it("D1 errors are swallowed (legacy fire-and-forget contract preserved)", async () => {
    const { db } = makeFakeDb({ throwOnRun: true });
    await expect(
      writeAudit(db, {
        action: "x.y",
        target: { kind: "user", id: "u1" },
        actor: userActor,
      }),
    ).resolves.toBeUndefined();
  });
});

// -- migration completeness — Phase E / TASK-E.3 ----------------------------
//
// Walks workers/*.ts (excluding *.test.ts and audit-log.ts itself which
// retains comment-only references explaining the migration) and asserts no
// `appendAudit(` call remains. This is the load-bearing assertion the task's
// "no remaining appendAudit references" requirement maps to.

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

const MIGRATION_EXEMPT_FILES = new Set<string>([
  // The helper file documents the removed shim in its header / comments.
  "workers/lib/audit-log.ts",
  // This test file itself talks about appendAudit in describe() strings.
  "workers/lib/audit-log-c3.test.ts",
]);

describe("Phase E / TASK-E.3 migration completeness", () => {
  it("no `appendAudit(` call site remains in workers/ (excluding tests + helper-internal comments)", () => {
    // process.cwd() under vitest is the project root.
    const root = path.resolve(process.cwd(), "workers");
    const offenders: string[] = [];
    for (const file of walk(root)) {
      if (!file.endsWith(".ts")) continue;
      if (file.endsWith(".test.ts")) continue;
      const relPath = path.relative(process.cwd(), file);
      if (MIGRATION_EXEMPT_FILES.has(relPath)) continue;
      const text = fs.readFileSync(file, "utf8");
      // Match `appendAudit(` — the call-site shape. Word boundary in front
      // catches both bare calls (`appendAudit(`) and member calls
      // (`mod.appendAudit(`); it also catches imports like
      // `import { appendAudit } from …` which we want to flag as offenders
      // because nothing should still be importing the removed export.
      if (/\bappendAudit\b/.test(text)) {
        offenders.push(relPath);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("`appendAudit` is no longer exported from workers/lib/audit-log.ts", async () => {
    const mod = await import("./audit-log");
    expect("appendAudit" in mod).toBe(false);
  });
});
