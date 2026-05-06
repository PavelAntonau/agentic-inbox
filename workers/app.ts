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
import { createAuth } from "./auth";
import { requireMailboxV2 } from "./lib/mailbox-v2";
import type { Env } from "./types";

/**
 * Phase 6.1 — paths that bypass the CF Access JWT requirement so the new
 * better-auth surface is reachable while CF Access still gates everything
 * else. Removed in Phase 6.2 once we cut over fully.
 */
const PUBLIC_AUTH_PATHS = [
  "/login",
  "/api/auth/", // better-auth handler
  "/.well-known/", // OAuth discovery (Phase 6.3 — added now to avoid churn)
  // T2.1 (mcp-oauth) — branded OAuth consent screen. External MCP clients
  // (Claude Code etc.) hit /consent through the plugin's authorize redirect;
  // they MUST be able to reach the route without first holding a CF Access
  // session (the loader does its own better-auth session check + 302 to
  // /login when needed). T3.5 codifies the full CF-Access removal.
  "/consent",
  // T2.2 (mcp-oauth) — issuer-root JWKS alias. better-auth's jwt() plugin
  // mounts JWKS at /api/auth/jwks; the discovery doc advertises /jwks per
  // RFC convention. CF Access dashboard widening (T3.5) is the user-side
  // cutover step that exposes this to unauthenticated MCP clients.
  "/jwks",
  // T2.2 (mcp-oauth) — bearer-only on /mcp per D-mcp-auth anti-pattern
  // 0olzaspBOKxkzjp2AZRkV. CF Access JWT MUST NOT gate /mcp; the bearer
  // middleware below validates the OAuth access token instead.
  "/mcp",
];

function isPublicAuthPath(pathname: string): boolean {
  return PUBLIC_AUTH_PATHS.some((p) => pathname.startsWith(p));
}

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

// Phase 6.1 — better-auth handler. MUST be registered BEFORE the CF Access
// JWT middleware so /api/auth/* requests reach the handler without first
// requiring a CF Access token (the whole point of the new auth surface).
// The path-allowlist below ALSO excludes /api/auth/* from the JWT check so
// even if a request slipped through ordering, the bypass still applies.
app.on(["GET", "POST"], "/api/auth/*", async (c) => {
  const auth = createAuth(c.env);
  return auth.handler(c.req.raw);
});

