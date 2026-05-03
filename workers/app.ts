// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { routeAgentRequest } from "agents";
import { Hono } from "hono";
import { jwtVerify, createRemoteJWKSet } from "jose";
import { createRequestHandler } from "react-router";
import { app as apiApp, receiveEmail } from "./index";
import { mockAccessShim, type JwtClaims } from "./lib/mock-access";
import { authzContext } from "./middleware/authz-context";
import type { AuthzContext } from "./db/control-plane/forGroup";
import { EmailMCP } from "./mcp";
import type { Env } from "./types";

export { MailboxDO } from "./durableObject";
export { EmailAgent } from "./agent";
export { EmailMCP } from "./mcp";
export { AgentTokenLimiter } from "./durableObject/AgentTokenLimiter";
export { RevocationCache } from "./durableObject/RevocationCache";

declare module "react-router" {
  export interface AppLoadContext {
    cloudflare: {
      env: Env;
      ctx: ExecutionContext;
    };
  }
}

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

function getAccessUrls(teamDomain: string) {
  const certsPath = "/cdn-cgi/access/certs";
  const teamUrl = new URL(teamDomain);
  const issuer = teamUrl.origin;
  const certsUrl = teamUrl.pathname.endsWith(certsPath)
    ? teamUrl
    : new URL(certsPath, issuer);

  return { issuer, certsUrl };
}

type AppVariables = {
  /** Set by the auth middleware (real JWT verify in prod, mock-Access shim
   *  in dev). Absent when CF_ACCESS_DEV_MODE is unset and we take the
   *  legacy dev-bypass path. authzContext consumes this. */
  jwt?: JwtClaims;
  /** Set by the authzContext middleware after JWT auth. Carries
   *  (user_id, role, group_ids, authorized_mailbox_ids). Absent on the
   *  legacy dev-bypass path; downstream handlers MUST guard against it. */
  authzContext?: AuthzContext;
};

// Main app that wraps the API and adds React Router fallback
const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// `/login` and `/logout` are public — they MUST run before the auth
// middleware below or no-one could reach them without already being
// authenticated. In dev (`CF_ACCESS_DEV_MODE=mock`) `/login` serves a
// branded mock-identity picker; in prod it 302s to Cloudflare Access.
app.get("/login", (c) => {
  if (c.env.CF_ACCESS_DEV_MODE === "mock") {
    return c.html(renderDevLoginPicker(c.env), 200, {
      "Cache-Control": "no-store",
    });
  }
  if (c.env.TEAM_DOMAIN && c.env.POLICY_AUD) {
    const url = new URL(c.env.TEAM_DOMAIN);
    return c.redirect(
      `${url.origin}/cdn-cgi/access/login/${c.env.POLICY_AUD}`,
      302,
    );
  }
  return c.text("Login is unavailable: Cloudflare Access not configured.", 500);
});

app.post("/login", async (c) => {
  if (c.env.CF_ACCESS_DEV_MODE !== "mock") {
    // Production has no POST flow — the real Cloudflare Access page handles
    // credentials at the edge, not here.
    return c.redirect("/login", 303);
  }
  const form = await c.req.formData();
  const choice = (form.get("identity") ?? "").toString().trim();
  const customRaw = (form.get("custom_email") ?? "").toString().trim();
  const email = choice === "custom" ? customRaw : choice;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.html(
      renderDevLoginPicker(
        c.env,
        "Please pick a preset or enter a valid email.",
      ),
      400,
    );
  }
  const cookie = `x-mock-user-email=${encodeURIComponent(email)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`;
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/",
      "Set-Cookie": cookie,
      "Cache-Control": "no-store",
    },
  });
});

app.get("/logout", (c) => {
  // Clear the mock-identity cookie regardless of mode; in prod this is a
  // no-op since the cookie wouldn't be set, but we still send Max-Age=0
  // for hygiene and 302 to /login (which itself redirects to Access).
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/login",
      "Set-Cookie":
        "x-mock-user-email=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
      "Cache-Control": "no-store",
    },
  });
});

