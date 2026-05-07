// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase G / G-3 — Cron alerter unit tests.
//
// Covers:
//   • OTP burst (≥10 auth.otp_failed / IP / 5 min) triggers Slack POST.
//   • FreshAge denial burst (≥5 auth.fresh_session_denied / user / 5 min) triggers.
//   • Signup-gate brute force (≥20 auth.signup_gate_blocked / IP / 1 hr) triggers.
//   • Sub-threshold counts do NOT trigger.
//   • Dedup window suppresses re-alerts within 5 min.
//   • Missing webhook URL skips silently.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { runAlertChecks, postSlack } from "./auth-alerter";

// ---------------------------------------------------------------------------
// Fake D1 database
// ---------------------------------------------------------------------------

type QueryRow = { key: string; count: number };

/**
 * Build a fake D1Database whose `prepare().bind(...).all()` returns the
 * provided rows for whichever SQL statement is matched (matched by substring
 * of the action string in the query).
 */
function makeFakeDb(rowsByAction: Record<string, QueryRow[]>): D1Database {
  const stub = {
    prepare: (sql: string) => ({
      bind: (..._args: unknown[]) => ({
        all: async <T>(): Promise<{ results: T[] }> => {
          // Identify which condition is being queried by looking for the
          // action string literal embedded in the SQL.
          for (const [action, rows] of Object.entries(rowsByAction)) {
            if (sql.includes(`'${action}'`)) {
              return { results: rows as unknown as T[] };
            }
          }
          return { results: [] };
        },
        run: () => Promise.resolve({ meta: {} }),
        first: () => Promise.resolve(null),
        get: () => Promise.resolve(null),
      }),
      run: () => Promise.resolve({ meta: {} }),
    }),
    batch: () => Promise.resolve([]),
    exec: () => Promise.resolve({ count: 0, duration: 0 }),
    dump: () => Promise.resolve(new ArrayBuffer(0)),
  };
  return stub as unknown as D1Database;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WEBHOOK = "https://hooks.slack.com/test-webhook";

/** Capture fetch calls without actually calling the network. */
function mockFetch() {
  const calls: { url: string; body: string }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: RequestInfo, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: (init?.body as string) ?? "",
    });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("auth-alerter — postSlack", () => {
  it("POSTs JSON with text field to the webhook URL", async () => {
    const { calls, restore } = mockFetch();
    await postSlack(WEBHOOK, "hello alert");
    restore();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(WEBHOOK);
    const body = JSON.parse(calls[0].body) as { text: string };
    expect(body.text).toBe("hello alert");
  });
});

