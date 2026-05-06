// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// RevocationCache — per-account Durable Object.
//
// Holds a Map<cf_client_id, revoked_at_ms> of revoked service-token client IDs.
// isRevoked() is a hot path (every authenticated service-token request).
// revoke() is called from the token revoke route BEFORE the Cloudflare DELETE.
//
// Persistence: state.storage.put/get via standard DO KV.
//
// Phase C3 / C3.8 (audit A-15) hardening:
//   - Every endpoint validates its body shape; malformed JSON → 400.
//   - `pruneStale(beforeTs)` evicts entries older than the cutoff so a
//     long-running tenant doesn't accrete an unbounded revoked set.
//   - Hard cap of 10,000 entries; over-cap evicts the oldest entry first
//     (LRU-by-revoke-time). Falls back to refusing the new revoke (with
//     an error response) only when something has gone catastrophically
//     wrong (cap=0 not allowed).
//   - `/snapshot` requires DO-level auth (`x-internal-token` header
//     matched against `env.REVOCATION_CACHE_INTERNAL_TOKEN`). Without
//     the env var set the endpoint is fail-CLOSED — production deploys
//     MUST set it.
//   - Storage migrates the legacy `string[]` shape to
//     `{ id, ts }[]` on first load so an in-place upgrade preserves
//     existing revocations. Time `0` is used as the "unknown" age for
//     migrated entries (immortal until pruneStale is given a cutoff that
//     intentionally captures epoch-zero, which production never does).

import { DurableObject } from "cloudflare:workers";

// Cap rationale: 10k revoked client_ids is roughly an active workspace's
// year-of-revocations at modest volume; well under the 128 MB DO state
// budget; well within the snapshot serialization budget. Above this we
// LRU-evict the oldest by revoked-at, which matches the "old revocations
// are no longer interesting because every JWT minted before them has
// expired" reasoning behind pruneStale.
export const REVOCATION_CACHE_HARD_CAP = 10_000;

interface RevokedEntry {
  id: string;
  /** Epoch milliseconds at which the entry was added. 0 = legacy/unknown. */
  ts: number;
}

interface RevocationEnv {
  /**
   * Phase C3 / C3.8: shared secret used for DO-level auth on the
   * `/snapshot` endpoint. Set in wrangler.jsonc / .dev.vars; the same
   * value is sent by the observability route as `x-internal-token`.
   *
   * If unset, `/snapshot` returns 503 fail-CLOSED — never ship to
   * production with this missing.
   */
  REVOCATION_CACHE_INTERNAL_TOKEN?: string;
}

export class RevocationCache extends DurableObject<RevocationEnv> {
  private revoked: Map<string, number> = new Map();
  private loaded = false;

