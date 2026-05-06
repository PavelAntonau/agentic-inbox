// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// T3.6 — workers/lib/mcp-tool-policy.ts unit tests.
//
// Coverage matrix:
//   - TOOL_REQUIRED_SCOPES + getRequiredScope: every documented MCP tool
//     maps to exactly one required scope; unknown tools fall through to null.
//   - MAILBOX_BOUND_TOOLS: list_mailboxes is intentionally NOT in the set;
//     all tools that take a mailboxId arg ARE in the set.
//   - extractToolCall: tools/call envelope decoding (single + batch),
//     non-tools/call methods, malformed bodies, content-type guard,
//     non-POST guard, original-body preservation (clone-only).
//   - isIpInAllowlist: literal-IP exact match, IPv4 CIDR, IPv6 CIDR,
//     null/empty allowlist short-circuit.
//   - insufficientScopeResponse: status 403, WWW-Authenticate shape,
//     JSON body carries reason + extras.
//
// resolveMailboxToId is IO-bound (D1 lookup); covered indirectly via the
// dispatch-layer integration tests. The drizzle mock pattern from
// email-helpers.test.ts is overkill for pure-helper coverage here.

import { describe, expect, it } from "vitest";
import {
  TOOL_REQUIRED_SCOPES,
  MAILBOX_BOUND_TOOLS,
  getRequiredScope,
  extractToolCall,
  isIpInAllowlist,
  insufficientScopeResponse,
} from "./mcp-tool-policy";

const ALL_TOOLS = [
  "list_mailboxes",
  "list_emails",
  "get_email",
  "get_thread",
  "search_emails",
  "send_email",
  "send_reply",
  "delete_email",
  "move_email",
  "mark_email_read",
  "create_draft",
  "update_draft",
  "draft_reply",
] as const;

const READ_TOOLS = [
  "list_mailboxes",
  "list_emails",
  "get_email",
  "get_thread",
  "search_emails",
] as const;

const WRITE_TOOLS = [
  "send_email",
  "send_reply",
  "delete_email",
  "move_email",
  "mark_email_read",
  "create_draft",
  "update_draft",
  "draft_reply",
] as const;

// ── TOOL_REQUIRED_SCOPES + getRequiredScope ─────────────────────────────────

describe("TOOL_REQUIRED_SCOPES", () => {
  it("read tools require mcp:mailbox:read", () => {
    for (const tool of READ_TOOLS) {
      expect(TOOL_REQUIRED_SCOPES[tool]).toBe("mcp:mailbox:read");
    }
  });

  it("write tools require mcp:mailbox:write", () => {
    for (const tool of WRITE_TOOLS) {
      expect(TOOL_REQUIRED_SCOPES[tool]).toBe("mcp:mailbox:write");
    }
  });

  it("covers every documented MCP tool", () => {
    const documented = new Set(ALL_TOOLS);
    const mapped = new Set(Object.keys(TOOL_REQUIRED_SCOPES));
    expect(mapped).toEqual(documented);
  });
});

describe("getRequiredScope", () => {
  it("returns the required scope for known tools", () => {
    expect(getRequiredScope("list_emails")).toBe("mcp:mailbox:read");
    expect(getRequiredScope("send_email")).toBe("mcp:mailbox:write");
  });

  it("returns null for unknown tools (never default-allow)", () => {
    expect(getRequiredScope("eval_arbitrary_code")).toBeNull();
    expect(getRequiredScope("")).toBeNull();
    expect(getRequiredScope("__proto__")).toBeNull();
    expect(getRequiredScope("constructor")).toBeNull();
  });
});

// ── MAILBOX_BOUND_TOOLS ────────────────────────────────────────────────────

