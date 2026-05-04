// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Tests for the send-policy decision tree wired into toolSendEmail / toolSendReply.
// The pure decision function is exhaustively unit-tested in
// internal-delivery.test.ts; here we verify that the tool-level orchestration
// dispatches to the correct executor (deliverInternal vs env.EMAIL.send) and
// surfaces denial errors to the caller.

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────
// Stub out helpers + AI + executors so each test fully controls the env.

vi.mock("./email-helpers", async () => {
  const actual =
    await vi.importActual<typeof import("./email-helpers")>("./email-helpers");
  return {
    ...actual,
    resolveMailboxBackend: vi.fn(),
    readSourceExternalSendEnabled: vi.fn(),
    getMailboxStub: vi.fn(),
  };
});

vi.mock("./ai", () => ({
  verifyDraft: vi.fn(async (_env: unknown, body: string) => body),
}));

vi.mock("../email-sender", () => ({
  sendEmail: vi.fn(async () => ({ messageId: "ext-msg-id" })),
}));

vi.mock("./mocks/email-binding", () => ({
  getEmailBinding: vi.fn(() => ({ send: vi.fn() })),
}));

vi.mock("./internal-delivery", async () => {
  const actual = await vi.importActual<typeof import("./internal-delivery")>(
    "./internal-delivery",
  );
  return {
    ...actual,
    deliverInternal: vi.fn(async (_env, p) => ({
      messageId: p.messageId,
      deliveredVia: "internal",
    })),
  };
});

// ── Imports under test (after mocks) ──────────────────────────────

import { toolSendEmail, toolSendReply } from "./tools";
import * as helpers from "./email-helpers";
import { sendEmail as sendEmailExt } from "../email-sender";
import { deliverInternal } from "./internal-delivery";

// ── Fixtures ──────────────────────────────────────────────────────

interface StubEmail {
  id: string;
  body: string | null;
  date: string;
  sender: string | null;
  thread_id: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  email_references: string | null;
}

function makeStub(originalEmail?: StubEmail) {
  return {
    checkSendRateLimit: vi.fn<() => Promise<string | null>>(async () => null),
    getEmail: vi.fn<(id: string) => Promise<StubEmail | null>>(
      async () => originalEmail ?? null,
    ),
    createEmail: vi.fn<
      (
        folder: string,
        email: Record<string, unknown>,
        attachments: unknown[],
      ) => Promise<void>
    >(async () => undefined),
  };
}

function makeEnv() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { MAILBOX: {}, DB: {}, BUCKET: {}, EMAIL: {} } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── toolSendEmail: four-branch decision tree ──────────────────────

