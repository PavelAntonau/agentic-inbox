// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase C3 / TASK-C3.12 — bypass-mode safety helpers (audit P2-6).

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  isBypassPermitted,
  logBypassWarningOnce,
} from "./cloudflare-access-policy";

describe("isBypassPermitted — Phase C3 / TASK-C3.12", () => {
  it("permits bypass on localhost", () => {
    expect(isBypassPermitted("http://localhost:8787/")).toBe(true);
  });

  it("permits bypass on 127.0.0.1", () => {
    expect(isBypassPermitted("http://127.0.0.1:8787/api/foo")).toBe(true);
  });

  it("permits bypass on a custom dev hostname", () => {
    expect(isBypassPermitted("https://dev.actionnow.ai/")).toBe(true);
  });

  it("REFUSES bypass on the production hostname mail.actionnow.ai", () => {
    expect(isBypassPermitted("https://mail.actionnow.ai/")).toBe(false);
  });

  it("REFUSES bypass on the production hostname regardless of path", () => {
    expect(
      isBypassPermitted("https://mail.actionnow.ai/api/v1/mailboxes"),
    ).toBe(false);
  });

  it("refuses bypass on a malformed URL (fail-CLOSED)", () => {
    // The previous fail-OPEN posture would have returned true; isBypassPermitted
    // returns false on URL parse failure so unparseable input cannot bypass.
    expect(isBypassPermitted("not a url")).toBe(false);
  });
});

describe("logBypassWarningOnce — Phase C3 / TASK-C3.12", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("logs the warning at least once when called repeatedly", () => {
    logBypassWarningOnce();
    logBypassWarningOnce();
    logBypassWarningOnce();
    // The "once" guarantee is per-isolate; we can't easily reset it here,
    // but we can assert the warn was triggered (≥1 call).
    expect(console.warn).toHaveBeenCalled();
    const last = (console.warn as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0][0] as string;
    expect(last.toLowerCase()).toContain("cf_access_dev_mode=bypass");
    expect(last).toContain("DISABLED");
  });
});
