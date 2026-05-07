// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase 6.1 — better-auth server setup.
//
// One auth instance per request (drizzle is per-request on Workers). This
// file owns the configuration; the handler is mounted in workers/app.ts.
//
// Maps better-auth's internal user shape onto the existing `users` table
// via field overrides, so we keep ONE user record per person across the
// entire stack — better-auth, the original Cloudflare Access path, and
// every existing endpoint that joins on users.id.
//
// Email OTP delivery uses the existing `EMAIL` Cloudflare Email Routing
// binding (zero new dependencies). See sendOtpEmail() below.

import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP, jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, inArray, sql } from "drizzle-orm";
import * as schema from "../db/control-plane/schema";
import { sendEmail } from "../email-sender";
import { getEmailBinding } from "../lib/mocks/email-binding";
import { isBootstrapEmail } from "../lib/bootstrap-owner";
import { normalizeEmail } from "../lib/email";
import type { Env } from "../types";
// T1.6 — pre-registered trusted MCP clients. Same module is consumed by
// `scripts/seed-trusted-clients.ts` (writes the rows) and by the consent /
// Connected-Agents UI (reads the metadata). Importing the Set here makes
// the four clients immutable through the plugin's CRUD endpoints (per
// `@better-auth/oauth-provider` ~line 1479: trusted clients must be
// updated manually, not via DCR).
import { TRUSTED_CLIENT_IDS } from "~/lib/cached-trusted-clients";

/**
 * Static OAuth JWT signing key, parsed from `env.OAUTH_JWT_SIGNING_KEY`. The
 * env value is stringified JSON `{kid,alg,crv,publicJwk,privateJwk}` produced
 * by `.scratch/gen-oauth-signing-key.mjs` (Ed25519). The shape mirrors the
 * `Jwk` row better-auth's `jwt()` plugin would otherwise persist in the `jwks`
 * D1 table; injecting it via `adapter.getJwks` keeps signing reproducible
 * across Worker isolates and removes the per-sign D1 round-trip.
 */
interface StaticSigningJwk {
  id: string;
  publicKey: string;
  privateKey: string;
  alg: "EdDSA";
  crv: "Ed25519";
  createdAt: Date;
}

function loadStaticSigningKey(env: Env): StaticSigningJwk {
  const raw = env.OAUTH_JWT_SIGNING_KEY;
  if (!raw) {
    throw new Error(
      "OAUTH_JWT_SIGNING_KEY is not set. Provision it with " +
        "`wrangler secret put OAUTH_JWT_SIGNING_KEY` (and mirror to Keychain).",
    );
  }
  const parsed = JSON.parse(raw) as {
    kid: string;
    alg: "EdDSA";
    crv: "Ed25519";
    publicJwk: Record<string, string>;
    privateJwk: Record<string, string>;
  };
  return {
    id: parsed.kid,
    alg: parsed.alg,
    crv: parsed.crv,
    publicKey: JSON.stringify(parsed.publicJwk),
    privateKey: JSON.stringify(parsed.privateJwk),
    createdAt: new Date(0),
  };
}

/**
 * Phase C1 / A-01 — invite-required signup decision (extracted for tests).
 * Phase E / TASK-E.2 — bootstrap-token second factor on the bootstrap path.
 *
 * Returns a `data` object the better-auth `before(user)` hook can return
 * verbatim, OR throws `APIError("FORBIDDEN")` when the email is neither the
 * bootstrap-owner nor on the invite list. The hook itself just calls this
 * helper; keeping the predicate pure-by-injection (env + drizzle) lets the
 * unit suite exercise every branch without spinning up a full better-auth
 * runtime.
 *
 * Permitted creation paths (fail-CLOSED otherwise):
 *   1. BOOTSTRAP_OWNER_EMAIL — promotes to `global_owner` role.
 *      Phase E / TASK-E.2 (OQ-P0-7) defense-in-depth gates:
 *        a. If a `global_owner` user already exists in D1, the bootstrap
 *           path is closed (single-use). Use the invite flow for additional
 *           admins.
 *        b. If `env.BOOTSTRAP_OWNER_TOKEN` is set, the request MUST carry
 *           a matching `x-bootstrap-token` header (passed through here as
 *           `bootstrapToken`). Without the env var, the bootstrap path
 *           falls back to email-match only (Phase C1 / A-01 baseline).
 *   2. A `group_invitations` row matching the lower-cased email with
 *      status in {pending, accepted}.
 */