describe("toolSendEmail — send-policy decision tree", () => {
  it("Branch 1 — internal: destination is a D1 mailbox → deliverInternal, no env.EMAIL", async () => {
    const stub = makeStub();
    vi.mocked(helpers.getMailboxStub).mockReturnValue(
      stub as unknown as ReturnType<typeof helpers.getMailboxStub>,
    );
    vi.mocked(helpers.resolveMailboxBackend).mockResolvedValue({
      kind: "d1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      row: { id: "mb-bob", address: "bob@actionnow.ai" } as any,
    });
    vi.mocked(helpers.readSourceExternalSendEnabled).mockResolvedValue(false);

    const result = await toolSendEmail(makeEnv(), "alice@actionnow.ai", {
      to: "bob@actionnow.ai",
      subject: "hi",
      bodyHtml: "<p>hello</p>",
    });

    expect(result).toMatchObject({ status: "sent" });
    expect(deliverInternal).toHaveBeenCalledTimes(1);
    expect(sendEmailExt).not.toHaveBeenCalled();
    // Source mailbox SENT folder still gets a copy.
    expect(stub.createEmail).toHaveBeenCalledTimes(1);
    expect(stub.createEmail.mock.calls[0]![0]).toBe("sent");
  });

  it("Branch 2 — internal: destination is an R2 v1 mailbox → deliverInternal", async () => {
    const stub = makeStub();
    vi.mocked(helpers.getMailboxStub).mockReturnValue(
      stub as unknown as ReturnType<typeof helpers.getMailboxStub>,
    );
    vi.mocked(helpers.resolveMailboxBackend).mockResolvedValue({
      kind: "r2",
      row: { id: "v1@actionnow.ai", address: "v1@actionnow.ai" },
    });
    // Source is a v1 mailbox (no D1 row) → flag is undefined; internal still wins.
    vi.mocked(helpers.readSourceExternalSendEnabled).mockResolvedValue(
      undefined,
    );

    const result = await toolSendEmail(makeEnv(), "alice@actionnow.ai", {
      to: "v1@actionnow.ai",
      subject: "hi",
      bodyHtml: "<p>hello</p>",
    });

    expect(result).toMatchObject({ status: "sent" });
    expect(deliverInternal).toHaveBeenCalledTimes(1);
    expect(sendEmailExt).not.toHaveBeenCalled();
  });

  it("Branch 3 — external + flag-on: destination external, source external_send_enabled=true → env.EMAIL.send", async () => {
    const stub = makeStub();
    vi.mocked(helpers.getMailboxStub).mockReturnValue(
      stub as unknown as ReturnType<typeof helpers.getMailboxStub>,
    );
    vi.mocked(helpers.resolveMailboxBackend).mockResolvedValue(null);
    vi.mocked(helpers.readSourceExternalSendEnabled).mockResolvedValue(true);

    const result = await toolSendEmail(makeEnv(), "alice@actionnow.ai", {
      to: "external@example.com",
      subject: "hi",
      bodyHtml: "<p>hello</p>",
    });

    expect(result).toMatchObject({ status: "sent" });
    expect(sendEmailExt).toHaveBeenCalledTimes(1);
    expect(deliverInternal).not.toHaveBeenCalled();
    expect(stub.createEmail).toHaveBeenCalledTimes(1);
  });

  it("Branch 4 — external + flag-off: destination external, source external_send_enabled=false → denied", async () => {
    const stub = makeStub();
    vi.mocked(helpers.getMailboxStub).mockReturnValue(
      stub as unknown as ReturnType<typeof helpers.getMailboxStub>,
    );
    vi.mocked(helpers.resolveMailboxBackend).mockResolvedValue(null);
    vi.mocked(helpers.readSourceExternalSendEnabled).mockResolvedValue(false);

    const result = await toolSendEmail(makeEnv(), "alice@actionnow.ai", {
      to: "external@example.com",
      subject: "hi",
      bodyHtml: "<p>hello</p>",
    });

    expect(result).toHaveProperty("error");
    if ("error" in result) {
      expect(result.error).toMatch(/External sending is disabled/i);
    }
    expect(sendEmailExt).not.toHaveBeenCalled();
    expect(deliverInternal).not.toHaveBeenCalled();
    // Denied sends DO NOT write to source SENT folder.
    expect(stub.createEmail).not.toHaveBeenCalled();
  });

  it("Branch 4b — external + v1 source: destination external, source not in D1 → denied with v1-specific guidance", async () => {
    const stub = makeStub();
    vi.mocked(helpers.getMailboxStub).mockReturnValue(
      stub as unknown as ReturnType<typeof helpers.getMailboxStub>,
    );
    vi.mocked(helpers.resolveMailboxBackend).mockResolvedValue(null);
    vi.mocked(helpers.readSourceExternalSendEnabled).mockResolvedValue(
      undefined,
    );

    const result = await toolSendEmail(makeEnv(), "v1-alice@actionnow.ai", {
      to: "external@example.com",
      subject: "hi",
      bodyHtml: "<p>hello</p>",
    });

    expect(result).toHaveProperty("error");
    if ("error" in result) {
      expect(result.error).toMatch(/D1-managed mailbox/i);
    }
    expect(sendEmailExt).not.toHaveBeenCalled();
    expect(deliverInternal).not.toHaveBeenCalled();
    expect(stub.createEmail).not.toHaveBeenCalled();
  });
});