// T2.2 (mcp-oauth) — RFC 8414 / RFC 9728 discovery handlers + /jwks alias.
// MUST be registered BEFORE the CF Access JWT middleware AND covered by
// PUBLIC_AUTH_PATHS so external MCP clients can complete OAuth discovery
// without first holding a CF Access session. The edge-level CF Access policy
// is the second gate the user widens via dashboard (T3.5 codifies the full
// removal). T1.5 progress note 4 is the source of these mounts.
app.options("/.well-known/oauth-authorization-server", async () => {
  const { handleDiscoveryPreflight } = await import("./middleware/discovery");
  return handleDiscoveryPreflight();
});
app.get("/.well-known/oauth-authorization-server", async () => {
  const { handleAuthorizationServerMetadata } =
    await import("./middleware/discovery");
  return handleAuthorizationServerMetadata();
});
app.options("/.well-known/oauth-protected-resource", async () => {
  const { handleDiscoveryPreflight } = await import("./middleware/discovery");
  return handleDiscoveryPreflight();
});
app.get("/.well-known/oauth-protected-resource", async () => {
  const { handleProtectedResourceMetadata } =
    await import("./middleware/discovery");
  return handleProtectedResourceMetadata();
});
app.options("/jwks", async () => {
  const { handleDiscoveryPreflight } = await import("./middleware/discovery");
  return handleDiscoveryPreflight();
});
app.get("/jwks", async (c) => {
  const { handleJwks } = await import("./middleware/discovery");
  return handleJwks(c.env);
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
//
// Phase 6.1: bypass for /login + /api/auth/* + /.well-known/* so the new
// better-auth surface is reachable. Everything else still requires CF Access
// during the parallel-mode period; full cutover happens in Phase 6.2.
app.use("*", async (c, next) => {
  if (isPublicAuthPath(new URL(c.req.url).pathname)) {
    return next();
  }
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
// Must be before API routes and React Router catch-all.
//
// T2.2 (mcp-oauth) — bearer-only authentication. The /mcp path is in
// PUBLIC_AUTH_PATHS so the CF Access JWT middleware bypasses it; the bearer
// middleware below validates the OAuth access token instead. Session cookies
// are rejected outright (D-mcp-auth anti-pattern 0olzaspBOKxkzjp2AZRkV).
// Streamable HTTP is the default transport (`McpAgent.serve` per
// `node_modules/agents/dist/index-WBy5hmm3.d.ts:344`).
//
// T3.6 (security audit 2026-05-06, Phase 4) — per-tool scope, PAT IP
// allowlist, PAT mailbox_id binding, and list_mailboxes authzContext
// narrowing all enforce here, BEFORE the McpAgent DO is invoked. See
// workers/lib/mcp-tool-policy.ts and workers/lib/mcp-list-mailboxes.ts.
const mcpHandler = EmailMCP.serve("/mcp", { binding: "EMAIL_MCP" });

async function dispatchMcpRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // OPTIONS preflight: bypass auth so browser-based MCP clients can probe.
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, MCP-Protocol-Version, MCP-Session-Id",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  const { validateBearer, bearerChallengeResponse } =
    await import("./middleware/oauth-bearer");
  const { extractMcpMethod, buildAuditRow, writeMcpAuditRow } =
    await import("./middleware/audit-log-mcp");
  const {
    extractToolCall,
    getRequiredScope,
    isIpInAllowlist,
    resolveMailboxToId,
    insufficientScopeResponse,
    MAILBOX_BOUND_TOOLS,
  } = await import("./lib/mcp-tool-policy");
  const { buildAuthzContextFromUserId } =
    await import("./lib/mcp-list-mailboxes");

  const startedAt = Date.now();
  const bearer = await validateBearer(request, env);
  if (!bearer.ok) {
    return bearerChallengeResponse(bearer.reason, bearer.bearer_error);
  }

  // Extract MCP method/tool BEFORE consuming the body downstream — clones the
  // request internally so the McpAgent still gets the original body.
  const { method, tool } = await extractMcpMethod(request);

  const finishAudit = (
    response: Response,
    auditMethod: string | null,
    auditTool: string | null,
  ): void => {
    const auditRow = buildAuditRow({
      bearer,
      request,
      http_status: response.status,
      duration_ms: Date.now() - startedAt,
      mcp_method: auditMethod,
      tool_name: auditTool,
    });
    ctx.waitUntil(writeMcpAuditRow(env, auditRow));
  };

  // ── P0-3: PAT IP allowlist (runs for every request, not just tools/call) ─
  if (
    bearer.source === "pat" &&
    bearer.ip_allowlist &&
    bearer.ip_allowlist.length > 0
  ) {
    const sourceIp = request.headers.get("cf-connecting-ip");
    if (!isIpInAllowlist(sourceIp, bearer.ip_allowlist)) {
      const r = insufficientScopeResponse("pat-ip-not-allowed");
      finishAudit(r, method, tool);
      return r;
    }
  }

  // ── tools/call enforcement — P0-2 + P0-3 mailbox + P0-4 list_mailboxes ──
  if (method === "tools/call" && tool) {
    // P0-2: per-tool required scope.
    const required = getRequiredScope(tool);
    if (required && !bearer.scopes.includes(required)) {
      const r = insufficientScopeResponse("tool-scope-required", {
        tool,
        required_scope: required,
      });
      finishAudit(r, method, tool);
      return r;
    }

    // P0-3: PAT mailbox_id binding for mailbox-bound tools.
    if (
      bearer.source === "pat" &&
      bearer.mailbox_id !== null &&
      bearer.mailbox_id !== undefined &&
      MAILBOX_BOUND_TOOLS.has(tool)
    ) {
      const toolCall = await extractToolCall(request);
      const mailboxArg = toolCall.arguments?.mailboxId;
      if (typeof mailboxArg !== "string" || !mailboxArg) {
        const r = insufficientScopeResponse("pat-mailbox-arg-required", {
          tool,
        });
        finishAudit(r, method, tool);
        return r;
      }
      const resolvedId = await resolveMailboxToId(env, mailboxArg);
      if (!resolvedId || resolvedId !== bearer.mailbox_id) {
        const r = insufficientScopeResponse("pat-mailbox-mismatch", { tool });
        finishAudit(r, method, tool);
        return r;
      }
    }

    // ── C-01 (Phase C1) — per-call user-authz mailbox narrowing. ───────
    //
    // Closes the OAuth-JWT IDOR caught by Phase B walkthrough (T-B-C).
    // T3.6 closed the PAT path via `bearer.mailbox_id` binding above; that
    // check only fires when a PAT was minted with a mailbox_id constraint.
    // OAuth JWT bearers (and PATs minted without a mailbox_id) had NO
    // per-call narrowing, so a JWT for user X could call e.g.
    // `tools/call get_email mailboxId=<other-user-mailbox>` and read X's
    // peer's mail directly.
    //
    // Posture: build an authzContext from `bearer.user_id` (intersected
    // with PAT mailbox_id when set), resolve the supplied `mailboxId`
    // argument to its canonical D1 row id, and assert membership in
    // `authorized_mailbox_ids`. global_owner / global_admin still pass
    // (operational ceiling) — peer narrowing only restricts non-global
    // roles, mirroring V1's `requireMailbox` posture.
    //
    // `list_mailboxes` is excluded from MAILBOX_BOUND_TOOLS; it has its
    // own narrowing path immediately below (it never carries a
    // `mailboxId` argument).
    if (MAILBOX_BOUND_TOOLS.has(tool)) {
      const toolCall = await extractToolCall(request);
      const mailboxArg = toolCall.arguments?.mailboxId;
      if (typeof mailboxArg !== "string" || !mailboxArg) {
        const r = insufficientScopeResponse("tool-mailbox-arg-required", {
          tool,
        });
        finishAudit(r, method, tool);
        return r;
      }
      const resolvedId = await resolveMailboxToId(env, mailboxArg);
      if (!resolvedId) {
        const r = insufficientScopeResponse("mailbox-not-authorized", {
          tool,
        });
        finishAudit(r, method, tool);
        return r;
      }
      const patMailboxId =
        bearer.source === "pat" ? (bearer.mailbox_id ?? null) : null;
      const userCtx = await buildAuthzContextFromUserId(
        env,
        bearer.user_id,
        patMailboxId,
      );
      const isGlobal =
        userCtx?.role === "global_owner" || userCtx?.role === "global_admin";
      if (
        !userCtx ||
        (!isGlobal && !userCtx.authorized_mailbox_ids.includes(resolvedId))
      ) {
        const r = insufficientScopeResponse("mailbox-not-authorized", {
          tool,
        });
        finishAudit(r, method, tool);
        return r;
      }
    }

    // P0-4: list_mailboxes short-circuit with authzContext narrowing.
    // Bypasses the DO entirely — list_mailboxes has no DO state.
    if (tool === "list_mailboxes") {
      const { serveListMailboxes } = await import("./lib/mcp-list-mailboxes");
      const toolCall = await extractToolCall(request);
      const patMailboxId =
        bearer.source === "pat" ? (bearer.mailbox_id ?? null) : null;
      const r = await serveListMailboxes(
        env,
        bearer.user_id,
        patMailboxId,
        toolCall.id,
      );
      finishAudit(r, method, tool);
      return r;
    }
  }

  const response = await mcpHandler.fetch(request, env, ctx);
  finishAudit(response, method, tool);
  return response;
}
app.all("/mcp", (c) =>
  dispatchMcpRequest(c.req.raw, c.env, c.executionCtx as ExecutionContext),
);
app.all("/mcp/*", (c) =>
  dispatchMcpRequest(c.req.raw, c.env, c.executionCtx as ExecutionContext),
);

// GET /api/admin/me — lightweight "who am I" for the admin UI client-side guard
app.get("/api/admin/me", (c) => {
  const ctx = c.var.authzContext;
  if (!ctx) return c.json({ error: "Unauthorized" }, 401);
  return c.json({ user_id: ctx.user_id, role: ctx.role });
});

// GET /api/users/me — current user including visibility (Phase 6), avatar (Phase 3b),
// and profile fields account_type + company (Phase 4).
app.get("/api/users/me", async (c) => {
  const ctx = c.var.authzContext;
  if (!ctx) return c.json({ error: "Unauthorized" }, 401);
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq } = await import("drizzle-orm");
  const schema = await import("./db/control-plane/schema");
  const orm = drizzle(c.env.DB, { schema });
  const user = await orm
    .select({
      id: schema.users.id,
      email: schema.users.email,
      display_name: schema.users.display_name,
      role: schema.users.role,
      visibility: schema.users.visibility,
      avatar_url: schema.users.avatar_url,
      account_type: schema.users.account_type,
      company: schema.users.company,
    })
    .from(schema.users)
    .where(eq(schema.users.id, ctx.user_id))
    .get();
  if (!user) return c.json({ error: "User not found" }, 404);
  // Expose a worker-served URL with content-hash cache-buster, not the raw R2 key.
  const avatarKey = user.avatar_url;
  const avatarUrl = avatarKey
    ? `/avatars/${user.id}?v=${avatarKey.split("/").pop()?.split(".")[0]?.slice(0, 8) ?? "0"}`
    : null;
  return c.json({ ...user, avatar_url: avatarUrl });
});

// POST /api/users/me/avatar — upload + persist (Phase 3b)
//
// Multipart form, single field 'file'. Validates png/jpeg/webp ≤ 2 MB.
// Stores at R2 key avatars/<user_id>/<sha256>.<ext> (content-addressed,
// natural cache-busting). Replaces any prior avatar; deletes the old R2
// object best-effort in waitUntil. Returns the worker-served URL.
app.post("/api/users/me/avatar", async (c) => {
  const ctx = c.var.authzContext;
  if (!ctx) return c.json({ error: "Unauthorized" }, 401);

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ error: "expected multipart/form-data" }, 400);
  }
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "file required (multipart field 'file')" }, 400);
  }

  const allowedExt: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
  };
  const ext = allowedExt[file.type];
  if (!ext) {
    return c.json({ error: "unsupported type — png, jpeg, or webp only" }, 415);
  }
  if (file.size === 0) {
    return c.json({ error: "empty file" }, 400);
  }
  if (file.size > 2 * 1024 * 1024) {
    return c.json({ error: "file too large — max 2 MB" }, 413);
  }

  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const hash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const objectKey = `avatars/${ctx.user_id}/${hash}.${ext}`;

  await c.env.BUCKET.put(objectKey, buf, {
    httpMetadata: { contentType: file.type },
  });

  // Optional `original` field — preserves the pre-crop source so the user
  // can re-adjust later via the AvatarCropDialog "edit existing" path.
  // Stored at the same hash with an `-orig` suffix so the original can be
  // located deterministically from the avatar's object key without a new
  // DB column. Best-effort: any failure here doesn't fail the upload.
  const originalField = formData.get("original");
  if (originalField instanceof File && originalField.size > 0) {
    const origExt = allowedExt[originalField.type] ?? "jpg";
    if (originalField.size <= 4 * 1024 * 1024) {
      const origKey = `avatars/${ctx.user_id}/${hash}-orig.${origExt}`;
      try {
        const origBuf = await originalField.arrayBuffer();
        await c.env.BUCKET.put(origKey, origBuf, {
          httpMetadata: { contentType: originalField.type },
        });
      } catch {
        // Best-effort — keep the cropped upload regardless.
      }
    }
  }

  const { drizzle } = await import("drizzle-orm/d1");
  const { eq } = await import("drizzle-orm");
  const schema = await import("./db/control-plane/schema");
  const { appendAudit } = await import("./lib/audit-log");
  const orm = drizzle(c.env.DB, { schema });

  const prev = await orm
    .select({ avatar_url: schema.users.avatar_url })
    .from(schema.users)
    .where(eq(schema.users.id, ctx.user_id))
    .get();

  await orm
    .update(schema.users)
    .set({ avatar_url: objectKey })
    .where(eq(schema.users.id, ctx.user_id))
    .run();

  if (prev?.avatar_url && prev.avatar_url !== objectKey) {
    c.executionCtx.waitUntil(
      c.env.BUCKET.delete(prev.avatar_url).catch(() => {}),
    );
  }

  await appendAudit(
    c.env.DB,
    ctx,
    "avatar.set",
    { kind: "user", id: ctx.user_id },
    { object_key: objectKey, size: file.size, content_type: file.type },
  );

  return c.json({
    ok: true,
    avatar_url: `/avatars/${ctx.user_id}?v=${hash.slice(0, 8)}`,
  });
});

