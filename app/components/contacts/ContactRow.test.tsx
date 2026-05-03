// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ContactRow, { type Contact } from "./ContactRow";

vi.mock("~/ui/toast", async () => {
  const actual =
    await vi.importActual<typeof import("~/ui/toast")>("~/ui/toast");
  return {
    ...actual,
    useToastManager: () => ({
      add: vi.fn(),
      toast: vi.fn(),
      dismiss: vi.fn(),
      dismissAll: vi.fn(),
    }),
  };
});

const ACTOR_ID = "u-alice";

function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    owner_user_id: "u-alice",
    contact_user_id: "u-bob",
    status: "accepted",
    initiated_by: "u-alice",
    created_at: 1_700_000_000_000,
    accepted_at: 1_700_000_001_000,
    email: "bob@actionnow.ai",
    display_name: "Bob",
    ...overrides,
  };
}

beforeEach(() => {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ContactRow — accepted state", () => {
  it("renders display name + email + status badge", () => {
    const contact = makeContact();
    render(
      <ContactRow
        contact={contact}
        actorUserId={ACTOR_ID}
        onMutated={() => {}}
      />,
    );
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("bob@actionnow.ai")).toBeInTheDocument();
    expect(screen.getByText("accepted")).toBeInTheDocument();
  });

  it("shows Block button on accepted contacts", () => {
    const contact = makeContact();
    render(
      <ContactRow
        contact={contact}
        actorUserId={ACTOR_ID}
        onMutated={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Block" })).toBeInTheDocument();
  });

  it("does NOT show Accept/Decline on accepted contacts", () => {
    const contact = makeContact();
    render(
      <ContactRow
        contact={contact}
        actorUserId={ACTOR_ID}
        onMutated={() => {}}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Accept" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Decline" }),
    ).not.toBeInTheDocument();
  });
});

describe("ContactRow — incoming pending state", () => {
  it("shows Accept and Decline buttons on incoming pending request", () => {
    // Incoming: contact_user_id is the actor (bob → alice request)
    const contact = makeContact({
      owner_user_id: "u-bob",
      contact_user_id: "u-alice",
      initiated_by: "u-bob",
      status: "pending",
      accepted_at: null,
    });
    render(
      <ContactRow
        contact={contact}
        actorUserId={ACTOR_ID}
        onMutated={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Accept" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Decline" })).toBeInTheDocument();
    expect(screen.getByText(/Sent you a request/i)).toBeInTheDocument();
  });

  it("clicking Accept POSTs to /api/contacts/:id/accept", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    const onMutated = vi.fn();
    const contact = makeContact({
      owner_user_id: "u-bob",
      contact_user_id: "u-alice",
      initiated_by: "u-bob",
      status: "pending",
      accepted_at: null,
    });
    render(
      <ContactRow
        contact={contact}
        actorUserId={ACTOR_ID}
        onMutated={onMutated}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => {
      const calls = fetchMock.mock.calls;
      const acceptCall = calls.find((c) =>
        String(c[0]).includes("/api/contacts/u-bob/accept"),
      );
      expect(acceptCall).toBeDefined();
      expect(onMutated).toHaveBeenCalled();
    });
  });

  it("clicking Decline POSTs to /api/contacts/:id/decline", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    const onMutated = vi.fn();
    const contact = makeContact({
      owner_user_id: "u-bob",
      contact_user_id: "u-alice",
      initiated_by: "u-bob",
      status: "pending",
      accepted_at: null,
    });
    render(
      <ContactRow
        contact={contact}
        actorUserId={ACTOR_ID}
        onMutated={onMutated}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() => {
      const calls = fetchMock.mock.calls;
      const declineCall = calls.find((c) =>
        String(c[0]).includes("/api/contacts/u-bob/decline"),
      );
      expect(declineCall).toBeDefined();
      expect(onMutated).toHaveBeenCalled();
    });
  });
});

describe("ContactRow — outgoing pending state", () => {
  it("shows 'Request sent' label and no action buttons on outgoing request", () => {
    const contact = makeContact({
      owner_user_id: "u-alice",
      contact_user_id: "u-bob",
      initiated_by: "u-alice",
      status: "pending",
      accepted_at: null,
    });
    render(
      <ContactRow
        contact={contact}
        actorUserId={ACTOR_ID}
        onMutated={() => {}}
      />,
    );
    expect(screen.getByText(/Request sent/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Accept" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Decline" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Block" }),
    ).not.toBeInTheDocument();
  });
});

describe("ContactRow — blocked state", () => {
  it("renders blocked badge and no action buttons", () => {
    const contact = makeContact({ status: "blocked", accepted_at: null });
    render(
      <ContactRow
        contact={contact}
        actorUserId={ACTOR_ID}
        onMutated={() => {}}
      />,
    );
    expect(screen.getByText("blocked")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Block" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Accept" }),
    ).not.toBeInTheDocument();
  });
});