// Cloudflare Access JWT validation middleware.
//   CF_ACCESS_DEV_MODE=mock     → mock-Access shim (synthesized JWT shape)
//   import.meta.env.DEV (Vite)  → bypass (legacy: react-router dev path)
//   otherwise                   → real Cloudflare Access JWT verify
//
// `CF_ACCESS_DEV_MODE` is the explicit opt-in. It's set ONLY in `.dev.vars`
// (gitignored), so production deploys never carry it and always take the
// real-JWT branch. This gate works under both `react-router dev` AND bare
// `wrangler dev --local` (the latter doesn't set Vite's `import.meta.env.DEV`).
app.use("*", async (c, next) => {
  if (c.env.CF_ACCESS_DEV_MODE === "mock") {
    return mockAccessShim()(c, next);
  }
  if (import.meta.env.DEV || c.env.CF_ACCESS_DEV_MODE === "bypass") {
    return next();
  }

  const { POLICY_AUD, TEAM_DOMAIN } = c.env;

  // Fail closed in production if Access is not configured.
  if (!POLICY_AUD || !TEAM_DOMAIN) {
    return c.text(
      "Cloudflare Access must be configured in production. Set POLICY_AUD and TEAM_DOMAIN.",
      500,
    );
  }

  const token = c.req.header("cf-access-jwt-assertion");
  if (!token) {
    return c.text("Missing required CF Access JWT", 403);
  }

  try {
    const { issuer, certsUrl } = getAccessUrls(TEAM_DOMAIN);
    const JWKS = createRemoteJWKSet(certsUrl);
    const { payload } = await jwtVerify(token, JWKS, {
      issuer,
      audience: POLICY_AUD,
    });
    // Stash the verified payload so the (Phase 2) authzContext middleware
    // can read it without re-verifying.
    c.set("jwt", payload as JwtClaims);
  } catch {
    return c.text("Invalid or expired Access token", 403);
  }

  return next();
});

// Resolve (user_id, role, group_ids, authorized_mailbox_ids) from D1 once
// per request and pack into c.var.authzContext. Runs after auth so the
// JWT is already on c.var.jwt. Wildcard scope means /mcp routes also get
// it — service-token agents traverse the same authz path. The DO at the
// other end of /mcp doesn't see Hono's context; per-mailbox token
// enforcement (V2.5) will pass scope via headers.
app.use("*", authzContext());

// MCP server endpoint — used by AI coding tools (ProtoAgent, Claude Code, Cursor, etc.)
// Must be before API routes and React Router catch-all
const mcpHandler = EmailMCP.serve("/mcp", { binding: "EMAIL_MCP" });
app.all("/mcp", async (c) => {
  return mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);
});
app.all("/mcp/*", async (c) => {
  return mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);
});

// GET /api/admin/me — lightweight "who am I" for the admin UI client-side guard
app.get("/api/admin/me", (c) => {
  const ctx = c.var.authzContext;
  if (!ctx) return c.json({ error: "Unauthorized" }, 401);
  return c.json({ user_id: ctx.user_id, role: ctx.role });
});

// Admin API routes — require global_owner or global_admin (enforced inside each router)
const { default: adminUsersRouter } = await import("./routes/admin/users");
const { default: adminSettingsRouter } =
  await import("./routes/admin/settings");
app.route("/api/admin/users", adminUsersRouter);
app.route("/api/admin/settings", adminSettingsRouter);

// Groups + Invitations + Notifications routers (Phase 3)
const { default: groupsRouter } = await import("./routes/groups");
const { default: invitationsRouter } = await import("./routes/invitations");
const { default: notificationsRouter } = await import("./routes/notifications");
app.route("/api/groups", groupsRouter);
app.route("/api/invitations", invitationsRouter);
app.route("/api/notifications", notificationsRouter);

// Mailbox CRUD + share/transfer router (Phase 4 — D1-backed, distinct from /api/v1/mailboxes)
const { default: mailboxesRouter } = await import("./routes/mailboxes");
app.route("/api/mailboxes", mailboxesRouter);

// Mount the API routes
app.route("/", apiApp);

// Agent WebSocket routing - must be before React Router catch-all
app.all("/agents/*", async (c) => {
  const response = await routeAgentRequest(c.req.raw, c.env);
  if (response) return response;
  return c.text("Agent not found", 404);
});

// Test-only routes. Module-init time has no access to runtime bindings, so
// we always register them; each handler does its own runtime gate (Vite DEV
// flag OR CF_ACCESS_DEV_MODE binding present). The handlers 404 in prod.
const { default: testRoutes } = await import("./routes/__test__/email-ingest");
app.route("/api/__test__", testRoutes);

// React Router catch-all: serves the SPA for all non-API routes
app.all("*", (c) => {
  return requestHandler(c.req.raw, {
    cloudflare: { env: c.env, ctx: c.executionCtx as ExecutionContext },
  });
});

/**
 * Render the dev-mode `/login` mock-identity picker.
 *
 * Server-rendered as a single HTML template — no React, no client JS, no
 * dependency on the SSR runner-worker. The page references the hero asset
 * (`/anai-mail-login-hero.png`) that lives in `public/` and is served by
 * the static-assets binding. The PNG is transparent and looks correct on
 * both light and dark surfaces, so no per-theme variant is needed.
 *
 * Reads SW palette tokens via inline CSS so the picker looks branded even
 * when the React Router bundle hasn't loaded yet.
 *
 * Pure function — used by both GET (clean render) and POST (re-render with
 * an error message when the form submission was invalid).
 */