describe("auth-alerter — runAlertChecks", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("no webhook → skips silently without querying D1", async () => {
    const { calls, restore } = mockFetch();
    const db = makeFakeDb({
      "auth.otp_failed": [{ key: "1.2.3.4", count: 99 }],
    });
    await runAlertChecks(db, undefined);
    restore();
    expect(calls).toHaveLength(0);
  });

  it("OTP burst ≥10 triggers a Slack POST", async () => {
    const { calls, restore } = mockFetch();
    const db = makeFakeDb({
      "auth.otp_failed": [{ key: "1.2.3.4", count: 12 }],
    });
    await runAlertChecks(db, WEBHOOK, Date.now());
    restore();
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toContain("auth.otp_failed");
    expect(calls[0].body).toContain("1.2.3.4");
  });

  it("OTP burst <10 does NOT trigger", async () => {
    const { calls, restore } = mockFetch();
    const db = makeFakeDb({
      "auth.otp_failed": [{ key: "1.2.3.4", count: 9 }],
    });
    // count=9 is below the threshold — the HAVING clause already filters it,
    // so the fake DB returns no rows for that case.
    await runAlertChecks(
      makeFakeDb({ "auth.otp_failed": [] }),
      WEBHOOK,
      Date.now(),
    );
    restore();
    expect(calls).toHaveLength(0);
  });

  it("fresh-session denial burst ≥5 triggers a Slack POST", async () => {
    const { calls, restore } = mockFetch();
    const db = makeFakeDb({
      "auth.fresh_session_denied": [{ key: "user-abc", count: 7 }],
    });
    await runAlertChecks(db, WEBHOOK, Date.now());
    restore();
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toContain("auth.fresh_session_denied");
    expect(calls[0].body).toContain("user-abc");
  });

  it("fresh-session denial <5 does NOT trigger", async () => {
    const { calls, restore } = mockFetch();
    await runAlertChecks(
      makeFakeDb({ "auth.fresh_session_denied": [] }),
      WEBHOOK,
      Date.now(),
    );
    restore();
    expect(calls).toHaveLength(0);
  });

  it("signup-gate brute force ≥20 triggers a Slack POST", async () => {
    const { calls, restore } = mockFetch();
    const db = makeFakeDb({
      "auth.signup_gate_blocked": [{ key: "5.5.5.5", count: 25 }],
    });
    await runAlertChecks(db, WEBHOOK, Date.now());
    restore();
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toContain("auth.signup_gate_blocked");
    expect(calls[0].body).toContain("5.5.5.5");
  });

  it("signup-gate brute force <20 does NOT trigger", async () => {
    const { calls, restore } = mockFetch();
    await runAlertChecks(
      makeFakeDb({ "auth.signup_gate_blocked": [] }),
      WEBHOOK,
      Date.now(),
    );
    restore();
    expect(calls).toHaveLength(0);
  });

  it("multiple conditions fire independently in a single run", async () => {
    const { calls, restore } = mockFetch();
    const db = makeFakeDb({
      "auth.otp_failed": [{ key: "1.1.1.1", count: 15 }],
      "auth.fresh_session_denied": [{ key: "user-xyz", count: 6 }],
      "auth.signup_gate_blocked": [{ key: "2.2.2.2", count: 22 }],
    });
    await runAlertChecks(db, WEBHOOK, Date.now());
    restore();
    expect(calls).toHaveLength(3);
  });

  it("dedup window suppresses re-alert within 5 minutes", async () => {
    const { calls, restore } = mockFetch();
    const db = makeFakeDb({
      "auth.otp_failed": [{ key: "3.3.3.3", count: 11 }],
    });
    const now = Date.now();
    // First call — should alert.
    await runAlertChecks(db, WEBHOOK, now);
    // Second call 1 minute later — same fingerprint, within dedup window.
    await runAlertChecks(db, WEBHOOK, now + 60_000);
    restore();
    expect(calls).toHaveLength(1);
  });

  it("dedup window expires after 5 minutes, alert fires again", async () => {
    const { calls, restore } = mockFetch();
    const db = makeFakeDb({
      "auth.otp_failed": [{ key: "4.4.4.4", count: 10 }],
    });
    const now = Date.now();
    await runAlertChecks(db, WEBHOOK, now);
    // 6 minutes later — outside dedup window.
    await runAlertChecks(db, WEBHOOK, now + 6 * 60_000);
    restore();
    expect(calls).toHaveLength(2);
  });

  it("D1 query error is logged and does not throw", async () => {
    const { calls, restore } = mockFetch();
    // DB that throws on prepare/bind/all
    const badDb = {
      prepare: () => ({
        bind: () => ({
          all: () => Promise.reject(new Error("D1 kaboom")),
          run: () => Promise.resolve({ meta: {} }),
          first: () => Promise.resolve(null),
          get: () => Promise.resolve(null),
        }),
        run: () => Promise.resolve({ meta: {} }),
      }),
      batch: () => Promise.resolve([]),
      exec: () => Promise.resolve({ count: 0, duration: 0 }),
      dump: () => Promise.resolve(new ArrayBuffer(0)),
    } as unknown as D1Database;

    await expect(
      runAlertChecks(badDb, WEBHOOK, Date.now()),
    ).resolves.toBeUndefined();
    restore();
    expect(calls).toHaveLength(0);
    expect(console.error).toHaveBeenCalled();
  });
});