export async function evaluateSignupGate<U extends { email?: unknown }>(
  user: U,
  env: Env,
  orm: ReturnType<typeof drizzle>,
  bootstrapToken?: string | null,
): Promise<{ data: U }> {
  const rawEmail = typeof user?.email === "string" ? user.email : "";
  // C3.3: route through the shared canonicalizer instead of inline
  // `.trim().toLowerCase()` so the signup gate, the bootstrap predicate,
  // and the JWT-email lookup all see exactly the same form. The
  // `lower(email)` UNIQUE index in D1 stores rows in this canonical form.
  const normalizedEmail = normalizeEmail(rawEmail);
  if (!normalizedEmail) {
    throw new APIError("FORBIDDEN", {
      message: "Email is required for sign-up.",
    });
  }
  if (isBootstrapEmail(rawEmail, env)) {
    // Phase E / TASK-E.2.a — single-use enforcement. Even with a matching
    // bootstrap token, refuse to mint a SECOND global_owner. The very
    // first OTP-completed signup wins; subsequent attempts route through
    // the invite flow (or, more often, never reach this hook because
    // better-auth's create hook only fires when no user row exists for
    // the email).
    const existingOwner = await orm
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.role, "global_owner"))
      .get();
    if (existingOwner) {
      throw new APIError("FORBIDDEN", {
        message:
          "A bootstrap owner already exists. Use the invitation flow for additional admins.",
      });
    }

    // Phase E / TASK-E.2.b — second factor when configured.
    const expectedToken = env.BOOTSTRAP_OWNER_TOKEN;
    if (typeof expectedToken === "string" && expectedToken.length > 0) {
      // Constant-time comparison to deny the timing-side-channel that a
      // naive `===` would expose. Both strings are normalized to ensure
      // lengths match before the byte-wise compare; mismatch on length
      // alone short-circuits to FORBIDDEN.
      const presented =
        typeof bootstrapToken === "string" ? bootstrapToken : "";
      if (
        presented.length !== expectedToken.length ||
        !timingSafeEqualString(presented, expectedToken)
      ) {
        throw new APIError("FORBIDDEN", {
          message:
            "Bootstrap owner signup requires a valid bootstrap token header.",
        });
      }
    }

    return {
      data: { ...user, email: normalizedEmail, role: "global_owner" } as U,
    };
  }
  const invite = await orm
    .select({ id: schema.group_invitations.id })
    .from(schema.group_invitations)
    .where(
      and(
        eq(
          sql`lower(${schema.group_invitations.invitee_email})`,
          normalizedEmail,
        ),
        inArray(schema.group_invitations.status, ["pending", "accepted"]),
      ),
    )
    .get();
  if (invite) return { data: user };
  throw new APIError("FORBIDDEN", {
    message:
      "Sign-up is invite-only. Ask a workspace administrator to invite this email.",
  });
}

/**
 * Constant-time string compare — both inputs are assumed equal-length when
 * called (callers branch on length first to avoid leaking expected length).
 * Returns false the moment any byte differs, but only after walking the
 * full string — accumulator pattern keeps the timing flat.
 */