describe("MAILBOX_BOUND_TOOLS", () => {
  it("includes every tool that takes a mailboxId argument", () => {
    for (const tool of [
      "list_emails",
      "get_email",
      "get_thread",
      "search_emails",
      "send_email",
      "send_reply",
      "delete_email",
      "move_email",
      "mark_email_read",
      "create_draft",
      "update_draft",
      "draft_reply",
    ]) {
      expect(MAILBOX_BOUND_TOOLS.has(tool)).toBe(true);
    }
  });

  it("does NOT include list_mailboxes (no per-mailbox arg)", () => {
    expect(MAILBOX_BOUND_TOOLS.has("list_mailboxes")).toBe(false);
  });
});

// ── extractToolCall ────────────────────────────────────────────────────────

function jsonRpc(body: unknown, contentType = "application/json"): Request {
  return new Request("https://mail.actionnow.ai/mcp", {
    method: "POST",
    headers: { "content-type": contentType },
    body: JSON.stringify(body),
  });
}

describe("extractToolCall", () => {
  it("returns name + arguments + id for tools/call", async () => {
    const req = jsonRpc({
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "list_emails",
        arguments: { mailboxId: "alice@actionnow.ai", folder: "inbox" },
      },
      id: 7,
    });
    const r = await extractToolCall(req);
    expect(r.name).toBe("list_emails");
    expect(r.arguments).toEqual({
      mailboxId: "alice@actionnow.ai",
      folder: "inbox",
    });
    expect(r.id).toBe(7);
  });

  it("returns nulls for tools/list (not a tools/call envelope)", async () => {
    const req = jsonRpc({ jsonrpc: "2.0", method: "tools/list", id: 1 });
    const r = await extractToolCall(req);
    expect(r).toEqual({ name: null, arguments: null, id: null });
  });

  it("handles JSON-RPC batch (returns first envelope's tool/args/id)", async () => {
    const req = jsonRpc([
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "send_email", arguments: { mailboxId: "x" } },
        id: "rpc-1",
      },
      { jsonrpc: "2.0", method: "tools/list", id: 2 },
    ]);
    const r = await extractToolCall(req);
    expect(r.name).toBe("send_email");
    expect(r.id).toBe("rpc-1");
    expect(r.arguments).toEqual({ mailboxId: "x" });
  });

  it("returns nulls for non-POST", async () => {
    const req = new Request("https://mail.actionnow.ai/mcp", { method: "GET" });
    const r = await extractToolCall(req);
    expect(r).toEqual({ name: null, arguments: null, id: null });
  });

  it("returns nulls for non-JSON content-type", async () => {
    const req = jsonRpc({ jsonrpc: "2.0", method: "tools/call" }, "text/plain");
    const r = await extractToolCall(req);
    expect(r).toEqual({ name: null, arguments: null, id: null });
  });

  it("returns nulls when body is malformed JSON", async () => {
    const req = new Request("https://mail.actionnow.ai/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    const r = await extractToolCall(req);
    expect(r).toEqual({ name: null, arguments: null, id: null });
  });

  it("rejects array-typed arguments (must be object map)", async () => {
    const req = jsonRpc({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "list_emails", arguments: ["bad"] },
      id: 1,
    });
    const r = await extractToolCall(req);
    expect(r.name).toBe("list_emails");
    expect(r.arguments).toBeNull();
  });

  it("does NOT consume the original request body (clone-only)", async () => {
    const req = jsonRpc({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "list_emails", arguments: {} },
      id: 1,
    });
    await extractToolCall(req);
    // The downstream MCP handler must still be able to read the body.
    const body = await req.json();
    expect((body as { method: string }).method).toBe("tools/call");
  });
});

// ── isIpInAllowlist ────────────────────────────────────────────────────────

