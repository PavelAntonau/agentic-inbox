// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase C2 / D-01 — internal-delivery inbound-policy gate.

import { describe, expect, it } from "vitest";
import { evaluateInternalDeliveryPolicy } from "./internal-delivery";

type Mailbox = {
  id: string;
  owner_user_id: string;
  external_inbound_enabled: boolean | number;
  external_allow_mode: "all" | "allowlist";
  internal_inbound_mode: "everyone" | "contacts_only" | "none";
};

function makeRow(overrides: Partial<Mailbox> = {}): Mailbox {
  return {
    id: "mb-bob",
    owner_user_id: "user-bob",
    external_inbound_enabled: true,
    external_allow_mode: "all",
    internal_inbound_mode: "everyone",
    ...overrides,
  };
}

function makeEnv(prepareImpl?: (sql: string) => unknown): {
  DB: { prepare: (sql: string) => unknown };
} {
  return {
    DB: {
      prepare:
        prepareImpl ??
        (() => ({
          bind: () => ({
            all: async () => ({ results: [] }),
            first: async () => null,
          }),
        })),
    },
  };
}

describe("evaluateInternalDeliveryPolicy — Phase C2 / D-01", () => {
  it("external sender + external_inbound_enabled=false → reject", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const env = makeEnv() as any;
    const row = makeRow({ external_inbound_enabled: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await evaluateInternalDeliveryPolicy(
      env,
      row as any,
      "x@ext.com",
      undefined,
    );
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toBe("external-inbound-disabled");
  });

  it("external sender + allowlist mode + miss → reject", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const env = makeEnv() as any;
    const row = makeRow({ external_allow_mode: "allowlist" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await evaluateInternalDeliveryPolicy(
      env,
      row as any,
      "x@ext.com",
      undefined,
    );
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toBe("external-allowlist-miss");
  });

  it("external sender + allowlist mode + email match → accept", async () => {
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            all: async () => ({
              results: [{ sender_pattern: "x@ext.com", kind: "email" }],
            }),
            first: async () => null,
          }),
        }),
      },
    };
    const row = makeRow({ external_allow_mode: "allowlist" });
    const r = await evaluateInternalDeliveryPolicy(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      env as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      row as any,
      "x@ext.com",
      undefined,
    );
    expect(r.accepted).toBe(true);
  });

  it("internal sender + internal_inbound_mode=none → reject", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const env = makeEnv() as any;
    const row = makeRow({ internal_inbound_mode: "none" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await evaluateInternalDeliveryPolicy(
      env,
      row as any,
      "alice@actionnow.ai",
      "user-alice",
    );
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toBe("internal-inbound-none");
  });

  it("internal sender + contacts_only + sender NOT a contact → reject", async () => {
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            all: async () => ({ results: [] }),
            first: async () => null, // no contact row
          }),
        }),
      },
    };
    const row = makeRow({ internal_inbound_mode: "contacts_only" });
    const r = await evaluateInternalDeliveryPolicy(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      env as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      row as any,
      "alice@actionnow.ai",
      "user-alice",
    );
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toBe("internal-inbound-contacts-only");
  });

  it("internal sender + contacts_only + sender IS contact → accept", async () => {
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            all: async () => ({ results: [] }),
            first: async () => ({ "1": 1 }),
          }),
        }),
      },
    };
    const row = makeRow({ internal_inbound_mode: "contacts_only" });
    const r = await evaluateInternalDeliveryPolicy(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      env as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      row as any,
      "alice@actionnow.ai",
      "user-alice",
    );
    expect(r.accepted).toBe(true);
  });

  it("internal sender + everyone mode → accept", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const env = makeEnv() as any;
    const row = makeRow({ internal_inbound_mode: "everyone" });
    const r = await evaluateInternalDeliveryPolicy(
      env,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      row as any,
      "alice@actionnow.ai",
      "user-alice",
    );
    expect(r.accepted).toBe(true);
  });
});
