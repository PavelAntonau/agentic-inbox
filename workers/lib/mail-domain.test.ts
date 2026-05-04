// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { describe, it, expect } from "vitest";
import {
  PRIMARY_MAIL_DOMAIN,
  isValidLocalPart,
  composeAddress,
  addressIsPrimaryDomain,
  localPartFromAddress,
} from "../../shared/mail-domain";

describe("mail-domain", () => {
  describe("isValidLocalPart", () => {
    it("accepts simple local-parts", () => {
      expect(isValidLocalPart("alice")).toBe(true);
      expect(isValidLocalPart("bob123")).toBe(true);
      expect(isValidLocalPart("alice.smith")).toBe(true);
      expect(isValidLocalPart("a_b+c-d")).toBe(true);
      expect(isValidLocalPart("a")).toBe(true);
    });

    it("rejects empty / whitespace-only", () => {
      expect(isValidLocalPart("")).toBe(false);
      expect(isValidLocalPart(" ")).toBe(false);
    });

    it("rejects leading or trailing dots", () => {
      expect(isValidLocalPart(".alice")).toBe(false);
      expect(isValidLocalPart("alice.")).toBe(false);
    });

    it("rejects consecutive dots", () => {
      expect(isValidLocalPart("alice..smith")).toBe(false);
    });

    it("rejects forbidden characters", () => {
      expect(isValidLocalPart("alice@bob")).toBe(false);
      expect(isValidLocalPart("alice smith")).toBe(false);
      expect(isValidLocalPart("alice/smith")).toBe(false);
      expect(isValidLocalPart("alice!")).toBe(false);
    });

    it("rejects > 64 chars", () => {
      expect(isValidLocalPart("a".repeat(64))).toBe(true);
      expect(isValidLocalPart("a".repeat(65))).toBe(false);
    });
  });

  describe("composeAddress", () => {
    it("appends the primary domain and lowercases", () => {
      expect(composeAddress("Alice")).toBe(`alice@${PRIMARY_MAIL_DOMAIN}`);
      expect(composeAddress("  bob  ")).toBe(`bob@${PRIMARY_MAIL_DOMAIN}`);
    });
  });

  describe("addressIsPrimaryDomain", () => {
    it("matches case-insensitively against the primary domain", () => {
      expect(addressIsPrimaryDomain(`alice@${PRIMARY_MAIL_DOMAIN}`)).toBe(true);
      expect(addressIsPrimaryDomain(`alice@ACTIONNOW.AI`)).toBe(true);
      expect(addressIsPrimaryDomain("alice@example.com")).toBe(false);
      expect(addressIsPrimaryDomain("not-an-email")).toBe(false);
    });
  });

  describe("localPartFromAddress", () => {
    it("extracts the local-part", () => {
      expect(localPartFromAddress(`alice@${PRIMARY_MAIL_DOMAIN}`)).toBe(
        "alice",
      );
      expect(localPartFromAddress("not-an-email")).toBeNull();
      expect(localPartFromAddress("@nope")).toBeNull();
    });
  });
});