function timingSafeEqualString(a: string, b: string): boolean {
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/** Minimal session shape returned by better-auth's getSession. */
export interface BetterAuthSession {
  session: {
    id: string;
    userId: string;
    token: string;
    expiresAt: Date | number;
    ipAddress?: string | null;
    userAgent?: string | null;
    createdAt: Date | number;
    updatedAt: Date | number;
  };
  user: {
    id: string;
    email: string;
    name?: string | null;
    emailVerified: boolean;
  };
}

/**
 * Public surface of the per-request better-auth instance. We only need the
 * `handler` for mounting under /api/auth/*; declaring it explicitly here
 * sidesteps TS2742 (better-auth's full inferred type pulls in zod's nested
 * private modules, which `composite: true` rejects as non-portable).
 */
export interface ServerAuth {
  handler(request: Request): Promise<Response>;
  api: {
    getSession(args: { headers: Headers }): Promise<BetterAuthSession | null>;
  };
}

/**
 * Construct a per-request better-auth instance.
 *
 * Caller is responsible for invoking `auth.handler(request)` and returning
 * the resulting Response. Do NOT cache this — drizzle binds to the per-
 * request D1 connection, and reusing a stale instance across requests
 * would leak state.
 *
 * Phase E / TASK-E.2 — when a Request is supplied (only the /api/auth/*
 * route mount needs it), the bootstrap-token header is captured into a
 * closure and read by the `databaseHooks.user.create.before` hook so
 * `evaluateSignupGate` can enforce the second factor without touching
 * better-auth's internals. Other call sites (authz-context session reads)
 * may omit the request — those paths never trigger user creation.
 */
export function createAuth(env: Env, request?: Request): ServerAuth {
  const db = drizzle(env.DB, { schema });
  const staticSigningKey = loadStaticSigningKey(env);
  const bootstrapTokenHeader =
    request?.headers.get("x-bootstrap-token") ?? null;

  // Phase C2 / P1-5: localhost trustedOrigins are gated to DEV builds only.
  // Listing localhost in prod's `trustedOrigins` lets better-auth's CSRF
  // checks accept POSTs whose Origin is `http://localhost:5173`, which is
  // exactly the bypass surface the production workspace MUST refuse.
  // import.meta.env.DEV is true under Vite (`npm run dev`) and Vitest;
  // false in the deployed Worker runtime.
  const isDev = Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
  const trustedOrigins = ["https://mail.actionnow.ai"];
  if (isDev) {
    trustedOrigins.push("http://localhost:5173", "http://localhost:8787");
  }

  const auth = betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL ?? "https://mail.actionnow.ai",
    trustedOrigins,

    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: {
        users: schema.users,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        rateLimit: schema.rate_limit,
        // Phase 1 (mcp-oauth) — JWT plugin storage. Backs jwt() until T1.4
        // switches to a static signing key.
        jwks: schema.jwks,
        // Phase 1 (mcp-oauth) — @better-auth/oauth-provider plugin tables.
        // Plugin model names ↔ snake_case schema exports. usePlural:false
        // means each model resolves to whichever export we map here.
        oauthClient: schema.oauth_client,
        oauthConsent: schema.oauth_consent,
        oauthAccessToken: schema.oauth_access_token,
        oauthRefreshToken: schema.oauth_refresh_token,
      },
      usePlural: false,
    }),

    // Rate-limit: persist to D1 so limits survive Worker restarts and apply
    // consistently across all Worker instances in the same region.
    // modelName matches the drizzleAdapter key above ("rateLimit").
    rateLimit: {
      storage: "database",
      modelName: "rateLimit",
    },

    // Email OTP is the only auth method we ship in Phase 6.1. emailAndPassword
    // and OAuth-third-party providers are intentionally disabled.
    emailAndPassword: { enabled: false },

    user: {
      modelName: "users",
      // Maps better-auth's canonical fields onto our existing users-table
      // column names. Anything not listed here uses the default
      // (already-matching) name — `id`, `email`.
      fields: {
        name: "display_name",
        image: "avatar_url",
        emailVerified: "email_verified",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
      // Extra columns better-auth doesn't know about. Listed so it stops
      // erroring on unknown columns when reading rows. Defaults match the
      // existing column defaults so first-time better-auth user creation
      // produces a row identical to what the app already expects.
      additionalFields: {
        role: {
          type: "string",
          required: false,
          defaultValue: "user",
          input: false, // never accept from client
        },
        status: {
          type: "string",
          required: false,
          defaultValue: "active",
          input: false,
        },
        visibility: {
          type: "string",
          required: false,
          defaultValue: "everyone",
          input: false,
        },
        account_type: {
          type: "string",
          required: false,
          defaultValue: "personal",
          input: false,
        },
        company: {
          type: "string",
          required: false,
          input: false,
        },
        last_login_at: {
          type: "number",
          required: false,
          input: false,
        },
      },
    },

    session: {
      modelName: "session",
      expiresIn: 60 * 60 * 24 * 30, // 30 days
      updateAge: 60 * 60 * 24, // refresh row once per day on activity
      cookieCache: {
        enabled: true,
        maxAge: 60 * 5, // 5-minute in-memory cache for session lookup
      },
    },

    account: { modelName: "account" },
    verification: { modelName: "verification" },

    advanced: {
      cookiePrefix: "anai",
      // __Host-* prefix requires Secure + Path=/ + no Domain attribute. We
      // get this for free with better-auth's defaults; explicit config below
      // mirrors the documented pattern from Cloudflare's MCP guide.
      useSecureCookies: true,
      defaultCookieAttributes: {
        sameSite: "lax",
        secure: true,
        httpOnly: true,
        path: "/",
      },
    },

    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: 600, // 10 minutes
        async sendVerificationOTP({ email, otp, type }) {
          // type is one of "sign-in" | "email-verification" | "forget-password".
          // We only use "sign-in" in Phase 6.1.
          await sendOtpEmail(env, email, otp, type);
        },
      }),

      // JWT plugin: required by oauthProvider for non-opaque access tokens.
      // T1.4 — static Ed25519 signing key sourced from `env.OAUTH_JWT_SIGNING_KEY`,
      // injected via `adapter.getJwks`. The key is identical across every Worker
      // isolate, so MCP clients see a stable JWKS at /jwks and can cache it.
      // `disablePrivateKeyEncryption` avoids the symmetric-encrypt/decrypt round
      // trip the default path runs against `BETTER_AUTH_SECRET` — our key is
      // already protected by the Worker secret store. The `jwks` D1 table
      // (migration 0011) stays defined but unused at runtime.
      jwt({
        jwks: { disablePrivateKeyEncryption: true },
        adapter: {
          getJwks: async () => [staticSigningKey],
        },
        // Pin the JWT iss claim to the issuer-root URL declared by the
        // RFC 8414 metadata at /.well-known/oauth-authorization-server
        // (which serves `issuer: "https://mail.actionnow.ai"`).
        // Without this, better-auth defaults `iss` to `${baseURL}/api/auth`
        // and the /mcp middleware's REQUIRED_ISSUER check rejects with
        // `wrong-issuer`. The static signing key + JWKS are unaffected.
        jwt: { issuer: "https://mail.actionnow.ai" },
      }),

      // OAuth Authorization Server (RFC 6749/7636/8707/9728/8414) for MCP.
      //
      // T1.1 finding B (`.scratch/oauth-aud-verify/RESULT.md`): when the
      // scope set contains `openid`, the plugin auto-pushes
      // `${baseURL}/oauth2/userinfo` into the `aud` set, breaking the
      // exact-string aud match the /mcp middleware (T2.2) relies on.
      // Therefore the master scope list below intentionally OMITS `openid`,
      // making this an OAuth-only authorization server (no OIDC endpoints,
      // no userinfo audience injection). Trusted-client seeds (T1.6) inherit
      // the same constraint.
      oauthProvider({
        loginPage: "/login",
        consentPage: "/consent",
        scopes: [
          "mcp:mailbox:read",
          "mcp:mailbox:write",
          "mcp:contacts:read",
          "mcp:contacts:write",
          "mcp:profile:read",
        ],
        validAudiences: ["https://mail.actionnow.ai/mcp"],
        // T1.6 — Claude Code, ChatGPT desktop, Cursor, ActionNowAI iOS.
        // Set is constructed once at module import; the plugin reads it on
        // each request via `.has(client_id)` to gate the three CRUD guards
        // (delete / update / rotate-secret) so trusted-client metadata can
        // only change via direct SQL UPDATE.
        cachedTrustedClients: TRUSTED_CLIENT_IDS as Set<string>,
        // We mount `/.well-known/oauth-authorization-server` manually at the
        // site root in T2.2 because better-auth's basePath is `/api/auth`,
        // and RFC 8414 §3 places the discovery doc at the issuer root.
        silenceWarnings: { oauthAuthServerConfig: true },
      }),
    ],

    databaseHooks: {
      user: {
        create: {
          // Phase C1 / A-01 — invite-list-required user creation.
          //
          // emailOTP's sign-in flow creates a `users` row on first OTP success
          // when no row exists for that email. Without this gate ANY external
          // address can sign up by completing an OTP cycle, which becomes
          // privilege escalation the moment an admin shares a mailbox with
          // them or invites their email to a group. Subsumes audit P0-7
          // (bootstrap self-promotion is one symptom of unrestricted user
          // creation).
          //
          // Permitted creation paths (fail-CLOSED otherwise):
          //   1. BOOTSTRAP_OWNER_EMAIL (whitespace-tolerant, case-insensitive
          //      match via `isBootstrapEmail`). Promotes to `global_owner`
          //      to keep parity with the CF Access bootstrap path.
          //   2. A `group_invitations` row matching the lower-cased email
          //      with status in {pending, accepted}. Both states evidence
          //      an admin invitation: the row is minted with `pending`, and
          //      the invitee may accept BEFORE the user row exists in some
          //      flows — accept either.
          //
          // Anything else throws `APIError("FORBIDDEN")`. The OTP / sign-in
          // pipeline surfaces the rejection to the caller as a 403.
          async before(user) {
            const orm = drizzle(env.DB, { schema });
            return evaluateSignupGate(user, env, orm, bootstrapTokenHeader);
          },
        },
      },
    },
  });

  // Cast through unknown to break the deep zod-internal type chain that
  // TS2742 rejects under composite: true. Runtime shape is correct; the
  // ServerAuth interface above captures the surface we actually use.
  return auth as unknown as ServerAuth;
}

