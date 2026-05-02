// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";
import type { Env } from "../../types";

const testRoutes = new Hono<{ Bindings: Env }>();

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