// DELETE /api/users/me/avatar — clear avatar (Phase 3b)
app.delete("/api/users/me/avatar", async (c) => {
  const ctx = c.var.authzContext;
  if (!ctx) return c.json({ error: "Unauthorized" }, 401);

  const { drizzle } = await import("drizzle-orm/d1");
  const { eq } = await import("drizzle-orm");
  const schema = await import("./db/control-plane/schema");
  const { appendAudit } = await import("./lib/audit-log");
  const orm = drizzle(c.env.DB, { schema });

  const prev = await orm
    .select({ avatar_url: schema.users.avatar_url })
    .from(schema.users)
    .where(eq(schema.users.id, ctx.user_id))
    .get();

  await orm
    .update(schema.users)
    .set({ avatar_url: null })
    .where(eq(schema.users.id, ctx.user_id))
    .run();

  if (prev?.avatar_url) {
    c.executionCtx.waitUntil(
      Promise.all([
        c.env.BUCKET.delete(prev.avatar_url).catch(() => {}),
        // Best-effort cleanup of the matching original — derived from the
        // displayed avatar key (avatars/<uid>/<hash>.<ext> ->
        // avatars/<uid>/<hash>-orig.*); we don't know the original's ext,
        // so try the three legal candidates.
        ...(["jpg", "png", "webp"] as const).map((e) =>
          c.env.BUCKET.delete(
            prev.avatar_url!.replace(/\.[a-z]+$/, `-orig.${e}`),
          ).catch(() => {}),
        ),
      ]).then(() => undefined),
    );
  }

  await appendAudit(
    c.env.DB,
    ctx,
    "avatar.clear",
    { kind: "user", id: ctx.user_id },
    {},
  );

  return c.json({ ok: true });
});

