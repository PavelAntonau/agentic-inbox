// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";
import type { Env } from "../../types";
import type { JwtClaims } from "../../lib/mock-access";
import type { AuthzContext } from "../../db/control-plane/forGroup";

const testRoutes = new Hono<{
  Bindings: Env;
  Variables: { jwt?: JwtClaims; authzContext?: AuthzContext };
}>();

/**
 * Local-only authz probe. Returns the JWT shape and authzContext that the
 * middleware chain produced for this request — the e2e acceptance script
 * uses this to verify bootstrap-owner promotion + group isolation.
 */
testRoutes.get("/whoami", (c) => {
  if (!import.meta.env.DEV) {
    return c.text("Test routes are dev-only", 404);
  }
  return c.json({
    jwt: c.var.jwt ?? null,
    authzContext: c.var.authzContext ?? null,
  });
});

/**
 * Local-only email ingest. Mirrors the prod email handler so devs can iterate
 * on inbound flows without depending on Cloudflare Email Routing in miniflare.
 *
 * Body: JSON { to: string, from: string, subject: string, body: string }
 */
testRoutes.post("/email-ingest", async (c) => {
  if (!import.meta.env.DEV) {
    return c.text("Test routes are dev-only", 404);
  }

  const { to, from, subject, body } = await c.req.json<{
    to: string;
    from: string;
    subject: string;
    body: string;
  }>();

  const raw = new Blob([
    `From: ${from}\r\n`,
    `To: ${to}\r\n`,
    `Subject: ${subject}\r\n`,
    `\r\n`,
    body,
  ]).stream();

  const { receiveEmail } = await import("../../index");
  await receiveEmail(
    { raw, rawSize: body.length },
    c.env,
    c.executionCtx as ExecutionContext,
  );

  return c.json({ ok: true, ingested: { to, from, subject } });
});

export default testRoutes;