// ── toolSendReply: same four-branch decision tree, with threading ─

describe("toolSendReply — send-policy decision tree (with threading)", () => {
  function originalEmail(): StubEmail {
    return {
      id: "orig-msg",
      body: "<p>original body</p>",
      date: "2026-05-04T10:00:00.000Z",
      sender: "bob@actionnow.ai",
      thread_id: "thread-1",
      message_id: "orig-msg-id@actionnow.ai",
      in_reply_to: null,
      email_references: null,
    };
  }

  it("internal: D1 destination → deliverInternal carries threading metadata", async () => {
    const stub = makeStub(originalEmail());
    vi.mocked(helpers.getMailboxStub).mockReturnValue(
      stub as unknown as ReturnType<typeof helpers.getMailboxStub>,
    );
    vi.mocked(helpers.resolveMailboxBackend).mockResolvedValue({
      kind: "d1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      row: { id: "mb-bob", address: "bob@actionnow.ai" } as any,
    });
    vi.mocked(helpers.readSourceExternalSendEnabled).mockResolvedValue(false);

    const result = await toolSendReply(makeEnv(), "alice@actionnow.ai", {
      originalEmailId: "orig-msg",
      to: "bob@actionnow.ai",
      subject: "Re: hi",
      bodyHtml: "<p>hello back</p>",
    });

    expect(result).toMatchObject({ status: "sent" });
    expect(deliverInternal).toHaveBeenCalledTimes(1);
    const call = vi.mocked(deliverInternal).mock.calls[0]!;
    expect(call[1].threading).toMatchObject({
      thread_id: "thread-1",
      in_reply_to: "orig-msg-id@actionnow.ai",
    });
    expect(sendEmailExt).not.toHaveBeenCalled();
  });

  it("external + flag-on: external destination → env.EMAIL.send with threading headers", async () => {
    const stub = makeStub(originalEmail());
    vi.mocked(helpers.getMailboxStub).mockReturnValue(
      stub as unknown as ReturnType<typeof helpers.getMailboxStub>,
    );
    vi.mocked(helpers.resolveMailboxBackend).mockResolvedValue(null);
    vi.mocked(helpers.readSourceExternalSendEnabled).mockResolvedValue(true);

    const result = await toolSendReply(makeEnv(), "alice@actionnow.ai", {
      originalEmailId: "orig-msg",
      to: "outsider@example.com",
      subject: "Re: hi",
      bodyHtml: "<p>hello back</p>",
    });

    expect(result).toMatchObject({ status: "sent" });
    expect(sendEmailExt).toHaveBeenCalledTimes(1);
    const sendArgs = vi.mocked(sendEmailExt).mock.calls[0]![1];
    expect(sendArgs.headers).toBeDefined();
    expect(sendArgs.headers!["In-Reply-To"]).toContain("orig-msg-id");
    expect(deliverInternal).not.toHaveBeenCalled();
  });

  it("external + flag-off: external destination → denied, no source SENT write", async () => {
    const stub = makeStub(originalEmail());
    vi.mocked(helpers.getMailboxStub).mockReturnValue(
      stub as unknown as ReturnType<typeof helpers.getMailboxStub>,
    );
    vi.mocked(helpers.resolveMailboxBackend).mockResolvedValue(null);
    vi.mocked(helpers.readSourceExternalSendEnabled).mockResolvedValue(false);

    const result = await toolSendReply(makeEnv(), "alice@actionnow.ai", {
      originalEmailId: "orig-msg",
      to: "outsider@example.com",
      subject: "Re: hi",
      bodyHtml: "<p>hello back</p>",
    });

    expect(result).toHaveProperty("error");
    if ("error" in result) {
      expect(result.error).toMatch(/External sending is disabled/i);
    }
    expect(sendEmailExt).not.toHaveBeenCalled();
    expect(deliverInternal).not.toHaveBeenCalled();
    expect(stub.createEmail).not.toHaveBeenCalled();
  });
});
