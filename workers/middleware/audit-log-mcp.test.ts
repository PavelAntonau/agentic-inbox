// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// T2.2 (mcp-oauth) — audit-log-mcp.ts unit tests.
//
// We exercise the pure helpers (extractMcpMethod, buildAuditRow). The actual
// D1 write goes through Drizzle which is integration-tested elsewhere; the
// fire-and-forget contract is documented in audit-log-mcp.ts.

import { describe, expect, it } from "vitest";
import { buildAuditRow, extractMcpMethod } from "./audit-log-mcp";
import type { BearerOk } from "./oauth-bearer";

function jsonRpc(body: unknown, contentType = "application/json"): Request {
  return new Request("https://mail.actionnow.ai/mcp", {
    method: "POST",
    headers: { "content-type": contentType, "cf-connecting-ip": "203.0.113.7" },
    body: JSON.stringify(body),
  });
}

describe("extractMcpMethod", () => {
  it("returns method + tool for tools/call", async () => {
    const req = jsonRpc({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "list_emails", arguments: {} },
      id: 1,
    });
    const r = await extractMcpMethod(req);
    expect(r.method).toBe("tools/call");
    expect(r.tool).toBe("list_emails");
  });

  it("returns method only for tools/list", async () => {
    const req = jsonRpc({ jsonrpc: "2.0", method: "tools/list", id: 1 });
    const r = await extractMcpMethod(req);
    expect(r.method).toBe("tools/list");
    expect(r.tool).toBeNull();
  });

  it("handles JSON-RPC batch (returns first envelope)", async () => {
    const req = jsonRpc([
      { jsonrpc: "2.0", method: "tools/list", id: 1 },
      { jsonrpc: "2.0", method: "tools/list", id: 2 },
    ]);
    const r = await extractMcpMethod(req);
    expect(r.method).toBe("tools/list");
  });

  it("returns nulls for non-POST", async () => {
    const req = new Request("https://mail.actionnow.ai/mcp", { method: "GET" });
    const r = await extractMcpMethod(req);
    expect(r).toEqual({ method: null, tool: null });
  });

  it("returns nulls for non-JSON content-type", async () => {
    const req = jsonRpc({ jsonrpc: "2.0", method: "tools/list" }, "text/plain");
    const r = await extractMcpMethod(req);
    expect(r).toEqual({ method: null, tool: null });
  });

  it("returns nulls when body is malformed JSON", async () => {
    const req = new Request("https://mail.actionnow.ai/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    const r = await extractMcpMethod(req);
    expect(r).toEqual({ method: null, tool: null });
  });

  it("does NOT consume the original request body (clone-only)", async () => {
    const req = jsonRpc({ jsonrpc: "2.0", method: "tools/list", id: 1 });
    await extractMcpMethod(req);
    // The downstream MCP handler must still be able to read the body.
    const body = await req.json();
    expect((body as { method: string }).method).toBe("tools/list");
  });
});

describe("buildAuditRow", () => {
  const bearer: BearerOk = {
    ok: true,
    source: "jwt",
    jti: "deadbeef",
    user_id: "user_xyz",
    client_id: "claude-code",
    scopes: ["mcp:mailbox:read", "mcp:mailbox:write"],
    expires_at: 9_999_999_999,
  };

  it("packages all fields including cf-connecting-ip", () => {
    const req = jsonRpc({ jsonrpc: "2.0", method: "tools/list", id: 1 });
    const row = buildAuditRow({
      bearer,
      request: req,
      http_status: 200,
      duration_ms: 42,
      mcp_method: "tools/list",
      tool_name: null,
    });
    expect(row).toMatchObject({
      jti: "deadbeef",
      user_id: "user_xyz",
      client_id: "claude-code",
      scopes: ["mcp:mailbox:read", "mcp:mailbox:write"],
      http_status: 200,
      duration_ms: 42,
      mcp_method: "tools/list",
      tool_name: null,
      source_ip: "203.0.113.7",
    });
  });

  it("falls back to x-forwarded-for when cf-connecting-ip absent", () => {
    const req = new Request("https://mail.actionnow.ai/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "198.51.100.42",
      },
      body: "{}",
    });
    const row = buildAuditRow({
      bearer,
      request: req,
      http_status: 401,
      duration_ms: 1,
      mcp_method: null,
      tool_name: null,
    });
    expect(row.source_ip).toBe("198.51.100.42");
  });

  it("source_ip is null when neither header present", () => {
    const req = new Request("https://mail.actionnow.ai/mcp", { method: "GET" });
    const row = buildAuditRow({
      bearer,
      request: req,
      http_status: 200,
      duration_ms: 5,
      mcp_method: null,
      tool_name: null,
    });
    expect(row.source_ip).toBeNull();
  });
});