// GET /avatars/:userId — fetch a user's avatar (Phase 3b)
//
// Any authenticated session may fetch any user's avatar. Visibility-
// gated access is a Phase 4/5 concern when the field starts driving
// discovery; for now any user with a set avatar is fetchable.
app.get("/avatars/:userId", async (c) => {
  const ctx = c.var.authzContext;
  if (!ctx) return c.json({ error: "Unauthorized" }, 401);

  const userId = c.req.param("userId");
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq } = await import("drizzle-orm");
  const schema = await import("./db/control-plane/schema");
  const orm = drizzle(c.env.DB, { schema });

  const user = await orm
    .select({ avatar_url: schema.users.avatar_url })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .get();

  if (!user?.avatar_url) {
    return c.json({ error: "no avatar" }, 404);
  }

  const obj = await c.env.BUCKET.get(user.avatar_url);
  if (!obj) {
    return c.json({ error: "no avatar" }, 404);
  }

  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType ?? "image/png",
      "Cache-Control": "public, max-age=86400, must-revalidate",
      ETag: obj.httpEtag,
    },
  });
});

// GET /avatars/:userId/original — fetch the pre-crop original (UAT round 1
// item 6). Returns 404 if no original was stored alongside the displayed
// avatar (legacy avatars uploaded before dual-storage shipped). Same auth
// posture as GET /avatars/:userId.
app.get("/avatars/:userId/original", async (c) => {
  const ctx = c.var.authzContext;
  if (!ctx) return c.json({ error: "Unauthorized" }, 401);

  const userId = c.req.param("userId");
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq } = await import("drizzle-orm");
  const schema = await import("./db/control-plane/schema");
  const orm = drizzle(c.env.DB, { schema });

  const user = await orm
    .select({ avatar_url: schema.users.avatar_url })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .get();

  if (!user?.avatar_url) {
    return c.json({ error: "no avatar" }, 404);
  }

  // Try each legal extension in turn — we don't know which the user
  // uploaded as their original (could differ from the displayed-avatar ext
  // since the cropped output is always JPEG).
  for (const ext of ["jpg", "png", "webp"] as const) {
    const key = user.avatar_url.replace(/\.[a-z]+$/, `-orig.${ext}`);
    const obj = await c.env.BUCKET.get(key);
    if (obj) {
      return new Response(obj.body, {
        headers: {
          "Content-Type": obj.httpMetadata?.contentType ?? "image/jpeg",
          "Cache-Control": "private, max-age=300, must-revalidate",
          ETag: obj.httpEtag,
        },
      });
    }
  }

  return c.json({ error: "no original" }, 404);
});