/**
 * Send a one-time-password email via the existing CF EMAIL binding.
 *
 * The OTP is rendered into a plain-text body + a minimal branded HTML body.
 * Errors are logged via console.error and re-thrown so better-auth surfaces
 * a "failed to send OTP" response to the caller — never silently swallowed
 * (we want the user to retry, not enter a code that never arrived).
 */
async function sendOtpEmail(
  env: Env,
  to: string,
  otp: string,
  _type: "sign-in" | "email-verification" | "forget-password" | "change-email",
) {
  const subject = "Your ActionNowAI Mail sign-in code";

  const text = [
    `Your sign-in code is: ${otp}`,
    "",
    "This code expires in 10 minutes.",
    "If you didn't request this, you can ignore this email — your account is safe.",
    "",
    "— ActionNowAI Mail",
  ].join("\n");

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#0b1220;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#e2e8f0;">
  <div style="max-width:480px;margin:0 auto;background:#111827;border:1px solid #1f2937;border-radius:12px;padding:32px;">
    <h1 style="margin:0 0 16px;font-size:20px;color:#f1f5f9;">Sign in to ActionNowAI Mail</h1>
    <p style="margin:0 0 24px;color:#94a3b8;line-height:1.5;">Use the code below to sign in:</p>
    <div style="font-size:32px;font-weight:700;letter-spacing:0.25em;color:#22d3ee;background:#0b1220;border:1px solid #1f2937;border-radius:8px;padding:16px;text-align:center;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${otp}</div>
    <p style="margin:24px 0 0;color:#64748b;font-size:13px;line-height:1.5;">This code expires in 10 minutes. If you didn't request it, ignore this message — your account stays safe.</p>
  </div>
</body></html>`;

  await sendEmail(getEmailBinding(env), {
    to,
    from: { name: "ActionNowAI Mail", email: "auth@actionnow.ai" },
    subject,
    text,
    html,
  });
}
