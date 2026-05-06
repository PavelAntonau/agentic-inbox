// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase C2 / D-02 — verifyDraft fail-OPEN posture.
//
// On AI outage, verifyDraft must return the original `body` (NOT "")
// so the caller doesn't silently overwrite the user's draft text.

import { describe, expect, it } from "vitest";
import { verifyDraft } from "./ai";

describe("verifyDraft — Phase C2 / D-02 fail-OPEN on AI outage", () => {
  it("returns the original body when env.AI.run throws", async () => {
    const env = {
      AI: {
        run: () => {
          throw new Error("AI binding unavailable");
        },
      },
    } as unknown as Parameters<typeof verifyDraft>[0];

    const original =
      "<p>Hello there, this is the body of an email being drafted by a human.</p>";
    const out = await verifyDraft(env, original);
    // Most importantly, NOT the empty string.
    expect(out).not.toBe("");
    expect(out).toBe(original);
  });

  it("returns the original body when env.AI.run returns null/empty", async () => {
    const env = {
      AI: {
        run: async () => ({ response: "" }),
      },
    } as unknown as Parameters<typeof verifyDraft>[0];

    const original =
      "<p>Long enough body to escape the under-20-char early-return.</p>";
    const out = await verifyDraft(env, original);
    expect(out).toBe(original);
  });
});
