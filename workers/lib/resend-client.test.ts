// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildResendPayload,
  sendViaResend,
  getResendBinding,
} from "./resend-client";
import type { Env } from "../types";

describe("resend-client", () => {
  describe("buildResendPayload", () => {
    it("formats a name+email from address as RFC-5322 name-addr", () => {
      const payload = buildResendPayload({
        from: { name: "ActionNow", email: "noreply@actionnow.ai" },
        to: "user@example.com",
        subject: "Hi",
        text: "Hello",
      });
      expect(payload.from).toBe('"ActionNow" <noreply@actionnow.ai>');
    });

    it("passes a bare-string from address through unchanged", () => {
      const payload = buildResendPayload({
        from: "auth@actionnow.ai",
        to: "user@example.com",
        subject: "Hi",
        text: "Hello",
      });
      expect(payload.from).toBe("auth@actionnow.ai");
    });

    it("escapes embedded double-quotes in display names", () => {
      const payload = buildResendPayload({
        from: { name: 'A"B', email: "x@y.z" },
        to: "u@e.com",
        subject: "S",
        text: "T",
      });
      expect(payload.from).toBe('"A\\"B" <x@y.z>');
    });

    it("normalises to/cc/bcc to arrays", () => {
      const payload = buildResendPayload({
        from: "a@b.c",
        to: ["one@x.com", "two@x.com"],
        cc: "cc@x.com",
        bcc: ["bcc@x.com"],
        subject: "S",
        text: "T",
      });
      expect(payload.to).toEqual(["one@x.com", "two@x.com"]);
      expect(payload.cc).toEqual(["cc@x.com"]);
      expect(payload.bcc).toEqual(["bcc@x.com"]);
    });

    it("includes html, text, headers, and attachments when provided", () => {
      const payload = buildResendPayload({
        from: "a@b.c",
        to: "u@e.com",
        subject: "S",
        html: "<p>Hi</p>",
        text: "Hi",
        headers: { "X-Thread": "abc" },
        attachments: [
          {
            filename: "note.txt",
            content: "aGVsbG8=",
            type: "text/plain",
            disposition: "attachment",
          },
        ],
      });
      expect(payload.html).toBe("<p>Hi</p>");
      expect(payload.text).toBe("Hi");
      expect(payload.headers).toEqual({ "X-Thread": "abc" });
      expect(payload.attachments).toEqual([
        {
          filename: "note.txt",
          content: "aGVsbG8=",
          content_type: "text/plain",
        },
      ]);
    });

    it("omits optional fields when not provided", () => {
      const payload = buildResendPayload({
        from: "a@b.c",
        to: "u@e.com",
        subject: "S",
        text: "T",
      });
      expect("html" in payload).toBe(false);
      expect("cc" in payload).toBe(false);
      expect("bcc" in payload).toBe(false);
      expect("reply_to" in payload).toBe(false);
      expect("headers" in payload).toBe(false);
      expect("attachments" in payload).toBe(false);
    });
  });

  describe("sendViaResend", () => {
    let originalFetch: typeof fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });
    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("returns messageId on 200 success", async () => {
      const fetchMock = vi.fn<
        (url: string, init?: RequestInit) => Promise<Response>
      >(
        async () =>
          new Response(JSON.stringify({ id: "abc-123" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await sendViaResend("test-key", {
        from: "a@b.c",
        to: "u@e.com",
        subject: "S",
        text: "T",
      });
      expect(result).toEqual({ messageId: "abc-123" });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://api.resend.com/emails");
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer test-key");
      expect(headers["Content-Type"]).toBe("application/json");
    });

    it("throws with status, name, and message on 4xx", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              name: "validation_error",
              message: "Invalid `from` address",
              statusCode: 422,
            }),
            { status: 422, headers: { "Content-Type": "application/json" } },
          ),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        sendViaResend("k", {
          from: "bad",
          to: "u@e.com",
          subject: "S",
          text: "T",
        }),
      ).rejects.toThrow(
        /Resend send failed \(422 validation_error\): Invalid `from` address/,
      );
    });

    it("throws gracefully when error body is not JSON", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response("upstream timeout", {
            status: 502,
            statusText: "Bad Gateway",
          }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        sendViaResend("k", {
          from: "a@b.c",
          to: "u@e.com",
          subject: "S",
          text: "T",
        }),
      ).rejects.toThrow(/Resend send failed \(502 resend_error\)/);
    });
  });

  describe("getResendBinding", () => {
    it("throws on first send if RESEND_API_KEY is missing", () => {
      const env = {} as unknown as Env;
      expect(() => getResendBinding(env)).toThrow(/RESEND_API_KEY/);
    });

    it("returns a SendEmail-shaped object when key is present", () => {
      const env = { RESEND_API_KEY: "rk-test" } as unknown as Env;
      const binding = getResendBinding(env);
      expect(typeof binding.send).toBe("function");
    });
  });
});
