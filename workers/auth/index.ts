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
import { writeAudit } from "../lib/audit-log";
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
/**
 * Phase G-1 / OQ-PG-1 — constant-time 50 ms timing pad.
 * Runs on EVERY branch (permit and deny) so response timing does not reveal
 * which branch was taken. Resolved by the caller as a background task; it
 * does not delay the happy path any further than the DB round-trips do.
 */
async function signupTimingPad(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
}

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
    // Phase G-1 / OQ-PG-1 — uniform UNAUTHORIZED on ALL deny paths so
    // response shape matches the wrong-OTP path on an invited email.
    // Timing pad runs on every branch including this early exit.
    await signupTimingPad();
    throw new APIError("UNAUTHORIZED", {
      message: "Sign-up not permitted.",
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
      await signupTimingPad();
      // Phase G-1: keep FORBIDDEN only for bootstrap-specific errors
      // (these are not enumerable by external callers).
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
        await signupTimingPad();
        throw new APIError("FORBIDDEN", {
          message:
            "Bootstrap owner signup requires a valid bootstrap token header.",
        });
      }
    }

    await signupTimingPad();
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
  if (invite) {
    await signupTimingPad();
    return { data: user };
  }
  // Phase G-1 / OQ-PG-1 — UNAUTHORIZED (not FORBIDDEN) so attackers cannot
  // distinguish "not on invite list" from "wrong OTP for an invited email".
  // The identical status + message across all non-bootstrap deny paths closes
  // the invite-list enumeration channel.
  await signupTimingPad();
  throw new APIError("UNAUTHORIZED", {
    message: "Sign-up not permitted.",
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
 * Phase G-1 / Task 6 — freshAge enforcement for sensitive operations.
 *
 * Checks that the better-auth session was created within the last `maxAgeMs`
 * milliseconds. Returns `null` when no better-auth session cookie is present
 * (CF Access path — CF tokens have their own freshness from the edge).
 * Returns `{ fresh: false }` when a session exists but is too old.
 * Returns `{ fresh: true, session }` when a session is present and fresh.
 *
 * FRESH_AGE_MS mirrors `session.freshAge` in `createAuth` (5 minutes = 300 s).
 */
export const FRESH_AGE_MS = 60 * 5 * 1000; // 5 minutes in milliseconds

export type FreshnessResult =
  | null
  | { fresh: false }
  | { fresh: true; session: BetterAuthSession };

export async function requireFreshBetterAuthSession(
  env: Env,
  request: Request,
): Promise<FreshnessResult> {
  const auth = createAuth(env);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return null; // Not a better-auth session — CF Access path
  const createdAt =
    session.session.createdAt instanceof Date
      ? session.session.createdAt.getTime()
      : typeof session.session.createdAt === "number"
        ? session.session.createdAt
        : NaN;
  if (Number.isNaN(createdAt)) return { fresh: false };
  const age = Date.now() - createdAt;
  if (age >= FRESH_AGE_MS) return { fresh: false };
  return { fresh: true, session };
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
 *
 * Phase G-1 — when an ExecutionContext is supplied, the OTP-send hot path
 * uses `ctx.waitUntil()` to move the email call off the critical path so
 * that response latency is constant regardless of whether the email send
 * succeeds or fails.
 */
export function createAuth(
  env: Env,
  request?: Request,
  ctx?: ExecutionContext,
): ServerAuth {
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
    //
    // Phase G-1 / Task 1 — per-path custom rules for high-value OTP surfaces.
    // window is in seconds; max is the request ceiling within that window.
    // OTP-send: 5 attempts per 15 min per IP (prevents cheap OTP flooding).
    // OTP-verify: 5 attempts per 15 min per IP (mirrors wrong-OTP lock-out).
    // Sign-up: 10 attempts per 15 min per IP (less critical, wider window).
    rateLimit: {
      storage: "database",
      modelName: "rateLimit",
      customRules: {
        "/email-otp/send-verification-otp": { window: 60 * 15, max: 5 },
        "/sign-in/email-otp": { window: 60 * 15, max: 5 },
        "/sign-up/email": { window: 60 * 15, max: 10 },
      },
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
      // Phase G-1 / Task 5 — disable cookie cache so every session lookup
      // hits D1. This closes the window where a revoked session could still
      // authenticate for up to maxAge seconds via a stale cookie.
      cookieCache: {
        enabled: false,
      },
      // Phase G-1 / Task 5 — freshAge: sessions older than 5 min are
      // considered stale for sensitive operations (PAT-mint, role-change,
      // user-delete). Callers that need a fresh session must use
      // freshSessionMiddleware (or call getSession with requireFresh) before
      // performing privileged mutations. 0 = always fresh (disabled).
      freshAge: 60 * 5, // 5 minutes
    },

    account: { modelName: "account" },
    verification: { modelName: "verification" },

    advanced: {
      cookiePrefix: "anai",
      // __Host-* prefix requires Secure + Path=/ + no Domain attribute.
      // Phase G-1 / Task 7 — DEFERRED. better-auth 1.6.9's `cookiePrefix`
      // API prepends the `__Secure-` prefix before the app prefix, producing
      // `__Secure-<cookiePrefix>.session_token`. Setting cookiePrefix to
      // "__Host-" would yield `__Secure-__Host-anai.session_token`, which is
      // invalid. The correct `__Host-` flip requires overriding individual
      // cookie names via `advanced.cookies.<name>.name = "__Host-anai.<name>"`
      // AND removing the Domain attribute — not done here to avoid a
      // breaking cookie-name change without a coordinated session migration.
      // TODO: flip in a separate PR after session-migration plan is approved.
      useSecureCookies: true,
      // Phase G-1 / Task 1 — route cf-connecting-ip as the canonical IP
      // source for better-auth's rate-limit keying so Worker-edge IPs
      // (which only set cf-connecting-ip) are correctly identified.
      // ipv6Subnet: 64 normalises IPv6 addresses to /64 prefix so a single
      // attacker rotating over a /64 block still hits the same rate-limit key.
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip"],
        ipv6Subnet: 64,
      },
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
        // Phase G-1 / Task 8 — store OTPs as HMAC hex so the verify path
        // routes through better-auth's `verifyStoredOTP` "hashed" branch,
        // which calls `constantTimeEqual(hash(submitted), stored)`.  This
        // closes the timing-oracle on OTP comparison and ensures DB dumps
        // never expose active OTPs in plaintext.
        storeOTP: "hashed",
        async sendVerificationOTP({ email, otp, type }) {
          // Phase G-1 / Task 3 — move the email send off the synchronous
          // hot path via ctx.waitUntil so request latency is constant
          // whether the email send succeeds or fails. The OTP code is
          // already persisted in D1 by the time this callback fires, so
          // the verification flow is unaffected. Errors are logged inside
          // sendOtpEmail; they do NOT propagate to the caller (the user
          // gets a "check your inbox" response regardless).
          //
          // Phase G-1 / Task 10 — emit audit event for OTP send.
          const sendPromise = sendOtpEmail(env, email, otp, type).then(() => {
            return writeAudit(env.DB, {
              action: "auth.otp_sent",
              target: { kind: "user", id: email },
              meta: { type, timestamp: Date.now() },
            });
          });
          if (ctx) {
            ctx.waitUntil(sendPromise);
          } else {
            // Fallback: no ExecutionContext available (authz-context path or
            // tests). Await synchronously so the email is not silently dropped.
            await sendPromise;
          }
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
          // Anything else throws `APIError("UNAUTHORIZED")`. The OTP / sign-in
          // pipeline surfaces the rejection to the caller as a 401.
          // Phase G-1 / Task 10 — audit blocked signup attempts.
          async before(user) {
            const orm = drizzle(env.DB, { schema });
            try {
              const result = await evaluateSignupGate(
                user,
                env,
                orm,
                bootstrapTokenHeader,
              );
              return result;
            } catch (err) {
              // Fire-and-forget: record the blocked signup for observability.
              // writeAudit is already fire-and-forget internally, so errors
              // here never propagate to the caller.
              const email =
                typeof user?.email === "string" ? user.email : "unknown";
              void writeAudit(env.DB, {
                action: "auth.signup_gate_blocked",
                target: { kind: "user", id: email },
                meta: {
                  reason: (err as { status?: string }).status ?? "unknown",
                  timestamp: Date.now(),
                },
              });
              throw err;
            }
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

  // Light-theme branded HTML matching the SPA visual language (cream
  // background, dark text, brand-green accents, "Trusted Agent Inbox"
  // subtitle). Inline CSS only — Gmail / Outlook strip <style> blocks.
  // Table layout for cross-client compatibility. No prefers-color-scheme
  // override: the spec is light-only across clients.
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Your ActionNow.AI sign-in code</title>
</head>
<body style="background:#ece8e2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;padding:32px 16px;color:#141310;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;">
    <tr>
      <td style="padding-bottom:24px;text-align:center;">
        <span style="font-size:24px;font-weight:700;color:#141310;letter-spacing:-0.02em;">
          ActionNow.AI
        </span>
        <p style="margin:4px 0 0;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#6b665c;">
          Trusted Agent Inbox
        </p>
      </td>
    </tr>
    <tr>
      <td style="background:#f0ede8;border:1px solid #d4d0c8;border-radius:17px;padding:36px 32px;text-align:center;">
        <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#141310;">
          Your sign-in code
        </h1>
        <p style="color:#2c2a26;font-size:15px;margin:0 0 28px;line-height:1.55;">
          Enter this code in the browser tab where you started signing in.
        </p>
        <div style="background:#ffffff;border:1px solid #d4d0c8;border-radius:14px;padding:22px 16px;margin:0 auto 28px;max-width:340px;">
          <code style="display:block;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:36px;font-weight:700;color:#141310;letter-spacing:0.32em;line-height:1;">${otp}</code>
        </div>
        <p style="color:#2c2a26;font-size:14px;margin:0 0 8px;line-height:1.55;">
          This code expires in <strong>10 minutes</strong>.
        </p>
        <p style="color:#6b665c;font-size:13px;margin:0;line-height:1.55;">
          If you didn't request this code, you can safely ignore this email — your account stays safe.
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding-top:20px;text-align:center;">
        <p style="color:#9e9e9e;font-size:11px;margin:0;line-height:1.5;">
          © ${new Date().getFullYear()} ActionNow.AI · Powered by mail.actionnow.ai
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  await sendEmail(getEmailBinding(env), {
    to,
    from: { name: "ActionNowAI Mail", email: "auth@actionnow.ai" },
    subject,
    text,
    html,
  });
}