// PATCH /api/users/me/visibility — update own visibility setting (Phase 6)
app.patch("/api/users/me/visibility", async (c) => {
  const ctx = c.var.authzContext;
  if (!ctx) return c.json({ error: "Unauthorized" }, 401);

  let body: { visibility?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const visibility = body.visibility;
  if (
    visibility !== "everyone" &&
    visibility !== "contacts" &&
    visibility !== "nobody"
  ) {
    return c.json(
      { error: "visibility must be 'everyone' | 'contacts' | 'nobody'" },
      400,
    );
  }

  const { drizzle } = await import("drizzle-orm/d1");
  const { eq } = await import("drizzle-orm");
  const schema = await import("./db/control-plane/schema");
  const { appendAudit } = await import("./lib/audit-log");
  const orm = drizzle(c.env.DB, { schema });

  // Read current value for audit
  const current = await orm
    .select({ visibility: schema.users.visibility })
    .from(schema.users)
    .where(eq(schema.users.id, ctx.user_id))
    .get();

  await orm
    .update(schema.users)
    .set({ visibility })
    .where(eq(schema.users.id, ctx.user_id))
    .run();

  await appendAudit(
    c.env.DB,
    ctx,
    "visibility.change",
    { kind: "user", id: ctx.user_id },
    { from: current?.visibility ?? null, to: visibility },
  );

  return c.json({ ok: true, visibility });
});

// PATCH /api/users/me/profile — update profile fields (Phase 4)
//
// Accepts any subset of: display_name, account_type, company.
// Each field validated independently; null-clears display_name and company,
// account_type cannot be cleared (NOT NULL DEFAULT 'personal').
app.patch("/api/users/me/profile", async (c) => {
  const ctx = c.var.authzContext;
  if (!ctx) return c.json({ error: "Unauthorized" }, 401);

  let body: {
    display_name?: unknown;
    account_type?: unknown;
    company?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const updates: {
    display_name?: string | null;
    account_type?: "personal" | "company";
    company?: string | null;
  } = {};

  if ("display_name" in body) {
    const v = body.display_name;
    if (v === null) {
      updates.display_name = null;
    } else if (typeof v === "string") {
      const trimmed = v.trim();
      if (trimmed.length > 100) {
        return c.json({ error: "display_name too long (max 100)" }, 400);
      }
      updates.display_name = trimmed.length === 0 ? null : trimmed;
    } else {
      return c.json({ error: "display_name must be string or null" }, 400);
    }
  }

  if ("account_type" in body) {
    const v = body.account_type;
    if (v !== "personal" && v !== "company") {
      return c.json(
        { error: "account_type must be 'personal' or 'company'" },
        400,
      );
    }
    updates.account_type = v;
  }

  if ("company" in body) {
    const v = body.company;
    if (v === null) {
      updates.company = null;
    } else if (typeof v === "string") {
      const trimmed = v.trim();
      if (trimmed.length > 200) {
        return c.json({ error: "company too long (max 200)" }, 400);
      }
      updates.company = trimmed.length === 0 ? null : trimmed;
    } else {
      return c.json({ error: "company must be string or null" }, 400);
    }
  }

  if (Object.keys(updates).length === 0) {
    return c.json({ error: "no fields to update" }, 400);
  }

  const { drizzle } = await import("drizzle-orm/d1");
  const { eq } = await import("drizzle-orm");
  const schema = await import("./db/control-plane/schema");
  const { appendAudit } = await import("./lib/audit-log");
  const orm = drizzle(c.env.DB, { schema });

  // Snapshot current values for audit (only the keys being updated).
  const before = await orm
    .select({
      display_name: schema.users.display_name,
      account_type: schema.users.account_type,
      company: schema.users.company,
    })
    .from(schema.users)
    .where(eq(schema.users.id, ctx.user_id))
    .get();

  await orm
    .update(schema.users)
    .set(updates)
    .where(eq(schema.users.id, ctx.user_id))
    .run();

  const auditMeta: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(updates) as (keyof typeof updates)[]) {
    auditMeta[k] = { from: before?.[k] ?? null, to: updates[k] ?? null };
  }
  await appendAudit(
    c.env.DB,
    ctx,
    "profile.update",
    { kind: "user", id: ctx.user_id },
    auditMeta,
  );

  // Return the merged updated profile so the client can refresh state in one round-trip.
  const after = await orm
    .select({
      id: schema.users.id,
      email: schema.users.email,
      display_name: schema.users.display_name,
      role: schema.users.role,
      visibility: schema.users.visibility,
      account_type: schema.users.account_type,
      company: schema.users.company,
    })
    .from(schema.users)
    .where(eq(schema.users.id, ctx.user_id))
    .get();

  return c.json({ ok: true, profile: after });
});

// POST /api/users/discover-by-email — Phase 5 / D11
//
// Constant-shape email-discovery endpoint. Always returns 200 { ok: true }
// regardless of whether the email matches a user, whether that user is
// hidden ('nobody' visibility), or whether the lookup succeeded at all.
//
// Three branches with equivalent DB round-trips:
//   1. match + status='active' + visibility != 'nobody' + not-self
//      → upsert pending contact request (mirrors /api/contacts/request).
//   2. match + visibility == 'nobody' (or self / disabled)
//      → silent no-op; sentinel-target queries still fire.
//   3. no match
//      → silent no-op; sentinel-target queries still fire.
//
// Sender CANNOT distinguish: same JSON body, same status, same headers, same
// query pattern (block check + existing-row check always run, even on
// no-match / hidden, against a sentinel target id). Audit row is always
// emitted (`contact.discover_attempt`) so write count is constant; the row
// is admin-only-readable via /api/admin/obs/audit (workers/routes/observability.ts).
app.post("/api/users/discover-by-email", async (c) => {
  const ctx = c.var.authzContext;
  if (!ctx) return c.json({ error: "Unauthorized" }, 401);

  let body: { email?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // Trivial input validation. The 400 here fires BEFORE any DB lookup so it
  // cannot leak existence information — same 400 whether the would-have-matched
  // user existed or not.
  const raw = typeof body.email === "string" ? body.email.trim() : "";
  if (!raw || raw.length > 320 || !raw.includes("@")) {
    return c.json({ error: "valid email required" }, 400);
  }

  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, and, or, sql } = await import("drizzle-orm");
  const schema = await import("./db/control-plane/schema");
  const { appendAudit } = await import("./lib/audit-log");
  const orm = drizzle(c.env.DB, { schema });

  // Lookup by case-insensitive email (same path as users_email_nocase index).
  const target = await orm
    .select({
      id: schema.users.id,
      visibility: schema.users.visibility,
      status: schema.users.status,
    })
    .from(schema.users)
    .where(sql`lower(${schema.users.email}) = lower(${raw})`)
    .get();

  const shouldCreate =
    target !== undefined &&
    target.status === "active" &&
    target.visibility !== "nobody" &&
    target.id !== ctx.user_id;

  // Sentinel target id when no match — keeps subsequent query shapes stable.
  const targetId = target?.id ?? "00000000-0000-0000-0000-000000000000";

  // Block check (mirrors /api/contacts/request): always runs.
  await orm
    .select({
      owner_user_id: schema.contacts.owner_user_id,
      contact_user_id: schema.contacts.contact_user_id,
      status: schema.contacts.status,
    })
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.status, "blocked"),
        or(
          and(
            eq(schema.contacts.owner_user_id, ctx.user_id),
            eq(schema.contacts.contact_user_id, targetId),
          ),
          and(
            eq(schema.contacts.owner_user_id, targetId),
            eq(schema.contacts.contact_user_id, ctx.user_id),
          ),
        ),
      ),
    )
    .all();

  // Existing-relationship check (mirrors /api/contacts/request): always runs.
  await orm
    .select()
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.owner_user_id, ctx.user_id),
        eq(schema.contacts.contact_user_id, targetId),
      ),
    )
    .get();

  const now = Date.now();

  if (shouldCreate) {
    await orm
      .insert(schema.contacts)
      .values({
        owner_user_id: ctx.user_id,
        contact_user_id: targetId,
        status: "pending",
        initiated_by: ctx.user_id,
        created_at: now,
        accepted_at: null,
      })
      .onConflictDoUpdate({
        target: [
          schema.contacts.owner_user_id,
          schema.contacts.contact_user_id,
        ],
        set: { status: "pending", initiated_by: ctx.user_id, created_at: now },
      })
      .run();
  }

  // Always emit audit row — keeps write count constant across branches.
  await appendAudit(
    c.env.DB,
    ctx,
    "contact.discover_attempt",
    { kind: "user", id: target?.id ?? "no-match" },
    { matched: target !== undefined, created: shouldCreate },
  );

  return c.json({ ok: true });
});

