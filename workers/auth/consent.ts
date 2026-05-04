// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// T2.1 (mcp-oauth) — server-side helpers for the OAuth /consent flow.
//
// This module is the bridge between our `app/routes/consent.tsx` route and
// the `@better-auth/oauth-provider` plugin. It owns three responsibilities:
//
//   1. Re-verify the plugin's signed OAuth query parameters (`sig` + `exp`)
//      so the consent page rejects tampered or expired redirects from the
//      `/oauth2/authorize` endpoint. The plugin's own `verifyOAuthQueryParams`
//      lives in a private utils module; rather than reach into it, we
//      reproduce the check using the public `better-auth/crypto` primitives
//      (`makeSignature`, `constantTimeEqual`). Identical semantics, stable
//      public dependency.
//
//   2. Hydrate client metadata for the consent UI. Trusted-client metadata
//      lives in `~/lib/cached-trusted-clients` (the SSOT). For dynamically-
//      registered clients (DCR), the metadata is in the `oauth_client` D1
//      row. We resolve in that order — trusted first, DB fallback.
//
//   3. Forward an approve/deny decision to the plugin's POST
//      `/api/auth/oauth2/consent` endpoint. The plugin requires a valid
//      session cookie; we forward the original request's cookies verbatim,
//      add `Accept: application/json` so the plugin returns
//      `{ redirect_uri }` instead of a 302, and surface that URL to the
//      route action so it can issue ITS OWN 303 redirect with the
//      `__Host-CSRF_TOKEN` cookie burn attached.
//
// This file does NOT take responsibility for CSRF — `app/lib/csrf.ts`
// owns that surface. It also does NOT touch the session — the route loader
// is responsible for `auth.api.getSession()` before invoking these helpers.

import { constantTimeEqual, makeSignature } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  getTrustedClient,
  type TrustedClient,
} from "~/lib/cached-trusted-clients";
import * as schema from "../db/control-plane/schema";
import type { Env } from "../types";

/* -------------------------------------------------------------------------- */
/* 1. Verify the plugin's signed query params                                 */
/* -------------------------------------------------------------------------- */

/**
 * Verify the `sig` + `exp` parameters that `@better-auth/oauth-provider`
 * adds to the `/consent?...` redirect via `signParams()`.
 *
 * Implementation parity with `node_modules/@better-auth/oauth-provider/dist/utils-*.mjs`
 * `verifyOAuthQueryParams`:
 *   1. Pull `sig` and `exp` from the query string.
 *   2. Strip `sig`, recompute HMAC-SHA-256(URLSearchParams.toString(), secret).
 *   3. Constant-time compare; reject when expired.
 *
 * Returns the parsed remaining params (with `sig` removed) on success, so
 * the caller can extract `client_id`, `scope`, `redirect_uri`, etc., without
 * re-parsing.
 */
export async function verifyOAuthQuerySignature(
  queryString: string,
  secret: string,
): Promise<
  { ok: true; params: URLSearchParams } | { ok: false; reason: string }
> {
  if (!secret) return { ok: false, reason: "secret-missing" };

  const params = new URLSearchParams(queryString);
  const sig = params.get("sig");
  const expRaw = params.get("exp");
  if (!sig) return { ok: false, reason: "sig-missing" };
  if (!expRaw) return { ok: false, reason: "exp-missing" };

  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || !Number.isInteger(exp)) {
    return { ok: false, reason: "exp-malformed" };
  }
  if (exp * 1000 < Date.now()) return { ok: false, reason: "expired" };

  // Plugin's signParams strips `sig` BEFORE re-serializing for the HMAC, so
  // we do the same. The exp parameter IS included in the signed payload.
  params.delete("sig");
  const expected = await makeSignature(params.toString(), secret);

  if (!constantTimeEqual(sig, expected)) {
    return { ok: false, reason: "sig-mismatch" };
  }
  return { ok: true, params };
}

/* -------------------------------------------------------------------------- */
/* 2. Hydrate client metadata                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Display-only client metadata used by the consent UI. Decoupled from the
 * raw `oauth_client` row shape AND from the trusted-client SSOT shape so
 * the UI has one stable surface regardless of source.
 */
export interface ConsentClientView {
  clientId: string;
  clientName: string;
  /** Vendor homepage / app-store page. May be null when DCR clients omit it. */
  clientUri: string | null;
  /** Logo URL — caller MUST pass through `safeHttpsHref` before rendering. */
  logoUri: string | null;
  /** Short user-facing description. May be empty for DCR clients. */
  description: string;
  /** Source provenance — surfaces "trusted" badge in the UI when applicable. */
  source: "trusted" | "registered";
  /** Underlying allowed scope list (master scope set or per-row subset). */
  allowedScopes: string[];
}

/**
 * Resolve client metadata for the consent screen.
 *
 * Lookup order:
 *   1. `cached-trusted-clients` SSOT (`getTrustedClient`). The four
 *      pre-registered MCP clients live here exclusively — their D1 row
 *      copies are write-protected by the plugin's trusted-client guards.
 *   2. `oauth_client` D1 row, when no trusted match. Fallback for any
 *      future dynamically-registered MCP client.
 *
 * Returns `null` when the client_id is not found in either source.
 */
