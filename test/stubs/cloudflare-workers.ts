// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Stub for `cloudflare:workers` used by vitest (happy-dom environment).
// Provides the minimal DurableObject base class needed by AgentTokenLimiter
// and RevocationCache so they can be tested without a real Workers runtime.

export class DurableObject {
  // biome-ignore lint/suspicious/noExplicitAny: stub — ctx/env types vary per DO
  constructor(
    protected readonly ctx: any,
    protected readonly env: any,
  ) {}
}

export class WorkerEntrypoint {}
export class RpcTarget {}