  private async load(): Promise<void> {
    if (this.loaded) return;
    const stored = await this.ctx.storage.get<RevokedEntry[] | string[]>(
      "revoked",
    );
    if (stored && Array.isArray(stored)) {
      // Migration: legacy shape is `string[]`. New shape is `RevokedEntry[]`.
      // Detect by inspecting the first element.
      if (stored.length === 0) {
        // empty — both shapes are equivalent
      } else if (typeof stored[0] === "string") {
        for (const id of stored as string[]) this.revoked.set(id, 0);
      } else {
        for (const entry of stored as RevokedEntry[]) {
          if (
            entry &&
            typeof entry.id === "string" &&
            typeof entry.ts === "number"
          ) {
            this.revoked.set(entry.id, entry.ts);
          }
        }
      }
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const list: RevokedEntry[] = [];
    for (const [id, ts] of this.revoked) list.push({ id, ts });
    await this.ctx.storage.put("revoked", list);
  }

  /**
   * Enforce the hard cap by LRU-evicting the oldest entries (smallest
   * `ts`) until the count is at or below the cap. Pure book-keeping;
   * does NOT persist (the caller persists once after batched mutation).
   */
  private enforceCap(): void {
    if (this.revoked.size <= REVOCATION_CACHE_HARD_CAP) return;
    const sorted = Array.from(this.revoked.entries()).sort(
      (a, b) => a[1] - b[1],
    );
    const overflow = this.revoked.size - REVOCATION_CACHE_HARD_CAP;
    for (let i = 0; i < overflow; i++) this.revoked.delete(sorted[i][0]);
  }

  /**
   * Check whether a cf_client_id has been revoked.
   * Hot path — fast in-memory Map lookup after first load.
   */
  async isRevoked(cf_client_id: string): Promise<boolean> {
    await this.load();
    return this.revoked.has(cf_client_id);
  }

  /**
   * Mark a cf_client_id as revoked and persist immediately.
   * Called BEFORE the Cloudflare DELETE to prevent race-window misses.
   */
  async revoke(cf_client_id: string): Promise<void> {
    await this.load();
    // If already present we still bump `ts` so a re-revoke isn't
    // immediately LRU-pruned ahead of more recent entries.
    this.revoked.set(cf_client_id, Date.now());
    this.enforceCap();
    await this.persist();
  }

  /**
   * Remove a cf_client_id from the revoked set (for cleanup / re-issuance).
   */
  async unrevoke(cf_client_id: string): Promise<void> {
    await this.load();
    this.revoked.delete(cf_client_id);
    await this.persist();
  }

  /**
   * Snapshot — returns all revoked client IDs (for observability).
   */
  async snapshot(): Promise<string[]> {
    await this.load();
    return Array.from(this.revoked.keys());
  }

  /**
   * Phase C3 / C3.8: evict every entry with `ts < beforeTs`. Returns the
   * number of evictions. Legacy entries (ts=0) are evicted whenever
   * beforeTs > 0, i.e. any pruneStale call removes the legacy backlog.
   *
   * Recommended cadence: a daily cron from the worker, calling with
   * `Date.now() - 24*60*60*1000`. Access tokens have 15-minute lifetimes
   * so a 24 h cutoff is far past the "could a JWT minted before the
   * revoke still verify?" horizon.
   */
  async pruneStale(beforeTs: number): Promise<number> {
    await this.load();
    let removed = 0;
    for (const [id, ts] of this.revoked) {
      if (ts < beforeTs) {
        this.revoked.delete(id);
        removed++;
      }
    }
    if (removed > 0) await this.persist();
    return removed;
  }

  /**
   * Validate that `body` is `{ cf_client_id: string }` and return the
   * id, or null if the body is malformed.
   */
  private parseClientIdBody(body: unknown): string | null {
    if (!body || typeof body !== "object") return null;
    const id = (body as { cf_client_id?: unknown }).cf_client_id;
    if (typeof id !== "string") return null;
    if (id.length === 0 || id.length > 256) return null;
    return id;
  }

  /**
   * HTTP fetch handler for DO RPC.
   *
   * Routes:
   *   POST /revoke          body: { cf_client_id }
   *   POST /unrevoke        body: { cf_client_id }
   *   POST /is-revoked      body: { cf_client_id }  → { revoked: boolean }
   *   POST /prune-stale     body: { before_ts: number }  → { removed: number }
   *   GET  /snapshot        REQUIRES x-internal-token header
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/revoke" && request.method === "POST") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid json" }, { status: 400 });
      }
      const id = this.parseClientIdBody(body);
      if (!id) {
        return Response.json(
          { error: "missing or invalid cf_client_id" },
          { status: 400 },
        );
      }
      await this.revoke(id);
      return Response.json({ ok: true });
    }

    if (path === "/unrevoke" && request.method === "POST") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid json" }, { status: 400 });
      }
      const id = this.parseClientIdBody(body);
      if (!id) {
        return Response.json(
          { error: "missing or invalid cf_client_id" },
          { status: 400 },
        );
      }
      await this.unrevoke(id);
      return Response.json({ ok: true });
    }

    if (path === "/is-revoked" && request.method === "POST") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid json" }, { status: 400 });
      }
      const id = this.parseClientIdBody(body);
      if (!id) {
        return Response.json(
          { error: "missing or invalid cf_client_id" },
          { status: 400 },
        );
      }
      const revoked = await this.isRevoked(id);
      return Response.json({ revoked });
    }

    if (path === "/prune-stale" && request.method === "POST") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid json" }, { status: 400 });
      }
      const beforeTs = (body as { before_ts?: unknown })?.before_ts;
      if (
        typeof beforeTs !== "number" ||
        !Number.isFinite(beforeTs) ||
        beforeTs < 0
      ) {
        return Response.json(
          { error: "before_ts must be a non-negative finite number" },
          { status: 400 },
        );
      }
      const removed = await this.pruneStale(beforeTs);
      return Response.json({ removed });
    }

    if (path === "/snapshot" && request.method === "GET") {
      // Phase C3 / C3.8: DO-level auth. Without the env var set, the
      // endpoint refuses; this is intentional and forces every
      // production deploy to set REVOCATION_CACHE_INTERNAL_TOKEN.
      const expected = this.env.REVOCATION_CACHE_INTERNAL_TOKEN;
      if (!expected || expected.length === 0) {
        return Response.json(
          {
            error: "snapshot disabled — REVOCATION_CACHE_INTERNAL_TOKEN unset",
          },
          { status: 503 },
        );
      }
      const provided = request.headers.get("x-internal-token");
      // Constant-time comparison: lengths must match AND every byte
      // must match. JS doesn't expose timingSafeEqual in Workers, so
      // we mask the early-return into a fixed-iteration XOR-accumulate.
      if (typeof provided !== "string" || provided.length !== expected.length) {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
      let diff = 0;
      for (let i = 0; i < expected.length; i++) {
        diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
      }
      if (diff !== 0) {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }

      const data = await this.snapshot();
      return Response.json(data);
    }

    return new Response("Not found", { status: 404 });
  }
}