// GET /api/users/search?q=<prefix> — Phase 5 user search by display_name / email
//
// Returns users whose visibility allows discovery by the caller:
//   - visibility='everyone' → always
//   - visibility='contacts' → only if caller is in accepted contacts
//   - visibility='nobody'   → never
// Excludes self, disabled accounts. Prefix match on lowercase
// display_name OR email. Returns up to 10 matches.
app.get("/api/users/search", async (c) => {
  const ctx = c.var.authzContext;
  if (!ctx) return c.json({ error: "Unauthorized" }, 401);

  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  if (q.length < 2) return c.json({ users: [] });
  if (q.length > 100) return c.json({ error: "query too long" }, 400);

  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, and, or, ne, sql } = await import("drizzle-orm");
  const schema = await import("./db/control-plane/schema");
  const orm = drizzle(c.env.DB, { schema });

  // Set of contact_user_ids the actor has an accepted relationship with.
  const accepted = await orm
    .select({ contact_user_id: schema.contacts.contact_user_id })
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.owner_user_id, ctx.user_id),
        eq(schema.contacts.status, "accepted"),
      ),
    )
    .all();
  const acceptedIds = new Set(accepted.map((r) => r.contact_user_id));

  const prefix = q + "%";
  const candidates = await orm
    .select({
      id: schema.users.id,
      display_name: schema.users.display_name,
      email: schema.users.email,
      visibility: schema.users.visibility,
      account_type: schema.users.account_type,
      company: schema.users.company,
      avatar_url: schema.users.avatar_url,
    })
    .from(schema.users)
    .where(
      and(
        eq(schema.users.status, "active"),
        ne(schema.users.id, ctx.user_id),
        or(
          sql`lower(${schema.users.display_name}) LIKE ${prefix}`,
          sql`lower(${schema.users.email}) LIKE ${prefix}`,
        ),
      ),
    )
    .limit(50)
    .all();

  const filtered = candidates
    .filter((u) => {
      if (u.visibility === "everyone") return true;
      if (u.visibility === "contacts") return acceptedIds.has(u.id);
      return false;
    })
    .slice(0, 10)
    .map((u) => ({
      id: u.id,
      display_name: u.display_name,
      email: u.email,
      account_type: u.account_type,
      company: u.company,
      avatar_url: u.avatar_url
        ? `/avatars/${u.id}?v=${u.avatar_url.split("/").pop()?.split(".")[0]?.slice(0, 8) ?? "0"}`
        : null,
    }));

  return c.json({ users: filtered });
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

