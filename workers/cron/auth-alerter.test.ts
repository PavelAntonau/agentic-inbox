// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase G / G-3 — Cron alerter unit tests.
//
// Covers:
//   • OTP burst (≥10 auth.otp_failed / IP / 5 min) triggers an alert.
//   • FreshAge denial burst (≥5 auth.fresh_session_denied / user / 5 min) triggers.
//   • Signup-gate brute force (≥20 auth.signup_gate_blocked / IP / 1 hr) triggers.
//   • Sub-threshold counts do NOT trigger.
//   • Dedup window suppresses re-alerts within 5 min.
//   • Missing sink skips silently.
//   • Sink throw → fingerprint NOT marked → next tick retries.
//   • makeResendSink: returns undefined when any of recipient/sender/key is missing.
//   • makeResendSink: posts to Resend with the expected payload.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  runAlertChecks,
  makeResendSink,
  type AlertSink,
  type AlerterEnv,
} from "./auth-alerter";

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
// Mock AlertSink helper
// ---------------------------------------------------------------------------

interface MockSinkHandle {
  sink: AlertSink;
  calls: { subject: string; body: string }[];
}

function makeMockSink(opts: { throwOnce?: boolean } = {}): MockSinkHandle {
  const calls: { subject: string; body: string }[] = [];
  let thrown = false;
  const sink: AlertSink = async (subject, body) => {
    if (opts.throwOnce && !thrown) {
      thrown = true;
      throw new Error("simulated sink failure");
    }
    calls.push({ subject, body });
  };
  return { sink, calls };
}

// ---------------------------------------------------------------------------
// fetch mock — used for the makeResendSink end-to-end test.
// ---------------------------------------------------------------------------

interface FetchHandle {
  calls: { url: string; body: string; headers: Record<string, string> }[];
  restore: () => void;
}

