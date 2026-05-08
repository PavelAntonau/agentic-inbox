// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * Lightweight client-side telemetry helper.
 *
 * MVP: structured `console.info` lines tagged with `[telemetry]` so the
 * mock-mode scenarios can grep them out of `browser_console_messages`
 * and so an operator opening DevTools can see widget lifecycle at a
 * glance. A future hardening pass can swap the sink for a server beacon
 * (e.g. POST `/api/v1/telemetry/<topic>`) without changing call sites —
 * the public API is `track(topic, event, attrs)`, the sink is private.
 *
 * Why not a third-party SDK: every script we load increases CSP surface
 * area + bytes. The eventual server beacon is one more `fetch` to
 * `'self'` — already in `connect-src`.
 *
 * Failure mode: if the sink throws, the call site MUST NOT propagate.
 * Telemetry must never break a feature.
 */

export interface TelemetryAttrs {
  [key: string]: string | number | boolean | null | undefined;
}

const PREFIX = "[telemetry]";

/**
 * Emit a single telemetry event.
 *
 * @param topic   Logical category, e.g. `"turnstile"`, `"auth"`, `"sw"`.
 *                Lower-case, hyphenated.
 * @param event   The specific event within the topic, e.g. `"mount.success"`,
 *                `"resend.no-token"`. Dot-separated namespaces.
 * @param attrs   Optional structured attributes; flat (no nesting). Values
 *                MUST be primitives so the sink can render them safely.
 */
export function track(
  topic: string,
  event: string,
  attrs: TelemetryAttrs = {},
): void {
  try {
    const payload = {
      ts: Date.now(),
      topic,
      event,
      ...attrs,
    };
    // eslint-disable-next-line no-console
    console.info(PREFIX, JSON.stringify(payload));
  } catch {
    // Telemetry must never break a feature.
  }
}
