// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { describe, expect, it } from "vitest";
import { Folders, normalizeFolderId } from "../../shared/folders";

describe("normalizeFolderId", () => {
  it("passes through canonical IDs unchanged", () => {
    expect(normalizeFolderId("inbox")).toBe(Folders.INBOX);
    expect(normalizeFolderId("draft")).toBe(Folders.DRAFT);
    expect(normalizeFolderId("sent")).toBe(Folders.SENT);
  });

  it("maps 'drafts' (plural) to canonical 'draft'", () => {
    expect(normalizeFolderId("drafts")).toBe(Folders.DRAFT);
  });

  it("lowercases mixed-case input", () => {
    expect(normalizeFolderId("Drafts")).toBe(Folders.DRAFT);
    expect(normalizeFolderId("INBOX")).toBe(Folders.INBOX);
  });

  it("preserves null and undefined", () => {
    expect(normalizeFolderId(null)).toBeNull();
    expect(normalizeFolderId(undefined)).toBeUndefined();
  });

  it("passes unknown folder names through (lowercased)", () => {
    expect(normalizeFolderId("custom-folder")).toBe("custom-folder");
  });
});
