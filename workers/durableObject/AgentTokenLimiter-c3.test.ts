// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { describe, it, expect, beforeEach, vi } from "vitest";
import { AgentTokenLimiter } from "./AgentTokenLimiter";

function makeDurableObjectStub() {
  const store = new Map<string, unknown>();
  const storage = {
    get: vi.fn(async <T>(key: string): Promise<T | undefined> => {
      return store.get(key) as T | undefined;
    }),
    put: vi.fn(async (key: string, value: unknown): Promise<void> => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string): Promise<void> => {
      store.delete(key);
    }),
  };
  return {
    ctx: { storage } as unknown as DurableObjectState,
    env: {} as Env,
    storage,
    store,
  };
}

describe("AgentTokenLimiter HTTP body validation (C3.21)", () => {
  let limiter: AgentTokenLimiter;
  let harness: ReturnType<typeof makeDurableObjectStub>;

  beforeEach(() => {
    harness = makeDurableObjectStub();
    limiter = new AgentTokenLimiter(harness.ctx, harness.env);
  });

  const post = (body: unknown) =>
    limiter.fetch(
      new Request("http://do/register", {
        method: "POST",
        body: typeof body === "string" ? body : JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      }),
    );

  it("400s on max_instances=0", async () => {
    const res = await post({ fingerprint: "fp-A", max_instances: 0 });
    expect(res.status).toBe(400);
  });

  it("400s on max_instances=-1", async () => {
    const res = await post({ fingerprint: "fp-A", max_instances: -1 });
    expect(res.status).toBe(400);
  });

  it("400s on non-integer max_instances", async () => {
    const res = await post({ fingerprint: "fp-A", max_instances: 1.5 });
    expect(res.status).toBe(400);
  });

  it("400s on max_instances as a string", async () => {
    const res = await post({ fingerprint: "fp-A", max_instances: "5" });
    expect(res.status).toBe(400);
  });

  it("400s on missing fingerprint", async () => {
    const res = await post({ max_instances: 3 });
    expect(res.status).toBe(400);
  });

  it("400s on empty fingerprint", async () => {
    const res = await post({ fingerprint: "", max_instances: 3 });
    expect(res.status).toBe(400);
  });

  it("400s on overlong fingerprint (>256 chars)", async () => {
    const res = await post({
      fingerprint: "a".repeat(257),
      max_instances: 3,
    });
    expect(res.status).toBe(400);
  });

  it("400s on negative idle_prune_ms", async () => {
    const res = await post({
      fingerprint: "fp-A",
      max_instances: 3,
      idle_prune_ms: -10,
    });
    expect(res.status).toBe(400);
  });

  it("400s on non-integer idle_prune_ms", async () => {
    const res = await post({
      fingerprint: "fp-A",
      max_instances: 3,
      idle_prune_ms: 1.5,
    });
    expect(res.status).toBe(400);
  });

  it("400s on invalid JSON body", async () => {
    const res = await post("not json");
    expect(res.status).toBe(400);
  });

  it("400s on null body", async () => {
    const res = await post(null);
    expect(res.status).toBe(400);
  });

  it("accepts valid input (regression — happy path still works)", async () => {
    const res = await post({ fingerprint: "fp-A", max_instances: 3 });
    expect(res.status).toBe(200);
  });

  it("accepts max_instances=1 (boundary)", async () => {
    const res = await post({ fingerprint: "fp-A", max_instances: 1 });
    expect(res.status).toBe(200);
  });

  it("/prune validates idle_ms shape (C3.21)", async () => {
    const bad = await limiter.fetch(
      new Request("http://do/prune", {
        method: "POST",
        body: JSON.stringify({ idle_ms: "not a number" }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(bad.status).toBe(400);

    const good = await limiter.fetch(
      new Request("http://do/prune", {
        method: "POST",
        body: JSON.stringify({ idle_ms: 60_000 }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(good.status).toBe(200);
  });
});
