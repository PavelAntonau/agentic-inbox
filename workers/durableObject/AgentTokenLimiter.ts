// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// AgentTokenLimiter — per-token Durable Object.
//
// Tracks active instances (fingerprint → last_seen_at) for a single agent
// token. Enforces the max_instances cap and prunes idle instances.
//
// Persistence: state.storage.put/get via standard DO KV.

import { DurableObject } from "cloudflare:workers";

export interface RegisterResult {
  instance_id: string;
  accepted: boolean;
  current_count: number;
  max_instances: number;
}

interface InstanceRecord {
  fingerprint: string;
  last_seen_at: number;
}

export class AgentTokenLimiter extends DurableObject {
  private instances: Map<string, InstanceRecord> = new Map();
  private loaded = false;

  private async load(): Promise<void> {
    if (this.loaded) return;
    const stored =
      await this.ctx.storage.get<Record<string, InstanceRecord>>("instances");
    if (stored) {
      this.instances = new Map(Object.entries(stored));
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const obj: Record<string, InstanceRecord> = {};
    for (const [k, v] of this.instances) {
      obj[k] = v;
    }
    await this.ctx.storage.put("instances", obj);
  }

  /**
   * Register a new or returning agent instance.
   *
   * If a matching fingerprint already exists, updates last_seen_at and
   * returns the same instance_id (idempotent for reconnects).
   * Otherwise creates a new instance if current_count < max_instances.
   *
   * @param fingerprint  Stable identifier for this agent process (from X-Agent-Fingerprint header or IP+UA hash)
   * @param max_instances  Maximum allowed concurrent instances for this token
   * @param idle_prune_ms  How old (ms) an instance must be before pruning. 0 = skip prune.
   */
  async register(
    fingerprint: string,
    max_instances: number,
    idle_prune_ms = 0,
  ): Promise<RegisterResult> {
    await this.load();

    if (idle_prune_ms > 0) {
      await this.prune(idle_prune_ms);
    }

    // Check if this fingerprint already has an instance
    for (const [instance_id, record] of this.instances) {
      if (record.fingerprint === fingerprint) {
        record.last_seen_at = Date.now();
        await this.persist();
        return {
          instance_id,
          accepted: true,
          current_count: this.instances.size,
          max_instances,
        };
      }
    }

    // New fingerprint — check cap
    if (this.instances.size >= max_instances) {
      return {
        instance_id: "",
        accepted: false,
        current_count: this.instances.size,
        max_instances,
      };
    }

    // Allocate new instance
    const instance_id = crypto.randomUUID();
    this.instances.set(instance_id, { fingerprint, last_seen_at: Date.now() });
    await this.persist();

    return {
      instance_id,
      accepted: true,
      current_count: this.instances.size,
      max_instances,
    };
  }

  /**
   * Prune instances that have not been seen for longer than idle_ms.
   */
  async prune(idle_ms: number): Promise<number> {
    await this.load();
    const cutoff = Date.now() - idle_ms;
    let removed = 0;
    for (const [id, record] of this.instances) {
      if (record.last_seen_at < cutoff) {
        this.instances.delete(id);
        removed++;
      }
    }
    if (removed > 0) {
      await this.persist();
    }
    return removed;
  }

  /**
   * Revoke all instances — called when a token is revoked.
   */
  async revoke(): Promise<void> {
    await this.load();
    this.instances.clear();
    await this.ctx.storage.delete("instances");
  }

  /**
   * Snapshot — returns all current instance records (for observability).
   */
  async snapshot(): Promise<
    { instance_id: string; fingerprint: string; last_seen_at: number }[]
  > {
    await this.load();
    const result: {
      instance_id: string;
      fingerprint: string;
      last_seen_at: number;
    }[] = [];
    for (const [instance_id, record] of this.instances) {
      result.push({ instance_id, ...record });
    }
    return result;
  }

  /**
   * HTTP fetch handler for DO RPC (Hono routes dispatch here via stub.fetch).
   *
   * Routes:
   *   POST /register   body: { fingerprint, max_instances, idle_prune_ms? }
   *   POST /prune      body: { idle_ms }
   *   POST /revoke
   *   GET  /snapshot
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/register" && request.method === "POST") {
      const body = await request.json<{
        fingerprint: string;
        max_instances: number;
        idle_prune_ms?: number;
      }>();
      const result = await this.register(
        body.fingerprint,
        body.max_instances,
        body.idle_prune_ms ?? 0,
      );
      return Response.json(result);
    }

    if (path === "/prune" && request.method === "POST") {
      const body = await request.json<{ idle_ms: number }>();
      const removed = await this.prune(body.idle_ms);
      return Response.json({ removed });
    }

    if (path === "/revoke" && request.method === "POST") {
      await this.revoke();
      return Response.json({ ok: true });
    }

    if (path === "/snapshot" && request.method === "GET") {
      const data = await this.snapshot();
      return Response.json(data);
    }

    return new Response("Not found", { status: 404 });
  }
}
