// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// T2.2 (mcp-oauth) — RFC 8414 / RFC 9728 discovery handlers + /jwks alias.
//
// MCP clients (Claude Code, ChatGPT desktop, Cursor, the iOS app) discover
// the authorization server WITHOUT out-of-band configuration by:
//   1. Hitting /mcp → 401 with `WWW-Authenticate: Bearer
//      resource_metadata="https://mail.actionnow.ai/.well-known/oauth-protected-resource"`.
//   2. Fetching that URL → JSON pointing to the auth server.
//   3. Fetching /.well-known/oauth-authorization-server on the auth server
//      → JSON listing authorize/token/jwks/revoke/introspect endpoints.
//   4. Driving PKCE + RFC 8707 resource binding to obtain a bearer.
//
// All three docs MUST live at the **issuer root** per RFC 8414 §3 and
// RFC 9728 §3 — better-auth mounts them under its basePath (`/api/auth`),
// which is wrong-path. T1.5 progress note 4 surfaces this gap and routes the
// fix here.
//
// `/jwks` is also aliased here. better-auth's jwt() plugin mounts JWKS at
// `/api/auth/jwks`; the discovery doc advertises `/jwks` (post-alias) so MCP
// clients can verify tokens at the spec-blessed path. The alias serves the
// JWKS directly from `env.OAUTH_JWT_SIGNING_KEY` (the static key provisioned
// in T1.4) — no internal fetch round-trip.

import type { ServerAuth } from "../auth";
import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import type { Env } from "../types";

export const ISSUER = "https://mail.actionnow.ai";
export const RESOURCE = "https://mail.actionnow.ai/mcp";

const COMMON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "public, max-age=300, must-revalidate",
  // RFC 8414/9728 docs are public; allow cross-origin reads so browser-based
  // MCP clients can fetch them without a CORS proxy.
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

// ──────────────────────────────────────────────────────────────────────────
// /.well-known/oauth-authorization-server (RFC 8414)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Build the RFC 8414 metadata document. We hand-roll it instead of round-
 * tripping through `oauthProviderAuthServerMetadata` because:
 *   - The plugin's helper builds an issuer-relative doc under `/api/auth`
 *     (its basePath); we need issuer-rooted URLs.
 *   - The hand-rolled version pins exactly the surface T2.2 commits to
 *     supporting; future plugin versions don't silently change our docs.
 *
 * Endpoint paths verified against `node_modules/@better-auth/oauth-provider/
 * dist/index.mjs:2812..3442` (search for `createAuthEndpoint(...)` calls).
 */
export function authorizationServerMetadata(): Record<string, unknown> {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/api/auth/oauth2/authorize`,
    token_endpoint: `${ISSUER}/api/auth/oauth2/token`,
    introspection_endpoint: `${ISSUER}/api/auth/oauth2/introspect`,
    revocation_endpoint: `${ISSUER}/api/auth/oauth2/revoke`,
    registration_endpoint: `${ISSUER}/api/auth/oauth2/register`,
    jwks_uri: `${ISSUER}/jwks`,
    scopes_supported: [
      "mcp:mailbox:read",
      "mcp:mailbox:write",
      "mcp:contacts:read",
      "mcp:contacts:write",
      "mcp:profile:read",
    ],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
    introspection_endpoint_auth_methods_supported: [
      "none",
      "client_secret_basic",
    ],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
    // RFC 8707 — clients MUST bind tokens to a resource. Advertised here so
    // RFC-aware clients know to send `resource=` on /authorize and /token.
    resource_indicators_supported: true,
    service_documentation: `${ISSUER}/docs/mcp`,
    ui_locales_supported: ["en"],
  };
}

export async function handleAuthorizationServerMetadata(): Promise<Response> {
  return new Response(JSON.stringify(authorizationServerMetadata()), {
    status: 200,
    headers: COMMON_HEADERS,
  });
}

/**
 * Optional: the plugin's own auth-server-metadata view. Useful for sanity-
 * checking — exported so a future endpoint can serve it under a debug path
 * without changing the canonical hand-rolled doc above.
 */
export function pluginAuthServerMetadataHandler(
  auth: ServerAuth,
): (req: Request) => Promise<Response> {
  // The plugin's helper only needs auth.api.getOAuthServerConfig, which our
  // ServerAuth interface exposes via duck-typing of the underlying instance.
  return oauthProviderAuthServerMetadata(
    auth as unknown as Parameters<typeof oauthProviderAuthServerMetadata>[0],
  );
}

// ──────────────────────────────────────────────────────────────────────────
// /.well-known/oauth-protected-resource (RFC 9728)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Build the RFC 9728 protected-resource metadata. Tells MCP clients which
 * authorization server protects the /mcp resource — the bridge between
 * "Bearer challenge on /mcp" and "go talk to /api/auth/oauth2/authorize".
 */
export function protectedResourceMetadata(): Record<string, unknown> {
  return {
    resource: RESOURCE,
    authorization_servers: [ISSUER],
    scopes_supported: [
      "mcp:mailbox:read",
      "mcp:mailbox:write",
      "mcp:contacts:read",
      "mcp:contacts:write",
      "mcp:profile:read",
    ],
    bearer_methods_supported: ["header"],
    resource_signing_alg_values_supported: ["EdDSA"],
    resource_documentation: `${ISSUER}/docs/mcp`,
  };
}

export async function handleProtectedResourceMetadata(): Promise<Response> {
  return new Response(JSON.stringify(protectedResourceMetadata()), {
    status: 200,
    headers: COMMON_HEADERS,
  });
}

// ──────────────────────────────────────────────────────────────────────────
// /jwks alias
// ──────────────────────────────────────────────────────────────────────────

/**
 * Serve the OAuth signing-key JWKS at `/jwks` (issuer-root path).
 *
 * Computed directly from `env.OAUTH_JWT_SIGNING_KEY` — the same static key
 * better-auth's jwt() plugin uses for signing per `workers/auth/index.ts:
 * loadStaticSigningKey`. Public-half only: the response is the public JWK
 * with `use:"sig"` and `alg:"EdDSA"`.
 *
 * Cache: 5 minutes public + must-revalidate. The kid only changes on a
 * deliberate key rotation (next time we rerun
 * `.scratch/gen-oauth-signing-key.mjs`); MCP clients that cache the JWKS
 * for hours won't break.
 */
export async function handleJwks(env: Env): Promise<Response> {
  const raw = env.OAUTH_JWT_SIGNING_KEY;
  if (!raw) {
    return new Response(JSON.stringify({ error: "signing_key_unavailable" }), {
      status: 503,
      headers: COMMON_HEADERS,
    });
  }
  let wrapper: {
    kid: string;
    alg: "EdDSA";
    crv: "Ed25519";
    publicJwk: Record<string, string>;
  };
  try {
    wrapper = JSON.parse(raw);
  } catch {
    return new Response(JSON.stringify({ error: "signing_key_malformed" }), {
      status: 503,
      headers: COMMON_HEADERS,
    });
  }
  const jwks = {
    keys: [
      {
        ...wrapper.publicJwk,
        kid: wrapper.kid,
        alg: wrapper.alg,
        use: "sig" as const,
      },
    ],
  };
  return new Response(JSON.stringify(jwks), {
    status: 200,
    headers: COMMON_HEADERS,
  });
}

// ──────────────────────────────────────────────────────────────────────────
// CORS preflight (one shared OPTIONS handler)
// ──────────────────────────────────────────────────────────────────────────

export function handleDiscoveryPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Max-Age": "86400",
    },
  });
}
