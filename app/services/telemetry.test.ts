// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { describe, it, expect, vi, afterEach } from "vitest";
import { track } from "./telemetry";

describe("telemetry — track()", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits a single console.info line tagged [telemetry]", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    track("turnstile", "mount.success", { elapsed_ms: 1234 });
    expect(spy).toHaveBeenCalledTimes(1);
    const [prefix, payload] = spy.mock.calls[0];
    expect(prefix).toBe("[telemetry]");
    const obj = JSON.parse(payload as string);
    expect(obj).toMatchObject({
      topic: "turnstile",
      event: "mount.success",
      elapsed_ms: 1234,
    });
    expect(typeof obj.ts).toBe("number");
  });

  it("works without attrs", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    track("turnstile", "expired");
    const obj = JSON.parse(spy.mock.calls[0][1] as string);
    expect(obj.topic).toBe("turnstile");
    expect(obj.event).toBe("expired");
  });

  it("never throws when the sink throws (telemetry must not break a feature)", () => {
    vi.spyOn(console, "info").mockImplementation(() => {
      throw new Error("sink crashed");
    });
    expect(() => track("any", "any")).not.toThrow();
  });

  it("preserves primitive attribute values verbatim", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    track("auth", "resend.no-token", {
      configured: true,
      attempt_count: 3,
      reason: "missing-token",
      previous_token: null,
    });
    const obj = JSON.parse(spy.mock.calls[0][1] as string);
    expect(obj.configured).toBe(true);
    expect(obj.attempt_count).toBe(3);
    expect(obj.reason).toBe("missing-token");
    expect(obj.previous_token).toBeNull();
  });
});