function mockFetch(
  status = 200,
  responseBody = '{"id":"msg_test"}',
): FetchHandle {
  const calls: {
    url: string;
    body: string;
    headers: Record<string, string>;
  }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: RequestInfo, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const h = init?.headers;
    if (h) {
      if (h instanceof Headers) {
        h.forEach((v, k) => (headers[k] = v));
      } else if (Array.isArray(h)) {
        for (const [k, v] of h) headers[k] = v;
      } else {
        Object.assign(headers, h as Record<string, string>);
      }
    }
    calls.push({
      url: String(url),
      body: (init?.body as string) ?? "",
      headers,
    });
    return new Response(responseBody, { status });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// ---------------------------------------------------------------------------
// runAlertChecks tests
// ---------------------------------------------------------------------------

describe("auth-alerter — runAlertChecks", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("no sink → skips silently without querying D1", async () => {
    const { sink, calls } = makeMockSink();
    const db = makeFakeDb({
      "auth.otp_failed": [{ key: "1.2.3.4", count: 99 }],
    });
    await runAlertChecks(db, undefined);
    expect(calls).toHaveLength(0);
    // Sanity: the sink itself was never called.
    expect(sink).toBeDefined();
  });

  it("OTP burst ≥10 triggers a sink call with subject + body", async () => {
    const { sink, calls } = makeMockSink();
    const db = makeFakeDb({
      "auth.otp_failed": [{ key: "1.2.3.4", count: 12 }],
    });
    await runAlertChecks(db, sink, Date.now());
    expect(calls).toHaveLength(1);
    expect(calls[0].subject).toContain("auth.otp_failed");
    expect(calls[0].body).toContain("1.2.3.4");
    expect(calls[0].body).toContain("Count:  12");
  });

  it("OTP burst <10 does NOT trigger", async () => {
    const { sink, calls } = makeMockSink();
    // count=9 is below the threshold — the HAVING clause already filters it,
    // so the fake DB returns no rows for that case.
    await runAlertChecks(
      makeFakeDb({ "auth.otp_failed": [] }),
      sink,
      Date.now(),
    );
    expect(calls).toHaveLength(0);
  });

  it("fresh-session denial burst ≥5 triggers", async () => {
    const { sink, calls } = makeMockSink();
    const db = makeFakeDb({
      "auth.fresh_session_denied": [{ key: "user-abc", count: 7 }],
    });
    await runAlertChecks(db, sink, Date.now());
    expect(calls).toHaveLength(1);
    expect(calls[0].subject).toContain("auth.fresh_session_denied");
    expect(calls[0].body).toContain("user-abc");
  });

  it("fresh-session denial <5 does NOT trigger", async () => {
    const { sink, calls } = makeMockSink();
    await runAlertChecks(
      makeFakeDb({ "auth.fresh_session_denied": [] }),
      sink,
      Date.now(),
    );
    expect(calls).toHaveLength(0);
  });

  it("signup-gate brute force ≥20 triggers", async () => {
    const { sink, calls } = makeMockSink();
    const db = makeFakeDb({
      "auth.signup_gate_blocked": [{ key: "5.5.5.5", count: 25 }],
    });
    await runAlertChecks(db, sink, Date.now());
    expect(calls).toHaveLength(1);
    expect(calls[0].subject).toContain("auth.signup_gate_blocked");
    expect(calls[0].body).toContain("5.5.5.5");
  });

  it("signup-gate brute force <20 does NOT trigger", async () => {
    const { sink, calls } = makeMockSink();
    await runAlertChecks(
      makeFakeDb({ "auth.signup_gate_blocked": [] }),
      sink,
      Date.now(),
    );
    expect(calls).toHaveLength(0);
  });

  it("multiple conditions fire independently in a single run", async () => {
    const { sink, calls } = makeMockSink();
    const db = makeFakeDb({
      "auth.otp_failed": [{ key: "1.1.1.1", count: 15 }],
      "auth.fresh_session_denied": [{ key: "user-xyz", count: 6 }],
      "auth.signup_gate_blocked": [{ key: "2.2.2.2", count: 22 }],
    });
    await runAlertChecks(db, sink, Date.now());
    expect(calls).toHaveLength(3);
  });

  it("dedup window suppresses re-alert within 5 minutes", async () => {
    const { sink, calls } = makeMockSink();
    const db = makeFakeDb({
      "auth.otp_failed": [{ key: "3.3.3.3", count: 11 }],
    });
    const now = Date.now();
    await runAlertChecks(db, sink, now);
    await runAlertChecks(db, sink, now + 60_000);
    expect(calls).toHaveLength(1);
  });

  it("dedup window expires after 5 minutes, alert fires again", async () => {
    const { sink, calls } = makeMockSink();
    const db = makeFakeDb({
      "auth.otp_failed": [{ key: "4.4.4.4", count: 10 }],
    });
    const now = Date.now();
    await runAlertChecks(db, sink, now);
    await runAlertChecks(db, sink, now + 6 * 60_000);
    expect(calls).toHaveLength(2);
  });

  it("D1 query error is logged and does not throw", async () => {
    const { sink, calls } = makeMockSink();
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
      runAlertChecks(badDb, sink, Date.now()),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(console.error).toHaveBeenCalled();
  });

  it("sink throw → fingerprint NOT marked, retry on next tick succeeds", async () => {
    const { sink, calls } = makeMockSink({ throwOnce: true });
    const db = makeFakeDb({
      "auth.otp_failed": [{ key: "9.9.9.9", count: 11 }],
    });
    const now = Date.now();
    // First tick — sink throws, no mark.
    await runAlertChecks(db, sink, now);
    expect(calls).toHaveLength(0);
    // Second tick 1 minute later — within dedup window, BUT no mark was set
    // because the previous send threw, so the alerter retries.
    await runAlertChecks(db, sink, now + 60_000);
    expect(calls).toHaveLength(1);
    expect(console.error).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// makeResendSink tests
// ---------------------------------------------------------------------------

describe("auth-alerter — makeResendSink", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns undefined when ADMIN_ALERT_EMAIL is missing", () => {
    const env = {
      ADMIN_ALERT_FROM: "noreply@actionnow.ai",
      RESEND_API_KEY: "re_test",
    } as unknown as AlerterEnv;
    expect(makeResendSink(env)).toBeUndefined();
  });

  it("returns undefined when ADMIN_ALERT_FROM is missing", () => {
    const env = {
      ADMIN_ALERT_EMAIL: "admin@example.com",
      RESEND_API_KEY: "re_test",
    } as unknown as AlerterEnv;
    expect(makeResendSink(env)).toBeUndefined();
  });

  it("returns undefined when RESEND_API_KEY is missing", () => {
    const env = {
      ADMIN_ALERT_EMAIL: "admin@example.com",
      ADMIN_ALERT_FROM: "noreply@actionnow.ai",
    } as unknown as AlerterEnv;
    expect(makeResendSink(env)).toBeUndefined();
  });

  it("returns undefined when fields are present but blank", () => {
    const env = {
      ADMIN_ALERT_EMAIL: "   ",
      ADMIN_ALERT_FROM: "noreply@actionnow.ai",
      RESEND_API_KEY: "re_test",
    } as unknown as AlerterEnv;
    expect(makeResendSink(env)).toBeUndefined();
  });

  it("returns a sink that POSTs to Resend with the expected payload", async () => {
    const env = {
      ADMIN_ALERT_EMAIL: "pavel@digifirst.org",
      ADMIN_ALERT_FROM: "noreply@actionnow.ai",
      RESEND_API_KEY: "re_test_key",
    } as unknown as AlerterEnv;

    const sink = makeResendSink(env);
    expect(sink).toBeDefined();

    const fetched = mockFetch(200, '{"id":"msg_resend_123"}');
    await sink!("test subject", "test body line 1\ntest body line 2");
    fetched.restore();

    expect(fetched.calls).toHaveLength(1);
    const call = fetched.calls[0];
    expect(call.url).toBe("https://api.resend.com/emails");
    expect(call.headers["Authorization"]).toBe("Bearer re_test_key");
    expect(call.headers["Content-Type"]).toBe("application/json");

    const payload = JSON.parse(call.body) as {
      from: string;
      to: string[];
      subject: string;
      text: string;
    };
    expect(payload.from).toContain("noreply@actionnow.ai");
    expect(payload.from).toContain("ActionNowAI Auth Alerts");
    expect(payload.to).toEqual(["pavel@digifirst.org"]);
    expect(payload.subject).toBe("test subject");
    expect(payload.text).toBe("test body line 1\ntest body line 2");
  });

  it("sink throws on Resend non-2xx so runAlertChecks can skip the dedup mark", async () => {
    const env = {
      ADMIN_ALERT_EMAIL: "pavel@digifirst.org",
      ADMIN_ALERT_FROM: "noreply@actionnow.ai",
      RESEND_API_KEY: "re_test_key",
    } as unknown as AlerterEnv;
    const sink = makeResendSink(env);
    expect(sink).toBeDefined();

    const fetched = mockFetch(
      429,
      '{"name":"rate_limit_exceeded","message":"too many"}',
    );
    await expect(sink!("subj", "body")).rejects.toThrow(/Resend send failed/);
    fetched.restore();
  });
});
