// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase C1 / C-02 — EmailAgent in-DO defense-in-depth tests.
//
// Coverage:
//   • INTERNAL_AGENT_HEADER + INTERNAL_AGENT_ON_NEW_EMAIL constants exported
//     and stable (workers/index.ts:receiveEmail relies on the exact pair).
//   • onRequest /onNewEmail rejects when the marker header is missing.
//   • onRequest /onNewEmail rejects when the marker header is wrong value.
//   • onRequest /onNewEmail accepts the request when the marker is correct
//     (handleNewEmail is invoked, no early 403).
//   • non-/onNewEmail paths fall through to super.onRequest (no marker
//     enforcement on other paths).

import { describe, expect, it, vi } from "vitest";

// AIChatAgent is the SDK base. Stub it so we can construct a minimal DO-
// equivalent fixture without spinning up the full Workers runtime.
vi.mock("@cloudflare/ai-chat", () => ({
  AIChatAgent: class {
    name = "alice@actionnow.ai";
    env = {};
    messages: unknown[] = [];
    async onRequest(_req: Request): Promise<Response> {
      return new Response(JSON.stringify({ via: "super" }), { status: 200 });
    }
    async persistMessages(_msgs: unknown[]): Promise<void> {}
  },
}));
// `agents` SDK is unrelated to the surface under test — stub minimally.
vi.mock("agents", () => ({ AgentNamespace: class {} }));
// `ai` SDK is only invoked from onChatMessage / handleNewEmail; stub.
vi.mock("ai", () => ({
  streamText: vi.fn(),
  generateText: vi.fn(),
  convertToModelMessages: vi.fn(async () => []),
  stepCountIs: vi.fn(),
}));
// Workers AI factory is only used inside the agent's tools; not exercised here.
vi.mock("../lib/mocks/workers-ai-binding", () => ({
  getWorkersAiFactory: vi.fn(),
}));
// Tool helpers + email-helpers — stub because the tests do not exercise the
// auto-draft pipeline; they only assert the marker-header gate.
vi.mock("../lib/ai", () => ({
  verifyDraft: vi.fn(),
  isPromptInjection: vi.fn(),
}));
vi.mock("../lib/email-helpers", () => ({
  getMailboxStub: vi.fn(),
  stripHtmlToText: vi.fn(),
  textToHtml: vi.fn(),
}));
vi.mock("../lib/tools", () => ({
  toolListEmails: vi.fn(),
  toolGetEmail: vi.fn(),
  toolGetThread: vi.fn(),
  toolSearchEmails: vi.fn(),
  toolDraftReply: vi.fn(),
  toolDraftEmail: vi.fn(),
  toolMarkEmailRead: vi.fn(),
  toolMoveEmail: vi.fn(),
  toolDiscardDraft: vi.fn(),
}));

import {
  EmailAgent,
  INTERNAL_AGENT_HEADER,
  INTERNAL_AGENT_ON_NEW_EMAIL,
} from "./index";

function makeAgentInstance(): EmailAgent {
  // The base class is stubbed so plain `new` works without DO-state plumbing.
  // Cast through unknown so we can construct without the SDK's real signature.
  const Ctor = EmailAgent as unknown as new () => EmailAgent;
  const agent = new Ctor();
  // Stub handleNewEmail so the test isolates the gate, not the auto-draft.
  (
    agent as unknown as { handleNewEmail: (...args: unknown[]) => unknown }
  ).handleNewEmail = vi.fn().mockResolvedValue({ status: "ok" });
  return agent;
}

describe("EmailAgent.onRequest — Phase C1 / C-02 internal-marker gate", () => {
  it("exports the exact INTERNAL_AGENT_HEADER + INTERNAL_AGENT_ON_NEW_EMAIL constants receiveEmail relies on", () => {
    expect(INTERNAL_AGENT_HEADER).toBe("x-internal-agent-source");
    expect(INTERNAL_AGENT_ON_NEW_EMAIL).toBe("receive-email");
  });

  it("rejects /onNewEmail with 403 when the marker header is absent", async () => {
    const agent = makeAgentInstance();
    const req = new Request("https://agents/onNewEmail", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mailboxId: "alice@actionnow.ai",
        emailId: "e1",
        sender: "evil@example.com",
        subject: "leak",
        threadId: "t1",
      }),
    });
    const res = await agent.onRequest(req);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/internal-only/i);
  });

  it("rejects /onNewEmail with 403 when the marker header is wrong", async () => {
    const agent = makeAgentInstance();
    const req = new Request("https://agents/onNewEmail", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_AGENT_HEADER]: "spoofed",
      },
      body: JSON.stringify({
        mailboxId: "alice@actionnow.ai",
        emailId: "e1",
        sender: "evil@example.com",
        subject: "leak",
        threadId: "t1",
      }),
    });
    const res = await agent.onRequest(req);
    expect(res.status).toBe(403);
  });

  it("dispatches /onNewEmail to handleNewEmail when the marker matches", async () => {
    const agent = makeAgentInstance();
    const handle = (
      agent as unknown as { handleNewEmail: ReturnType<typeof vi.fn> }
    ).handleNewEmail;
    const req = new Request("https://agents/onNewEmail", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_AGENT_HEADER]: INTERNAL_AGENT_ON_NEW_EMAIL,
      },
      body: JSON.stringify({
        mailboxId: "alice@actionnow.ai",
        emailId: "e1",
        sender: "alice@actionnow.ai",
        subject: "hello",
        threadId: "t1",
      }),
    });
    const res = await agent.onRequest(req);
    expect(res.status).toBe(200);
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("falls through to super.onRequest for non-/onNewEmail paths (no marker required)", async () => {
    const agent = makeAgentInstance();
    const req = new Request("https://agents/messages", { method: "GET" });
    const res = await agent.onRequest(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { via: string };
    expect(body.via).toBe("super");
  });
});