// Phase C1 / B-01 + B-02 + B-04 sibling — V2 mailbox-narrow gate. Mounted
// BEFORE the three V2 routers below so any /api/mailboxes/:mailboxId/* hit
// is authz-narrowed to the caller's `authorized_mailbox_ids`. Reserved
// segments (currently just `tree`) pass through unchanged. The bare-path
// mount handles `DELETE /api/mailboxes/:id` (the V2 mailbox-delete) which
// is structurally outside the wildcard pattern, mirroring V1's bare-path
// requireMailbox mount in workers/index.ts (B-04).
app.use("/api/mailboxes/:mailboxId", requireMailboxV2);
app.use("/api/mailboxes/:mailboxId/*", requireMailboxV2);

// Mailbox CRUD + share/transfer router (Phase 4 — D1-backed, distinct from /api/v1/mailboxes)
const { default: mailboxesRouter } = await import("./routes/mailboxes");
app.route("/api/mailboxes", mailboxesRouter);

// Agent tokens router unmounted (user directive 2026-05-03 — phasing out the
// entire token surface; will be replaced by a session-connection-status view).
// Source kept at workers/routes/tokens.ts for now; safe to remove in a follow-up.

// Sessions router (Phase 1 — list/revoke sessions)
const { default: sessionsRouter } = await import("./routes/sessions");
app.route("/api/users/me/sessions", sessionsRouter);