function renderDevLoginPicker(env: Env, errorMessage?: string): string {
  const presetA = "alice@actionnow.ai";
  const presetB = "bob@actionnow.ai";
  const owner = env.BOOTSTRAP_OWNER_EMAIL || presetA;
  const errorBanner = errorMessage
    ? `<p class="error">${escapeHtml(errorMessage)}</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sign in — ActionNow.AI</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<style>
  :root {
    color-scheme: light dark;
    --color-bg: #ece8e2;
    --color-card: #f0ede8;
    --color-border: #d4d0c8;
    --color-text: #2c2a26;
    --color-text-bright: #141310;
    --color-text-muted: #6b665c;
    --color-green: #1b7a28;
    --color-error: #c62828;
    --radius-panel: 17px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --color-bg: #1a1a1a;
      --color-card: #262626;
      --color-border: #383838;
      --color-text: #e0e0e0;
      --color-text-bright: #fafafa;
      --color-text-muted: #9e9e9e;
      --color-green: #4caf50;
      --color-error: #ef5350;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif;
    background: var(--color-bg);
    color: var(--color-text);
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px 16px;
  }
  main {
    width: 100%;
    max-width: 480px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 24px;
  }
  .hero {
    width: 280px;
    height: 280px;
    object-fit: contain;
    user-select: none;
    pointer-events: none;
  }
  h1 {
    margin: 0;
    font-size: 28px;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--color-text-bright);
  }
  .tagline {
    margin: -16px 0 0 0;
    font-size: 13px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-text-muted);
  }
  form {
    width: 100%;
    background: var(--color-card);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-panel);
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  fieldset {
    border: 0;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  legend {
    font-size: 13px;
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: 4px;
  }
  label.choice {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    border: 1px solid var(--color-border);
    border-radius: 12px;
    cursor: pointer;
    transition: border-color 0.12s;
    color: var(--color-text-bright);
  }
  label.choice:hover { border-color: var(--color-green); }
  label.choice input[type="radio"] { accent-color: var(--color-green); }
  label.choice .meta {
    margin-left: auto;
    font-size: 12px;
    color: var(--color-text-muted);
  }
  .custom-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    border: 1px solid var(--color-border);
    border-radius: 12px;
    color: var(--color-text-bright);
  }
  .custom-row input[type="email"] {
    flex: 1;
    background: transparent;
    border: 0;
    outline: 0;
    font-size: 14px;
    font-family: inherit;
    color: var(--color-text-bright);
  }
  button.primary {
    background: var(--color-green);
    color: #fff;
    border: 0;
    border-radius: 12px;
    padding: 12px 18px;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
    transition: filter 0.12s;
  }
  button.primary:hover { filter: brightness(1.06); }
  button.primary:active { filter: brightness(0.94); }
  .footnote {
    font-size: 12px;
    color: var(--color-text-muted);
    text-align: center;
    margin: 0;
  }
  .error {
    margin: 0;
    padding: 10px 14px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--color-error) 15%, transparent);
    color: var(--color-error);
    font-size: 13px;
  }
</style>
</head>
<body>
<main>
  <img class="hero" src="/anai-mail-login-hero.png" alt="" aria-hidden="true" />
  <h1>ActionNow.AI</h1>
  <p class="tagline">Trusted Agent Inbox</p>
  <form method="post" action="/login" autocomplete="off" novalidate>
    ${errorBanner}
    <fieldset>
      <legend>Sign in as</legend>
      <label class="choice">
        <input type="radio" name="identity" value="${escapeHtml(owner)}" checked />
        <span><strong>${escapeHtml(owner)}</strong></span>
        <span class="meta">global owner</span>
      </label>
      <label class="choice">
        <input type="radio" name="identity" value="${escapeHtml(presetB)}" />
        <span><strong>${escapeHtml(presetB)}</strong></span>
        <span class="meta">user · group: marketing</span>
      </label>
      <label class="choice">
        <input type="radio" name="identity" value="custom" />
        <span><strong>Custom email</strong></span>
      </label>
      <div class="custom-row">
        <span class="meta">@</span>
        <input type="email" name="custom_email" placeholder="someone@actionnow.ai" />
      </div>
    </fieldset>
    <button class="primary" type="submit">Continue</button>
    <p class="footnote">Local development only — production uses Cloudflare Access.</p>
  </form>
</main>
</body>
</html>`;
}

/** Minimal HTML escape for inline string interpolation. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Export the Hono app as the default export with an email handler
export default {
  fetch: app.fetch,
  async email(
    event: { raw: ReadableStream; rawSize: number },
    env: Env,
    ctx: ExecutionContext,
  ) {
    try {
      await receiveEmail(event, env, ctx);
    } catch (e) {
      console.error(
        "Failed to process incoming email:",
        (e as Error).message,
        (e as Error).stack,
      );
      // Re-throw so Cloudflare's email routing can retry delivery or bounce the message.
      // Swallowing the error would silently drop the email.
      throw e;
    }
  },
};
