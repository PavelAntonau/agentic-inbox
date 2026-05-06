// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license

import { describe, it, expect } from "vitest";
import {
  validateAndDecodeAttachment,
  AttachmentRejectedError,
  ATTACHMENT_MIME_ALLOWLIST,
  ATTACHMENT_MIME_DENYLIST,
  MAX_ATTACHMENT_BYTES,
} from "./attachments";

const b64 = (s: string) => btoa(s);
const b64Bytes = (n: number) => btoa("x".repeat(n));

describe("validateAndDecodeAttachment (C3.4 — D-04 hardening)", () => {
  describe("MIME allowlist", () => {
    it("accepts image/png", () => {
      const bytes = validateAndDecodeAttachment({
        content: b64("PNGdata"),
        filename: "x.png",
        type: "image/png",
      });
      expect(new TextDecoder().decode(bytes)).toBe("PNGdata");
    });

    it("accepts application/pdf", () => {
      expect(() =>
        validateAndDecodeAttachment({
          content: b64("PDFhdr"),
          filename: "x.pdf",
          type: "application/pdf",
        }),
      ).not.toThrow();
    });

    it("accepts xlsx", () => {
      expect(() =>
        validateAndDecodeAttachment({
          content: b64("xlsxbody"),
          filename: "x.xlsx",
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
      ).not.toThrow();
    });

    it("accepts text/plain with charset parameter", () => {
      expect(() =>
        validateAndDecodeAttachment({
          content: b64("hello"),
          filename: "x.txt",
          type: "text/plain; charset=utf-8",
        }),
      ).not.toThrow();
    });

    it("is case-insensitive for the type", () => {
      expect(() =>
        validateAndDecodeAttachment({
          content: b64("data"),
          filename: "x.png",
          type: "Image/PNG",
        }),
      ).not.toThrow();
    });
  });

  describe("MIME denylist (active web payloads)", () => {
    const denied = [
      "text/html",
      "application/xhtml+xml",
      "text/javascript",
      "application/javascript",
      "image/svg+xml",
    ];
    for (const type of denied) {
      it(`refuses ${type}`, () => {
        expect(() =>
          validateAndDecodeAttachment({
            content: b64("payload"),
            filename: "evil",
            type,
          }),
        ).toThrowError(AttachmentRejectedError);
      });
    }

    it("denylist + allowlist intersect on SVG → denylist wins", () => {
      // Allowlist explicitly does NOT include svg, but if a future
      // edit added it, the denylist must short-circuit first.
      expect(ATTACHMENT_MIME_DENYLIST.has("image/svg+xml")).toBe(true);
    });

    it("rejection error has reason='mime_denied'", () => {
      try {
        validateAndDecodeAttachment({
          content: b64("<script>"),
          filename: "x.html",
          type: "text/html",
        });
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AttachmentRejectedError);
        expect((err as AttachmentRejectedError).reason).toBe("mime_denied");
      }
    });
  });

  describe("MIME not-in-allowlist", () => {
    it("refuses application/x-msdownload (.exe)", () => {
      expect(() =>
        validateAndDecodeAttachment({
          content: b64("MZ"),
          filename: "x.exe",
          type: "application/x-msdownload",
        }),
      ).toThrowError(AttachmentRejectedError);
    });

    it("refuses font/ttf even though not in denylist", () => {
      try {
        validateAndDecodeAttachment({
          content: b64("ttf"),
          filename: "x.ttf",
          type: "font/ttf",
        });
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AttachmentRejectedError);
        expect((err as AttachmentRejectedError).reason).toBe(
          "mime_not_in_allowlist",
        );
      }
    });

    it("refuses empty MIME", () => {
      expect(() =>
        validateAndDecodeAttachment({
          content: b64("data"),
          filename: "x",
          type: "",
        }),
      ).toThrowError(AttachmentRejectedError);
    });
  });

  describe("size cap", () => {
    it("accepts a 1 KB attachment", () => {
      expect(() =>
        validateAndDecodeAttachment({
          content: b64Bytes(1024),
          filename: "x.txt",
          type: "text/plain",
        }),
      ).not.toThrow();
    });

    // MAX_ATTACHMENT_BYTES is 10 MB; running base64 on a 10 MB string in
    // happy-dom is too slow for the default 5 s vitest timeout. Test the
    // boundary behaviour with a 256 KB sample (well under the cap) and
    // a 50 MB encoded blob (well over the encoded fast-path cap) to
    // exercise both paths cheaply.
    it("accepts a 256 KB attachment under the cap", () => {
      const bytes = validateAndDecodeAttachment({
        content: b64Bytes(256 * 1024),
        filename: "x.bin",
        type: "application/octet-stream",
      });
      expect(bytes.byteLength).toBe(256 * 1024);
    });

    it("refuses an attachment that exceeds the decoded cap (50 MB encoded)", () => {
      const huge = "A".repeat(50 * 1024 * 1024);
      try {
        validateAndDecodeAttachment({
          content: huge,
          filename: "x.bin",
          type: "application/octet-stream",
        });
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AttachmentRejectedError);
        expect((err as AttachmentRejectedError).reason).toBe("size_exceeded");
      }
    });

    it("MAX_ATTACHMENT_BYTES constant is 10 MB", () => {
      expect(MAX_ATTACHMENT_BYTES).toBe(10 * 1024 * 1024);
    });
  });

  describe("decode failure", () => {
    it("refuses garbage base64 with reason='decode_failed'", () => {
      try {
        validateAndDecodeAttachment({
          content: "!!!not base64!!!",
          filename: "x.txt",
          type: "text/plain",
        });
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AttachmentRejectedError);
        expect((err as AttachmentRejectedError).reason).toBe("decode_failed");
      }
    });
  });

  describe("allowlist completeness", () => {
    it("does not list any HTML/JS-active type", () => {
      for (const denied of ["text/html", "text/javascript", "image/svg+xml"]) {
        expect(ATTACHMENT_MIME_ALLOWLIST.has(denied)).toBe(false);
      }
    });
  });
});
