// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase G-1 / Task 4 — per-email auth rate-limit unit tests.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { Hono } from "hono";

import { authRateLimitByEmail } from "./auth-rate-limit";
import type { Env } from "../types";

interface Row {
  count: number;
  last_request: number;
}

function makeStubDb(initial: Row | null = null) {
  let row: Row | null = initial;
  const prepared = {
    bind: vi.fn(),
    first: vi.fn(),
    run: vi.fn(),
  };
  prepared.bind.mockImplementation((..._args: unknown[]) => prepared);
  prepared.first.mockImplementation(async () => row);
  prepared.run.mockImplementation(async () => ({}));

  const db = {
    prepare: vi.fn((sql: string) => {
      // Tag the next call so the run() impl can update the in-memory row.
      if (sql.startsWith("INSERT")) {
        prepared.run.mockImplementationOnce(async () => {
          row = { count: 1, last_request: Date.now() };
          return {};
        });
      } else if (sql.startsWith("UPDATE")) {
        prepared.run.mockImplementationOnce(async () => {
          if (row) row = { count: row.count + 1, last_request: Date.now() };
          return {};
        });
      }
      return prepared;
    }),
  } as unknown as Env["DB"];
  return { db, getRow: () => row, setRow: (r: Row | null) => (row = r) };
}

function mkApp(db: Env["DB"]) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", authRateLimitByEmail());
  app.post("/api/auth/email-otp/send-verification-otp", (c) =>
    c.json({ ok: true }),
  );
  return app;
}

const post = (body: unknown) =>
  new Request("http://example.com/api/auth/email-otp/send-verification-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("authRateLimitByEmail (Phase G-1 / T4)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("falls open when no email is in the body", async () => {
    const { db } = makeStubDb();
    const app = mkApp(db);
    const res = await app.request(post({ otp: "123456" }), {}, {
      DB: db,
    } as Env);
    expect(res.status).toBe(200);
  });

  it("permits requests under the per-window cap", async () => {
    const { db } = makeStubDb();
    const app = mkApp(db);
    for (let i = 0; i < 5; i++) {
      const res = await app.request(post({ email: "user@example.com" }), {}, {
        DB: db,
      } as Env);
      expect(res.status).toBe(200);
    }
  });

  it("blocks the 6th request in a window with 429", async () => {
    const { db } = makeStubDb();
    const app = mkApp(db);
    for (let i = 0; i < 5; i++) {
      await app.request(post({ email: "user@example.com" }), {}, {
        DB: db,
      } as Env);
    }
    const res = await app.request(post({ email: "user@example.com" }), {}, {
      DB: db,
    } as Env);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("TOO_MANY_REQUESTS");
    expect(res.headers.get("Retry-After")).toBeDefined();
  });

  it("fails open on D1 errors", async () => {
    const failingDb = {
      prepare: vi.fn(() => ({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockRejectedValue(new Error("D1 boom")),
        run: vi.fn().mockRejectedValue(new Error("D1 boom")),
      })),
    } as unknown as Env["DB"];
    const app = mkApp(failingDb);
    const res = await app.request(post({ email: "user@example.com" }), {}, {
      DB: failingDb,
    } as Env);
    expect(res.status).toBe(200);
  });
});
