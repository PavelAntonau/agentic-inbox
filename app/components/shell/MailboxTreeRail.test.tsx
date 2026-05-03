// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { ToastProvider } from "~/ui/toast";
import MailboxTreeRail from "./MailboxTreeRail";
import type { MailboxTreePayload } from "~/routes/_app/api.tree";

const PRIVATE_MAILBOX = {
  id: "mb-private",
  address: "alice@actionnow.ai",
  display_name: "Alice",
  owner_user_id: "u-alice",
  created_at: 1_700_000_000,
};

const GROUP_MAILBOX = {
  id: "mb-shared",
  address: "support@actionnow.ai",
  display_name: "Support",
  owner_user_id: "u-alice",
  created_at: 1_700_000_001,
};

const TREE_PAYLOAD: MailboxTreePayload = {
  groups: [
    {
      group: {
        id: "g-eng",
        name: "Engineering",
        description: null,
        owner_user_id: "u-alice",
        actor_role: "owner",
      },
      mailboxes: [GROUP_MAILBOX],
    },
  ],
  private: [PRIVATE_MAILBOX],
  followed: [],
};

const ME_PAYLOAD = { user_id: "u-alice", role: "global_owner" as const };

function mockFetch(tree: MailboxTreePayload = TREE_PAYLOAD, me = ME_PAYLOAD) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/mailboxes/tree")) {
      return new Response(JSON.stringify(tree), { status: 200 });
    }
    if (url.includes("/api/admin/me")) {
      return new Response(JSON.stringify(me), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
}

function renderRail() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ToastProvider>
          <MailboxTreeRail />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("MailboxTreeRail", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders group section with mailbox", async () => {
    mockFetch();
    renderRail();
    await waitFor(() => {
      expect(screen.getByText("Engineering")).toBeInTheDocument();
    });
    expect(screen.getByText("Support")).toBeInTheDocument();
  });

  it("renders private section", async () => {
    mockFetch();
    renderRail();
    await waitFor(() => {
      expect(screen.getByText("Private")).toBeInTheDocument();
    });
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  it("renders empty state when no mailboxes", async () => {
    mockFetch({ groups: [], private: [], followed: [] });
    renderRail();
    await waitFor(() => {
      expect(screen.getByText("No mailboxes yet")).toBeInTheDocument();
    });
  });

  it("collapses group on chevron click", async () => {
    mockFetch();
    renderRail();
    await waitFor(() => {
      expect(screen.getByText("Engineering")).toBeInTheDocument();
    });

    // The group button toggles aria-expanded
    const groupBtn = screen.getByRole("button", { name: /Engineering/ });
    expect(groupBtn).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(groupBtn);
    expect(groupBtn).toHaveAttribute("aria-expanded", "false");
  });

  it("shows followed section when followed mailboxes are returned", async () => {
    const followedTree: MailboxTreePayload = {
      ...TREE_PAYLOAD,
      followed: [
        {
          id: "mb-followed",
          address: "shared@other.ai",
          display_name: "Followed Box",
          owner_user_id: "u-bob",
          created_at: 1_700_000_002,
        },
      ],
    };
    mockFetch(followedTree);
    renderRail();
    await waitFor(() => {
      expect(screen.getByText("Followed")).toBeInTheDocument();
    });
    expect(screen.getByText("Followed Box")).toBeInTheDocument();
  });
});
