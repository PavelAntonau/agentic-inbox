// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// RevocationCache — per-account Durable Object.
//
// Holds a Set<cf_client_id> of revoked service-token client IDs.
// isRevoked() is a hot path (every authenticated service-token request).
// revoke() is called from the token revoke route BEFORE the Cloudflare DELETE.
//
// Persistence: state.storage.put/get via standard DO KV.

import { DurableObject } from "cloudflare:workers";

export class RevocationCache extends DurableObject {
  private revoked: Set<string> = new Set();
  private loaded = false;

  private async load(): Promise<void> {
    if (this.loaded) return;
    const stored = await this.ctx.storage.get<string[]>("revoked");
    if (stored) {
      this.revoked = new Set(stored);
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put("revoked", Array.from(this.revoked));
  }

  /**
   * Check whether a cf_client_id has been revoked.
   * Hot path — fast in-memory Set lookup after first load.
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
    this.revoked.add(cf_client_id);
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
    return Array.from(this.revoked);
  }

  /**
   * HTTP fetch handler for DO RPC.
   *
   * Routes:
   *   POST /revoke       body: { cf_client_id }
   *   POST /unrevoke     body: { cf_client_id }
   *   POST /is-revoked   body: { cf_client_id }  → { revoked: boolean }
   *   GET  /snapshot
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/revoke" && request.method === "POST") {
      const body = await request.json<{ cf_client_id: string }>();
      await this.revoke(body.cf_client_id);
      return Response.json({ ok: true });
    }

    if (path === "/unrevoke" && request.method === "POST") {
      const body = await request.json<{ cf_client_id: string }>();
      await this.unrevoke(body.cf_client_id);
      return Response.json({ ok: true });
    }

    if (path === "/is-revoked" && request.method === "POST") {
      const body = await request.json<{ cf_client_id: string }>();
      const revoked = await this.isRevoked(body.cf_client_id);
      return Response.json({ revoked });
    }

    if (path === "/snapshot" && request.method === "GET") {
      const data = await this.snapshot();
      return Response.json(data);
    }

    return new Response("Not found", { status: 404 });
  }
}