describe("isIpInAllowlist", () => {
  it("returns false for null/empty inputs", () => {
    expect(isIpInAllowlist(null, ["1.1.1.1"])).toBe(false);
    expect(isIpInAllowlist("1.1.1.1", null)).toBe(false);
    expect(isIpInAllowlist("1.1.1.1", undefined)).toBe(false);
    expect(isIpInAllowlist("1.1.1.1", [])).toBe(false);
  });

  it("matches literal IPv4 exactly", () => {
    expect(isIpInAllowlist("203.0.113.7", ["203.0.113.7"])).toBe(true);
    expect(isIpInAllowlist("203.0.113.7", ["203.0.113.8"])).toBe(false);
    expect(
      isIpInAllowlist("203.0.113.7", ["198.51.100.1", "203.0.113.7"]),
    ).toBe(true);
  });

  it("matches IPv4 CIDR", () => {
    expect(isIpInAllowlist("203.0.113.7", ["203.0.113.0/24"])).toBe(true);
    expect(isIpInAllowlist("203.0.113.7", ["203.0.113.0/29"])).toBe(true);
    expect(isIpInAllowlist("203.0.113.7", ["203.0.113.16/29"])).toBe(false);
    expect(isIpInAllowlist("198.51.100.5", ["203.0.113.0/24"])).toBe(false);
  });

  it("supports /0 IPv4 CIDR (allow-all)", () => {
    expect(isIpInAllowlist("203.0.113.7", ["0.0.0.0/0"])).toBe(true);
  });

  it("rejects malformed IPv4 inputs", () => {
    expect(isIpInAllowlist("not-an-ip", ["203.0.113.0/24"])).toBe(false);
    expect(isIpInAllowlist("203.0.113.7", ["bad/24"])).toBe(false);
    expect(isIpInAllowlist("203.0.113.7", ["203.0.113.0/40"])).toBe(false);
    expect(isIpInAllowlist("203.0.113.7", ["203.0.113.0/-1"])).toBe(false);
  });

  it("matches literal IPv6 exactly", () => {
    expect(isIpInAllowlist("2001:db8::1", ["2001:db8::1"])).toBe(true);
    expect(isIpInAllowlist("2001:db8::1", ["2001:db8::2"])).toBe(false);
  });

  it("matches IPv6 CIDR", () => {
    expect(isIpInAllowlist("2001:db8::1", ["2001:db8::/32"])).toBe(true);
    expect(isIpInAllowlist("2001:db8:1::1", ["2001:db8::/32"])).toBe(true);
    expect(isIpInAllowlist("2001:db9::1", ["2001:db8::/32"])).toBe(false);
  });

  it("does not cross-match IPv4 against IPv6 CIDR", () => {
    expect(isIpInAllowlist("203.0.113.7", ["2001:db8::/32"])).toBe(false);
    expect(isIpInAllowlist("2001:db8::1", ["203.0.113.0/24"])).toBe(false);
  });
});

// ── insufficientScopeResponse ───────────────────────────────────────────────

describe("insufficientScopeResponse", () => {
  it("returns 403 with insufficient_scope error", async () => {
    const r = insufficientScopeResponse("tool-scope-required", {
      tool: "send_email",
      required_scope: "mcp:mailbox:write",
    });
    expect(r.status).toBe(403);
    const body = await r.json();
    expect(body).toEqual({
      error: "insufficient_scope",
      reason: "tool-scope-required",
      tool: "send_email",
      required_scope: "mcp:mailbox:write",
    });
  });

  it("emits a WWW-Authenticate header with realm + resource_metadata + error", () => {
    const r = insufficientScopeResponse("pat-mailbox-mismatch");
    const wa = r.headers.get("WWW-Authenticate");
    expect(wa).toMatch(/^Bearer /);
    expect(wa).toMatch(/realm="mcp"/);
    expect(wa).toMatch(/resource_metadata="https:\/\/mail.actionnow.ai/);
    expect(wa).toMatch(/error="insufficient_scope"/);
    expect(wa).toMatch(/error_description="pat-mailbox-mismatch"/);
  });

  it("sets Cache-Control: no-store", () => {
    const r = insufficientScopeResponse("pat-ip-not-allowed");
    expect(r.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns application/json content-type", () => {
    const r = insufficientScopeResponse("pat-ip-not-allowed");
    expect(r.headers.get("Content-Type")).toBe("application/json");
  });
});
