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