export async function loadConsentClient(
  env: Env,
  clientId: string,
): Promise<ConsentClientView | null> {
  const trusted = getTrustedClient(clientId);
  if (trusted) return trustedClientToView(trusted);

  // Fallback: pull from D1. Dynamic-registration clients land here.
  const db = drizzle(env.DB, { schema });
  const row = await db
    .select({
      clientId: schema.oauth_client.clientId,
      name: schema.oauth_client.name,
      uri: schema.oauth_client.uri,
      icon: schema.oauth_client.icon,
      metadata: schema.oauth_client.metadata,
      scopes: schema.oauth_client.scopes,
    })
    .from(schema.oauth_client)
    .where(eq(schema.oauth_client.clientId, clientId))
    .get();
  if (!row) return null;

  let description = "";
  if (typeof row.metadata === "string" && row.metadata.trim()) {
    try {
      const m = JSON.parse(row.metadata) as Record<string, unknown>;
      if (typeof m.description === "string") description = m.description;
    } catch {
      // Malformed metadata — leave description empty.
    }
  }

  return {
    clientId: row.clientId,
    clientName: row.name ?? row.clientId,
    clientUri: row.uri ?? null,
    logoUri: row.icon ?? null,
    description,
    source: "registered",
    allowedScopes: parseScopeArray(row.scopes),
  };
}

function trustedClientToView(t: TrustedClient): ConsentClientView {
  return {
    clientId: t.clientId,
    clientName: t.clientName,
    clientUri: t.clientUri,
    logoUri: t.logoUri,
    description: t.description,
    source: "trusted",
    allowedScopes: [...t.scopes],
  };
}

/** Parse the `oauth_client.scopes` column. Drizzle types it as the inferred
 *  column type; depending on schema definition that's `string[]` (json) or
 *  `string` (TEXT). Handle both — JSON-encoded strings are common when the
 *  drizzle adapter is asked to round-trip a TEXT column as a JSON array. */
function parseScopeArray(value: unknown): string[] {
  if (Array.isArray(value))
    return value.filter((v): v is string => typeof v === "string");
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed)
        ? parsed.filter((v): v is string => typeof v === "string")
        : [];
    } catch {
      return [];
    }
  }
  // Space-separated fallback (some clients store scopes as the raw OAuth
  // scope string).
  return trimmed.split(/\s+/).filter(Boolean);
}

/* -------------------------------------------------------------------------- */
/* 3. Forward the approve/deny decision                                       */
/* -------------------------------------------------------------------------- */

export interface ConsentDecisionInput {
  /** True for approve, false for deny. */
  accept: boolean;
  /** Space-separated scope subset the user accepted. Optional — when omitted,
   *  the plugin uses the originally-requested scopes verbatim. */
  scope?: string;
  /** The verbatim signed query string the consent page received (no
   *  leading `?`). The plugin re-verifies `sig` + `exp` server-side, so
   *  tampering between our action and the plugin is structurally caught. */
  oauthQuery: string;
}

export interface ConsentDecisionResult {
  /** The redirect URL to send the browser to. Always present on success. */
  redirectUri: string;
}

/**
 * POST the user's approve/deny decision to the plugin's
 * `/api/auth/oauth2/consent` endpoint and return the resulting redirect URL.
 *
 * The endpoint is session-protected — the original request's `Cookie` header
 * MUST be forwarded so better-auth's `sessionMiddleware` finds the
 * `__Host-anai.session_token` cookie.
 *
 * The plugin returns:
 *   - On accept: `{ redirect_uri: "<authorize-redirect-with-code>" }` —
 *     a redirect into the OAuth client's `redirect_uri` carrying the
 *     `code` and (when present) `state` and `iss`.
 *   - On deny: `{ redirect_uri: "<authorize-redirect-with-error>" }` —
 *     a redirect to the OAuth client's `redirect_uri` carrying
 *     `error=access_denied` per RFC 6749 §4.1.2.1.
 *
 * Either way, the consent route's job is to take that URL and redirect
 * the browser. We DON'T follow the redirect server-side; the client must
 * see the `redirect_uri` in its address bar to close the OAuth loop.
 */
export async function submitConsentDecision(
  request: Request,
  env: Env,
  input: ConsentDecisionInput,
): Promise<ConsentDecisionResult> {
  // Anchor the internal call to the same origin the original request
  // arrived on so the plugin's `baseURL` resolution and cookie scoping
  // work identically. Workers fetch can call its own origin via
  // `service_bindings`; for the same-Worker case, a same-origin URL is
  // resolved by the runtime to a sub-request of THIS worker.
  const origin = new URL(request.url).origin;
  const url = `${origin}/api/auth/oauth2/consent`;

  const headers = new Headers();
  // Forward the session cookie. `Cookie` IS allowed on a fetch INITIATED
  // from a Workers handler (the forbidden-header restriction applies to
  // browser-side fetch, not Workers).
  const cookie = request.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  headers.set("content-type", "application/json");
  // Force JSON response — the plugin's handleRedirect helper returns either
  // a 302 or a JSON {redirect_uri:...} based on this header.
  headers.set("accept", "application/json");

  const body: Record<string, unknown> = {
    accept: input.accept,
    oauth_query: input.oauthQuery,
  };
  if (input.scope) body.scope = input.scope;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    redirect: "manual",
  });

  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      // ignore
    }
    throw new ConsentForwardError(
      `consent endpoint returned ${res.status}: ${detail.slice(0, 200)}`,
      res.status,
    );
  }

  // Parse the JSON envelope. The plugin's typed body declares a
  // `redirect_uri` field; tolerate the alternate `redirectURI` casing
  // some better-auth versions return for consistency.
  const data = (await res.json()) as Record<string, unknown>;
  const redirectUri =
    typeof data.redirect_uri === "string"
      ? data.redirect_uri
      : typeof data.redirectURI === "string"
        ? data.redirectURI
        : null;
  if (!redirectUri) {
    throw new ConsentForwardError(
      "consent endpoint returned no redirect_uri",
      502,
    );
  }
  return { redirectUri };
}

export class ConsentForwardError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ConsentForwardError";
    this.status = status;
  }
}
