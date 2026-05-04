// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * Pre-registered trusted MCP OAuth clients (T1.6, mcp-oauth action plan).
 *
 * This module is the single source of truth for the four MCP clients we ship
 * pre-registered:
 *
 *   - Claude Code        (Anthropic CLI; loopback redirect per RFC 8252 §7.3)
 *   - ChatGPT desktop    (OpenAI native app; mixed loopback + connector URL)
 *   - Cursor             (AI editor; loopback + cursor:// custom scheme)
 *   - ActionNowAI iOS    (our own app; custom scheme + universal-link fallback)
 *
 * The metadata serves three downstream consumers:
 *
 * 1. `scripts/seed-trusted-clients.ts` reads `TRUSTED_CLIENTS` and emits an
 *    idempotent `INSERT OR IGNORE` against the `oauth_client` table.
 * 2. `workers/auth/index.ts` reads `TRUSTED_CLIENT_IDS` and passes it to
 *    `oauthProvider({ cachedTrustedClients })` so the plugin guards these
 *    rows against modification through the CRUD endpoints (per
 *    `@better-auth/oauth-provider` ~line 1479: trusted clients must be
 *    updated manually, not via DCR).
 * 3. The `/consent` route (T2.1) hydrates branded display from `clientName`,
 *    `logoUri`, and `description` — even though `skipConsent: true` means
 *    these clients won't show consent on the happy path, the UI still uses
 *    this map for the "Connected Agents" card on `/account`.
 *
 * Constraints:
 *   - `scope` MUST NOT include `openid`. T1.1 finding B (RESULT.md) showed
 *     the plugin auto-pushes `${baseURL}/oauth2/userinfo` into the `aud`
 *     set when `openid` is present, breaking exact-string aud match on
 *     `/mcp`. The master scope list in `workers/auth/index.ts` enforces
 *     this; client-specific subsets here MUST stay within that list.
 *   - All four are public/native PKCE-only clients: `tokenEndpointAuthMethod
 *     = "none"`, `public = true`, `requirePKCE = true`, `clientSecret` is
 *     NULL.
 *   - Loopback redirect URIs (`http://127.0.0.1/...`, `http://localhost/...`)
 *     register the *path* without a port; better-auth's matcher
 *     (oauth-provider ~line 3764) special-cases `isLoopbackIP(hostname)` and
 *     ignores the port in the requested URI, so any random port the desktop
 *     client picks at runtime matches.
 *   - Vendor-specific HTTPS callback URIs are best-effort defaults. They
 *     can be updated post-seed via direct SQL (`UPDATE oauth_client SET
 *     redirect_uris = '[...]' WHERE client_id = '...'`) without going
 *     through the immutable CRUD endpoints. Each entry below cites the
 *     source for its choice.
 */

export interface TrustedClient {
  /** Stable, human-readable client_id surfaced to MCP clients. */
  clientId: string;
  /** Display name shown on consent + Connected Agents UI. */
  clientName: string;
  /** Vendor homepage / app store page. */
  clientUri: string;
  /** HTTPS logo URL. Required to be HTTPS by the consent-UI sanitizer (T2.1). */
  logoUri: string;
  /** Short user-facing description for the Connected Agents card. */
  description: string;
  /** Allowed redirect URIs (exact match; loopback hosts ignore port). */
  redirectUris: string[];
  /** Subset of the master scope list this client may request. */
  scopes: string[];
  /** "native" for desktop/mobile, "web" otherwise. RFC 7591 §2. */
  type: "native" | "web";
}

/**
 * Master scope list mirror — KEEP IN SYNC with `workers/auth/index.ts`'s
 * `oauthProvider({ scopes })`. Re-exported here so the seed script can
 * validate that each client's per-client scope subset is a subset of the
 * master list at compile time.
 */
export const MASTER_MCP_SCOPES = [
  "mcp:mailbox:read",
  "mcp:mailbox:write",
  "mcp:contacts:read",
  "mcp:contacts:write",
  "mcp:profile:read",
] as const;

export const TRUSTED_CLIENTS: readonly TrustedClient[] = [
  {
    clientId: "claude-code",
    clientName: "Claude Code",
    clientUri: "https://www.anthropic.com/claude-code",
    logoUri: "https://www.anthropic.com/favicon.ico",
    description:
      "Anthropic's terminal coding agent. Connects to your inbox to draft, send, and triage mail from the CLI.",
    // RFC 8252 §7.3 loopback IP redirection. better-auth's matcher
    // (oauth-provider ~line 3764) ignores the port for loopback hosts.
    redirectUris: ["http://127.0.0.1/callback", "http://localhost/callback"],
    scopes: [
      "mcp:mailbox:read",
      "mcp:mailbox:write",
      "mcp:contacts:read",
      "mcp:profile:read",
    ],
    type: "native",
  },
  {
    clientId: "chatgpt-desktop",
    clientName: "ChatGPT desktop",
    clientUri: "https://chatgpt.com/",
    logoUri: "https://chatgpt.com/favicon.ico",
    description:
      "OpenAI's ChatGPT desktop app. Lets you ask ChatGPT to read or send messages from your inbox.",
    // OpenAI's connector platform OAuth callback (best-effort default — the
    // OpenAI Apps SDK / connector docs use this pattern). Loopback included
    // for the desktop app's local-helper flow.
    redirectUris: [
      "https://chatgpt.com/connector_platform_oauth_callback",
      "https://chat.openai.com/connector_platform_oauth_callback",
      "http://127.0.0.1/callback",
      "http://localhost/callback",
    ],
    scopes: [
      "mcp:mailbox:read",
      "mcp:mailbox:write",
      "mcp:contacts:read",
      "mcp:profile:read",
    ],
    type: "native",
  },
  {
    clientId: "cursor",
    clientName: "Cursor",
    clientUri: "https://cursor.com/",
    logoUri: "https://cursor.com/favicon.ico",
    description:
      "Anysphere's AI editor. Connects MCP-style so Cursor can search and reference your inbox while you code.",
    // Cursor's published MCP integration accepts both the deep-link custom
    // scheme and a hosted callback. Loopback included for the desktop app.
    redirectUris: [
      "cursor://anysphere.cursor-retrieval/oauth/user-actionnow/callback",
      "https://cursor.com/api/auth/callback",
      "http://127.0.0.1/callback",
      "http://localhost/callback",
    ],
    scopes: [
      "mcp:mailbox:read",
      "mcp:mailbox:write",
      "mcp:contacts:read",
      "mcp:profile:read",
    ],
    type: "native",
  },
  {
    clientId: "actionnow-ios",
    clientName: "ActionNowAI (iOS)",
    clientUri: "https://mail.actionnow.ai/",
    logoUri: "https://mail.actionnow.ai/favicon.ico",
    description:
      "Our own iOS app. Authorizing here grants the same access the app uses for in-app voice + transcription flows.",
    // Custom URI scheme (RFC 8252 §7.1) for app-claimed redirect, plus a
    // universal-link fallback served from the production zone.
    redirectUris: [
      "actionnowai://oauth/callback",
      "https://mail.actionnow.ai/oauth/ios-callback",
    ],
    // The iOS app gets the full master list — it's our first-party client.
    scopes: [
      "mcp:mailbox:read",
      "mcp:mailbox:write",
      "mcp:contacts:read",
      "mcp:contacts:write",
      "mcp:profile:read",
    ],
    type: "native",
  },
] as const;

/**
 * `Set<string>` of trusted client IDs, ready to pass to
 * `oauthProvider({ cachedTrustedClients })`. Constructed once at module
 * import time; the plugin reads it on each request via `.has(client_id)`.
 */
export const TRUSTED_CLIENT_IDS: ReadonlySet<string> = new Set(
  TRUSTED_CLIENTS.map((c) => c.clientId),
);

/**
 * Lookup helper for the consent UI / Connected Agents card. Returns the
 * full metadata for a given client_id, or undefined for dynamically-
 * registered clients (which the UI handles with a separate fallback).
 */
export function getTrustedClient(clientId: string): TrustedClient | undefined {
  return TRUSTED_CLIENTS.find((c) => c.clientId === clientId);
}
