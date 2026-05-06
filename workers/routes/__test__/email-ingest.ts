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
  // P0-6 (audit 2026-05-06): bypass mode is "skip CF Access JWT only" —
  // it must NOT unlock dev-only test surfaces. Gate on a positive marker.
  const isDev = import.meta.env.DEV || c.env.CF_ACCESS_DEV_MODE === "mock";
  if (!isDev) {
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
  // P0-6 (audit 2026-05-06): bypass mode is "skip CF Access JWT only" —
  // it must NOT unlock dev-only test surfaces. Gate on a positive marker.
  const isDev = import.meta.env.DEV || c.env.CF_ACCESS_DEV_MODE === "mock";
  if (!isDev) {
    return c.text("Test routes are dev-only", 404);
  }

  const { to, from, subject, body } = await c.req.json<{
    to: string;
    from: string;
    subject: string;
    body: string;
  }>();

  // Phase C3 / C3.25 BUG: build the raw RFC 822 frame as a Blob and
  // measure its BYTE size with `.size`. The previous implementation
  // passed `body.length` for `rawSize`, which is the JS string length
  // (UTF-16 code units) and undercounts multi-byte chars in headers,
  // body, and CRLF separators. The size eventually feeds the inbound
  // 25 MB cap in `streamToArrayBuffer`; the off-by-encoding error
  // could let a multi-byte body squeak past the cap or, more
  // realistically in practice, fail size checks for a body that was
  // legitimately under the byte cap.
  const rawBlob = new Blob([
    `From: ${from}\r\n`,
    `To: ${to}\r\n`,
    `Subject: ${subject}\r\n`,
    `\r\n`,
    body,
  ]);
  const raw = rawBlob.stream();

  const { receiveEmail } = await import("../../index");
  await receiveEmail(
    { raw, rawSize: rawBlob.size },
    c.env,
    c.executionCtx as ExecutionContext,
  );

  return c.json({ ok: true, ingested: { to, from, subject } });
});

export default testRoutes;
