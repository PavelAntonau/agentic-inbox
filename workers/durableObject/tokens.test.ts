// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Unit tests for AgentTokenLimiter and RevocationCache DOs.
// Uses vitest with a lightweight in-memory DO harness (no miniflare required).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { AgentTokenLimiter } from "./AgentTokenLimiter";
import { RevocationCache } from "./RevocationCache";

// ---------------------------------------------------------------------------
// Minimal DO test harness — simulates state.storage
// ---------------------------------------------------------------------------

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
    // `any`-typed so the harness can flow into both AgentTokenLimiter (which
    // takes Env) and RevocationCache (which takes its narrower RevocationEnv
    // shape with REVOCATION_CACHE_INTERNAL_TOKEN). Tests cast at the
    // construction site as needed; this dodges the test-only type plumbing.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    env: {} as any,
    storage,
    store,
  };
}

// ---------------------------------------------------------------------------
// AgentTokenLimiter tests
// ---------------------------------------------------------------------------

describe("AgentTokenLimiter", () => {
  let limiter: AgentTokenLimiter;
  let harness: ReturnType<typeof makeDurableObjectStub>;

  beforeEach(() => {
    harness = makeDurableObjectStub();
    limiter = new AgentTokenLimiter(harness.ctx, harness.env);
  });

  it("accepts first instance under cap", async () => {
    const result = await limiter.register("fp-A", 2);
    expect(result.accepted).toBe(true);
    expect(result.current_count).toBe(1);
    expect(result.instance_id).toBeTruthy();
  });

  it("accepts up to max_instances unique fingerprints", async () => {
    await limiter.register("fp-A", 2);
    const result = await limiter.register("fp-B", 2);
    expect(result.accepted).toBe(true);
    expect(result.current_count).toBe(2);
  });

  it("rejects a third unique fingerprint when max_instances=2", async () => {
    await limiter.register("fp-A", 2);
    await limiter.register("fp-B", 2);
    const result = await limiter.register("fp-C", 2);
    expect(result.accepted).toBe(false);
    expect(result.current_count).toBe(2);
    expect(result.instance_id).toBe("");
  });

  it("is idempotent for the same fingerprint (reconnect)", async () => {
    const r1 = await limiter.register("fp-A", 2);
    const r2 = await limiter.register("fp-A", 2);
    expect(r2.accepted).toBe(true);
    expect(r2.instance_id).toBe(r1.instance_id);
    expect(r2.current_count).toBe(1);
  });

  it("enforces max_instances=1 — second fingerprint rejected", async () => {
    await limiter.register("fp-A", 1);
    const result = await limiter.register("fp-B", 1);
    expect(result.accepted).toBe(false);
  });

  it("prune removes idle instances", async () => {
    const r1 = await limiter.register("fp-A", 2);
    expect(r1.accepted).toBe(true);

    // Manually set last_seen_at to past
    const instances = harness.store.get("instances") as Record<
      string,
      { fingerprint: string; last_seen_at: number }
    >;
    instances[r1.instance_id].last_seen_at = Date.now() - 60_000;
    harness.store.set("instances", instances);

    // Force reload
    const harness2 = makeDurableObjectStub();
    harness2.storage.get.mockImplementation(async (key: string) => {
      return harness.store.get(key);
    });
    harness2.storage.put.mockImplementation(
      async (key: string, value: unknown) => {
        harness.store.set(key, value);
      },
    );
    const limiter2 = new AgentTokenLimiter(harness2.ctx, harness2.env);

    const removed = await limiter2.prune(30_000); // prune idle > 30s
    expect(removed).toBe(1);
  });

  it("revoke clears all instances", async () => {
    await limiter.register("fp-A", 2);
    await limiter.register("fp-B", 2);
    await limiter.revoke();
    const snap = await limiter.snapshot();
    expect(snap).toHaveLength(0);
  });

  it("persists and reloads instances across construction", async () => {
    const r = await limiter.register("fp-A", 2);
    // Construct a fresh instance against same storage
    const harness2 = makeDurableObjectStub();
    harness2.storage.get.mockImplementation(async (key: string) => {
      return harness.store.get(key);
    });
    harness2.storage.put.mockImplementation(
      async (key: string, value: unknown) => {
        harness.store.set(key, value);
      },
    );
    const limiter2 = new AgentTokenLimiter(harness2.ctx, harness2.env);
    const snap = await limiter2.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].instance_id).toBe(r.instance_id);
  });

  it("HTTP /register returns RegisterResult JSON", async () => {
    const res = await limiter.fetch(
      new Request("http://do/register", {
        method: "POST",
        body: JSON.stringify({ fingerprint: "fp-A", max_instances: 3 }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(200);
    const data = await res.json<{ accepted: boolean }>();
    expect(data.accepted).toBe(true);
  });

  it("HTTP /revoke clears instances", async () => {
    await limiter.register("fp-A", 2);
    const res = await limiter.fetch(
      new Request("http://do/revoke", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    expect(await limiter.snapshot()).toHaveLength(0);
  });

  it("HTTP unknown path → 404", async () => {
    const res = await limiter.fetch(
      new Request("http://do/unknown", { method: "GET" }),
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// RevocationCache tests
// ---------------------------------------------------------------------------

describe("RevocationCache", () => {
  let cache: RevocationCache;
  let harness: ReturnType<typeof makeDurableObjectStub>;

  beforeEach(() => {
    harness = makeDurableObjectStub();
    cache = new RevocationCache(harness.ctx, harness.env);
  });

  it("isRevoked returns false for unknown client_id", async () => {
    expect(await cache.isRevoked("client-X")).toBe(false);
  });

  it("revoke marks a client_id as revoked", async () => {
    await cache.revoke("client-A");
    expect(await cache.isRevoked("client-A")).toBe(true);
  });

  it("isRevoked returns false for different client_id", async () => {
    await cache.revoke("client-A");
    expect(await cache.isRevoked("client-B")).toBe(false);
  });

  it("unrevoke removes from revoked set", async () => {
    await cache.revoke("client-A");
    await cache.unrevoke("client-A");
    expect(await cache.isRevoked("client-A")).toBe(false);
  });

  it("snapshot returns all revoked client IDs", async () => {
    await cache.revoke("client-A");
    await cache.revoke("client-B");
    const snap = await cache.snapshot();
    expect(snap).toContain("client-A");
    expect(snap).toContain("client-B");
    expect(snap).toHaveLength(2);
  });

  it("persists revocations across construction", async () => {
    await cache.revoke("client-A");
    // Fresh instance with same storage
    const harness2 = makeDurableObjectStub();
    harness2.storage.get.mockImplementation(async (key: string) => {
      return harness.store.get(key);
    });
    harness2.storage.put.mockImplementation(
      async (key: string, value: unknown) => {
        harness.store.set(key, value);
      },
    );
    const cache2 = new RevocationCache(harness2.ctx, harness2.env);
    expect(await cache2.isRevoked("client-A")).toBe(true);
  });

  it("HTTP /revoke marks client_id revoked", async () => {
    const res = await cache.fetch(
      new Request("http://do/revoke", {
        method: "POST",
        body: JSON.stringify({ cf_client_id: "client-X" }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(200);
    expect(await cache.isRevoked("client-X")).toBe(true);
  });

  it("HTTP /is-revoked returns revoked status", async () => {
    await cache.revoke("client-Y");
    const res = await cache.fetch(
      new Request("http://do/is-revoked", {
        method: "POST",
        body: JSON.stringify({ cf_client_id: "client-Y" }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(200);
    const data = await res.json<{ revoked: boolean }>();
    expect(data.revoked).toBe(true);
  });

  it("HTTP /snapshot returns 503 when REVOCATION_CACHE_INTERNAL_TOKEN is unset (C3.8 fail-CLOSED)", async () => {
    // The default harness leaves env empty; /snapshot must refuse.
    const res = await cache.fetch(
      new Request("http://do/snapshot", { method: "GET" }),
    );
    expect(res.status).toBe(503);
  });

  it("HTTP /snapshot returns 403 when token is wrong", async () => {
    const harnessAuth = makeDurableObjectStub();
    harnessAuth.env = {
      REVOCATION_CACHE_INTERNAL_TOKEN: "secret-token-xyz",
    } as unknown as Env;
    const cacheAuth = new RevocationCache(harnessAuth.ctx, harnessAuth.env);
    await cacheAuth.revoke("client-Z");
    const res = await cacheAuth.fetch(
      new Request("http://do/snapshot", {
        method: "GET",
        headers: { "x-internal-token": "wrong" },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("HTTP /snapshot returns list when token matches (C3.8)", async () => {
    const harnessAuth = makeDurableObjectStub();
    harnessAuth.env = {
      REVOCATION_CACHE_INTERNAL_TOKEN: "secret-token-xyz",
    } as unknown as Env;
    const cacheAuth = new RevocationCache(harnessAuth.ctx, harnessAuth.env);
    await cacheAuth.revoke("client-Z");
    const res = await cacheAuth.fetch(
      new Request("http://do/snapshot", {
        method: "GET",
        headers: { "x-internal-token": "secret-token-xyz" },
      }),
    );
    expect(res.status).toBe(200);
    const data = await res.json<string[]>();
    expect(data).toContain("client-Z");
  });

  it("HTTP /revoke 400s on missing cf_client_id (C3.8 body validation)", async () => {
    const res = await cache.fetch(
      new Request("http://do/revoke", {
        method: "POST",
        body: JSON.stringify({ wrong_key: "x" }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("HTTP /revoke 400s on invalid JSON body (C3.8 body validation)", async () => {
    const res = await cache.fetch(
      new Request("http://do/revoke", {
        method: "POST",
        body: "not json",
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("HTTP /prune-stale removes entries older than before_ts (C3.8)", async () => {
    // Plant a legacy entry directly so we can reason about its ts.
    await cache.revoke("client-recent");
    // Directly mutate storage to simulate a legacy ts=0 entry.
    const list = harness.store.get("revoked") as Array<{
      id: string;
      ts: number;
    }>;
    list.push({ id: "client-legacy", ts: 0 });
    harness.store.set("revoked", list);

    // Reload via fresh instance.
    const harness2 = makeDurableObjectStub();
    harness2.storage.get.mockImplementation(async (key: string) => {
      return harness.store.get(key);
    });
    harness2.storage.put.mockImplementation(
      async (key: string, value: unknown) => {
        harness.store.set(key, value);
      },
    );
    const cache2 = new RevocationCache(harness2.ctx, harness2.env);

    const res = await cache2.fetch(
      new Request("http://do/prune-stale", {
        method: "POST",
        body: JSON.stringify({ before_ts: 1 }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(200);
    const data = await res.json<{ removed: number }>();
    // Only the ts=0 legacy entry has ts < 1; the recent revocation has ts=Date.now().
    expect(data.removed).toBe(1);
  });

  it("HTTP unknown path → 404", async () => {
    const res = await cache.fetch(
      new Request("http://do/unknown", { method: "GET" }),
    );
    expect(res.status).toBe(404);
  });
});
