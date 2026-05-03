// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Tests for app/routes/admin/tokens.tsx and the per-mailbox tokens route.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { ToastProvider } from "~/ui/toast";
import { MemoryRouter } from "react-router";

// ---------------------------------------------------------------------------
// Mock react-router useParams for per-mailbox route
// ---------------------------------------------------------------------------
vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return {
    ...actual,
    useParams: vi.fn(() => ({ mailboxId: "mb-test-1" })),
  };
});

import AdminTokensRoute from "./tokens";
import MailboxTokensRoute from "../_app/mailbox/$mailboxId/tokens";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wrap(ui: React.ReactNode) {
  return render(
    <MemoryRouter>
      <ToastProvider>{ui}</ToastProvider>
    </MemoryRouter>,
  );
}

const ACTIVE_TOKEN = {
  id: "tok-1",
  cf_client_id: "abc.access",
  label: "my-bot",
  max_instances: 1,
  created_at: 1_700_000_000_000,
  last_seen_at: null,
  revoked_at: null,
  mailbox_id: "mb-test-1",
  issued_to_user: "u-alice",
};

const REVOKED_TOKEN = {
  ...ACTIVE_TOKEN,
  id: "tok-2",
  label: "old-bot",
  revoked_at: 1_700_100_000_000,
};

// ---------------------------------------------------------------------------
// AdminTokensRoute
// ---------------------------------------------------------------------------

describe("AdminTokensRoute", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ tokens: [ACTIVE_TOKEN, REVOKED_TOKEN] }),
      }),
    );
  });

  it("fetches /api/admin/tokens on mount", async () => {
    wrap(<AdminTokensRoute />);
    await waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/admin/tokens");
    });
  });

  it("renders token rows after load", async () => {
    wrap(<AdminTokensRoute />);
    await waitFor(() => {
      expect(screen.getByText("my-bot")).toBeInTheDocument();
      expect(screen.getByText("old-bot")).toBeInTheDocument();
    });
  });

  it("shows active / revoked counts in subtitle", async () => {
    wrap(<AdminTokensRoute />);
    await waitFor(() => {
      expect(screen.getByText(/1 active, 1 revoked/i)).toBeInTheDocument();
    });
  });

  it("shows empty state when no tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ tokens: [] }),
      }),
    );
    wrap(<AdminTokensRoute />);
    await waitFor(() => {
      expect(screen.getByText(/no agent tokens/i)).toBeInTheDocument();
    });
  });

  it("shows error when fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({}),
      }),
    );
    wrap(<AdminTokensRoute />);
    await waitFor(() => {
      expect(screen.getByText(/failed to load tokens/i)).toBeInTheDocument();
    });
  });

  it("revoke button opens RevokeTokenDialog", async () => {
    wrap(<AdminTokensRoute />);
    await waitFor(() => screen.getAllByRole("button", { name: /revoke/i }));
    fireEvent.click(screen.getAllByRole("button", { name: /revoke/i })[0]);
    await waitFor(() => {
      // Dialog content: "Revoke Token" heading
      expect(screen.getByText("Revoke Token")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// MailboxTokensRoute (per-mailbox)
// ---------------------------------------------------------------------------

describe("MailboxTokensRoute", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ tokens: [ACTIVE_TOKEN] }),
      }),
    );
  });

  it("fetches tokens for the mailbox on mount", async () => {
    wrap(<MailboxTokensRoute />);
    await waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        "/api/tokens/mailboxes/mb-test-1/tokens",
      );
    });
  });

  it("renders active token row", async () => {
    wrap(<MailboxTokensRoute />);
    await waitFor(() => {
      expect(screen.getByText("my-bot")).toBeInTheDocument();
    });
  });

  it("shows 'Issue Token' button", async () => {
    wrap(<MailboxTokensRoute />);
    // Button appears in header immediately
    const buttons = screen.getAllByRole("button", { name: /issue token/i });
    expect(buttons.length).toBeGreaterThan(0);
  });

  it("opens IssueTokenDialog when button clicked", async () => {
    wrap(<MailboxTokensRoute />);
    fireEvent.click(screen.getAllByRole("button", { name: /issue token/i })[0]);
    await waitFor(() => {
      expect(screen.getByText("Issue Agent Token")).toBeInTheDocument();
    });
  });

  it("shows empty state when no tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ tokens: [] }),
      }),
    );
    wrap(<MailboxTokensRoute />);
    await waitFor(() => {
      expect(screen.getByText(/no tokens yet/i)).toBeInTheDocument();
    });
  });

  it("shows error when fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: "Forbidden" }),
      }),
    );
    wrap(<MailboxTokensRoute />);
    await waitFor(() => {
      expect(screen.getByText("Forbidden")).toBeInTheDocument();
    });
  });
});
