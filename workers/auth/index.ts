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
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/control-plane/schema";
import { sendEmail } from "../email-sender";
import type { Env } from "../types";

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
 */
export function createAuth(env: Env): ServerAuth {
  const db = drizzle(env.DB, { schema });

  const auth = betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL ?? "https://mail.actionnow.ai",
    trustedOrigins: [
      "https://mail.actionnow.ai",
      "http://localhost:5173",
      "http://localhost:8787",
    ],

    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: {
        user: schema.users,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        rateLimit: schema.rate_limit,
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
    ],

    databaseHooks: {
      user: {
        create: {
          // Bootstrap-owner: when a user signs in for the first time and
          // their email matches BOOTSTRAP_OWNER_EMAIL, promote to global_owner.
          // This preserves the same behavior the existing app implements via
          // workers/lib/bootstrap-owner.ts on the CF Access path.
          async before(user) {
            const bootstrapEmail = (
              env as Env & { BOOTSTRAP_OWNER_EMAIL?: string }
            ).BOOTSTRAP_OWNER_EMAIL;
            if (
              bootstrapEmail &&
              user.email.toLowerCase() === bootstrapEmail.toLowerCase()
            ) {
              return { data: { ...user, role: "global_owner" } };
            }
            return { data: user };
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
  const subject = "Your Agentic Inbox sign-in code";

  const text = [
    `Your sign-in code is: ${otp}`,
    "",
    "This code expires in 10 minutes.",
    "If you didn't request this, you can ignore this email — your account is safe.",
    "",
    "— Agentic Inbox",
  ].join("\n");

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#0b1220;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#e2e8f0;">
  <div style="max-width:480px;margin:0 auto;background:#111827;border:1px solid #1f2937;border-radius:12px;padding:32px;">
    <h1 style="margin:0 0 16px;font-size:20px;color:#f1f5f9;">Sign in to Agentic Inbox</h1>
    <p style="margin:0 0 24px;color:#94a3b8;line-height:1.5;">Use the code below to sign in:</p>
    <div style="font-size:32px;font-weight:700;letter-spacing:0.25em;color:#22d3ee;background:#0b1220;border:1px solid #1f2937;border-radius:8px;padding:16px;text-align:center;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${otp}</div>
    <p style="margin:24px 0 0;color:#64748b;font-size:13px;line-height:1.5;">This code expires in 10 minutes. If you didn't request it, ignore this message — your account stays safe.</p>
  </div>
</body></html>`;

  await sendEmail(env.EMAIL, {
    to,
    from: { name: "Agentic Inbox", email: "auth@actionnow.ai" },
    subject,
    text,
    html,
  });
}
