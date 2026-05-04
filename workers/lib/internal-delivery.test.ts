// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { describe, expect, it, vi } from "vitest";
import {
  decideSendPolicy,
  deliverInternal,
  type MailboxBackend,
} from "./internal-delivery";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const D1_BACKEND: MailboxBackend = {
  kind: "d1",
  // The full row shape; tests only read the kind so a minimal cast is fine.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  row: { id: "mb-d1", address: "alice@actionnow.ai" } as any,
};

const R2_BACKEND: MailboxBackend = {
  kind: "r2",
  row: { id: "bob@actionnow.ai", address: "bob@actionnow.ai" },
};

// ---------------------------------------------------------------------------
// decideSendPolicy — pure four-branch decision tree
// ---------------------------------------------------------------------------

describe("decideSendPolicy", () => {
  it("routes internal when destination resolves to a D1 mailbox (regardless of source flag)", () => {
    expect(
      decideSendPolicy({
        destinationBackend: D1_BACKEND,
        sourceExternalSendEnabled: false,
      }),
    ).toEqual({ route: "internal", destinationBackend: D1_BACKEND });

    expect(
      decideSendPolicy({
        destinationBackend: D1_BACKEND,
        sourceExternalSendEnabled: true,
      }),
    ).toEqual({ route: "internal", destinationBackend: D1_BACKEND });

    expect(
      decideSendPolicy({
        destinationBackend: D1_BACKEND,
        sourceExternalSendEnabled: undefined,
      }),
    ).toEqual({ route: "internal", destinationBackend: D1_BACKEND });
  });

  it("routes internal when destination resolves to an R2 v1 mailbox (regardless of source flag)", () => {
    expect(
      decideSendPolicy({
        destinationBackend: R2_BACKEND,
        sourceExternalSendEnabled: false,
      }),
    ).toEqual({ route: "internal", destinationBackend: R2_BACKEND });

    expect(
      decideSendPolicy({
        destinationBackend: R2_BACKEND,
        sourceExternalSendEnabled: true,
      }),
    ).toEqual({ route: "internal", destinationBackend: R2_BACKEND });
  });

  it("routes external when destination is external AND source has external_send_enabled=true", () => {
    expect(
      decideSendPolicy({
        destinationBackend: null,
        sourceExternalSendEnabled: true,
      }),
    ).toEqual({ route: "external" });
  });

  it("denies when destination is external AND source has external_send_enabled=false", () => {
    const result = decideSendPolicy({
      destinationBackend: null,
      sourceExternalSendEnabled: false,
    });
    expect(result.route).toBe("denied");
    if (result.route === "denied") {
      expect(result.error).toMatch(/External sending is disabled/i);
      expect(result.error).toMatch(/settings/i);
    }
  });

  it("denies with v1-specific guidance when source mailbox is not in D1", () => {
    const result = decideSendPolicy({
      destinationBackend: null,
      sourceExternalSendEnabled: undefined,
    });
    expect(result.route).toBe("denied");
    if (result.route === "denied") {
      expect(result.error).toMatch(/D1-managed mailbox/i);
    }
  });
});

// ---------------------------------------------------------------------------
// deliverInternal — orchestrates DO INBOX write + audit row
// ---------------------------------------------------------------------------

describe("deliverInternal", () => {
  it("writes to destination MailboxDO INBOX and returns deliveredVia=internal", async () => {
    const createEmail = vi.fn<
      (
        folder: string,
        email: Record<string, unknown>,
        attachments: unknown[],
      ) => Promise<void>
    >(async () => undefined);
    const stub = { createEmail };
    const env = {
      MAILBOX: {
        idFromName: (name: string) => ({ name }),
        get: () => stub,
      },
      DB: undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const result = await deliverInternal(env, {
      fromMailboxId: "alice@actionnow.ai",
      toAddress: "bob@actionnow.ai",
      subject: "hi",
      bodyHtml: "<p>hello</p>",
      outgoingMessageId: "abc@actionnow.ai",
      messageId: "msg-1",
    });

    expect(result).toEqual({ messageId: "msg-1", deliveredVia: "internal" });
    expect(createEmail).toHaveBeenCalledTimes(1);
    const [folder, email, attachments] = createEmail.mock.calls[0]!;
    expect(folder).toBe("inbox");
    expect(email).toMatchObject({
      id: "msg-1",
      sender: "alice@actionnow.ai",
      recipient: "bob@actionnow.ai",
      subject: "hi",
      body: "<p>hello</p>",
      message_id: "abc@actionnow.ai",
      thread_id: "msg-1", // defaults to messageId when no threading provided
    });
    expect(attachments).toEqual([]);
  });

  it("honors threading metadata for replies", async () => {
    const createEmail = vi.fn<
      (
        folder: string,
        email: Record<string, unknown>,
        attachments: unknown[],
      ) => Promise<void>
    >(async () => undefined);
    const stub = { createEmail };
    const env = {
      MAILBOX: {
        idFromName: (name: string) => ({ name }),
        get: () => stub,
      },
      DB: undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await deliverInternal(env, {
      fromMailboxId: "alice@actionnow.ai",
      toAddress: "bob@actionnow.ai",
      subject: "Re: hi",
      bodyHtml: "<p>hello back</p>",
      outgoingMessageId: "reply-1@actionnow.ai",
      messageId: "msg-reply",
      threading: {
        in_reply_to: "orig-msg-id",
        email_references: '["orig-msg-id"]',
        thread_id: "thread-1",
      },
    });

    const email = createEmail.mock.calls[0]![1];
    expect(email).toMatchObject({
      in_reply_to: "orig-msg-id",
      email_references: '["orig-msg-id"]',
      thread_id: "thread-1",
    });
  });

  it("propagates DO createEmail errors to the caller", async () => {
    const createEmail = vi.fn<
      (
        folder: string,
        email: Record<string, unknown>,
        attachments: unknown[],
      ) => Promise<void>
    >(async () => {
      throw new Error("DO unreachable");
    });
    const stub = { createEmail };
    const env = {
      MAILBOX: {
        idFromName: (name: string) => ({ name }),
        get: () => stub,
      },
      DB: undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await expect(
      deliverInternal(env, {
        fromMailboxId: "alice@actionnow.ai",
        toAddress: "bob@actionnow.ai",
        subject: "hi",
        bodyHtml: "<p>x</p>",
        outgoingMessageId: "x@actionnow.ai",
        messageId: "msg-x",
      }),
    ).rejects.toThrow("DO unreachable");
  });
});