// Clients router (Phase 2 — unified client + grant management)
const { default: clientsRouter } = await import("./routes/clients");
app.route("/api/users/me/clients", clientsRouter);

// Agent-authorizations router (Phase 2 / T2.3 mcp-oauth — Connected Agents API)
const { default: agentAuthorizationsRouter } =
  await import("./routes/agent-authorizations");
app.route("/api/users/me/agent-authorizations", agentAuthorizationsRouter);

// PAT router (Phase 3 / T3.1 mcp-oauth — Personal Access Tokens, display-once)
const { default: patsRouter } = await import("./routes/pats");
app.route("/api/users/me/pats", patsRouter);

// Inbox-policies router (Phase 2 — external/internal inbound policy)
const { default: inboxPoliciesRouter } =
  await import("./routes/inbox-policies");
app.route("/api/mailboxes", inboxPoliciesRouter);

// Threads router (Phase 2 — ff-only CAS thread writes, D-PLAT-5)
const { default: threadsRouter } = await import("./routes/threads");
app.route("/api/mailboxes", threadsRouter);

// Observability router (Phase 6 — admin obs panels)
const { default: observabilityRouter } = await import("./routes/observability");
app.route("/api/admin/obs", observabilityRouter);

// Contacts router (Phase 6 — request/accept/decline/block)
const { default: contactsRouter } = await import("./routes/contacts");
app.route("/api/contacts", contactsRouter);

// Mount the API routes
app.route("/", apiApp);

// Phase C1 / C-02 — /agents/* per-mailbox authz gate.
//
// The Cloudflare Agents SDK routes `/agents/<kebab-class>/<name>[/<sub>]`
// to a Durable Object keyed on `<name>`. For `EmailAgent` the kebab class
// is `email-agent` and `<name>` IS the mailbox address (the same string
// `receiveEmail` passes to `EMAIL_AGENT.idFromName`). Without this gate
// any authenticated user could open a chat WebSocket against any other
// user's mailbox and ask the LLM to draft / send / move email on their
// behalf — a 605-LoC privilege escalation surface.
//
// Posture: require `c.var.authzContext`, parse the `<name>` segment,
// resolve to a D1 mailbox row, assert membership in
// `authorized_mailbox_ids` (or a global role). The internal
// `receiveEmail → stub.fetch("/onNewEmail")` path doesn't traverse this
// mount — it goes directly to the DO's fetch — so internal auto-draft
// continues to work unchanged. The DO carries a belt-and-suspenders
// check inside `EmailAgent.onRequest` that refuses `/onNewEmail` unless
// the request carries the internal marker header set by `receiveEmail`.
app.use("/agents/*", async (c, next) => {
  const ctx = c.var.authzContext;
  if (!ctx) return c.json({ error: "Unauthorized" }, 401);

  const parts = new URL(c.req.url).pathname.split("/").filter(Boolean);
  // parts := ["agents", "<kebab-class>", "<name>", ...]
  if (parts.length < 3) {
    return c.json({ error: "Bad agent path" }, 400);
  }
  const agentName = decodeURIComponent(parts[2]);
  if (!agentName) return c.json({ error: "Bad agent path" }, 400);

  if (!c.env.DB) {
    return c.json({ error: "Agent authz unavailable" }, 503);
  }

  const { drizzle } = await import("drizzle-orm/d1");
  const { or, eq, sql } = await import("drizzle-orm");
  const schema = await import("./db/control-plane/schema");
  const orm = drizzle(c.env.DB, { schema });
  const row = await orm
    .select({ id: schema.mailboxes.id, address: schema.mailboxes.address })
    .from(schema.mailboxes)
    .where(
      or(
        eq(schema.mailboxes.id, agentName),
        eq(sql`lower(${schema.mailboxes.address})`, agentName.toLowerCase()),
      ),
    )
    .get();
  if (!row) return c.json({ error: "Not found" }, 404);

  const isGlobal = ctx.role === "global_owner" || ctx.role === "global_admin";
  if (!isGlobal && !ctx.authorized_mailbox_ids.includes(row.id)) {
    return c.json({ error: "Forbidden" }, 403);
  }
  return next();
});

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

// /__mock/* router — autonomous-local-testing harness. Self-gates on MOCK_MODE
// (defensive depth — see workers/routes/__mock__.ts), so safe to mount
// unconditionally. The /cdn-cgi/access/logout handler is mounted alongside
// since the ProfileMenu sign-out link normally hits Cloudflare Access; in
// MOCK_MODE there is no Access layer so we serve it ourselves.
const { default: mockRouter, mockAccessLogoutHandler } =
  await import("./routes/__mock__");
app.route("/__mock", mockRouter);
app.all("/cdn-cgi/access/logout", mockAccessLogoutHandler());

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
