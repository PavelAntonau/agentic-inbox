// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Unit tests for token UI components (TokenRow, RevokeTokenDialog,
// IssueTokenDialog, CopyTokenCard).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ToastProvider } from "~/ui/toast";
import TokenRow, { type AgentToken } from "./TokenRow";
import RevokeTokenDialog from "./RevokeTokenDialog";
import IssueTokenDialog from "./IssueTokenDialog";
import CopyTokenCard, { type NewTokenSecret } from "./CopyTokenCard";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACTIVE_TOKEN: AgentToken = {
  id: "tok-1",
  cf_client_id: "abc123.access",
  label: "my-agent",
  max_instances: 2,
  created_at: 1_700_000_000_000,
  last_seen_at: null,
  revoked_at: null,
};

const REVOKED_TOKEN: AgentToken = {
  ...ACTIVE_TOKEN,
  id: "tok-2",
  revoked_at: 1_700_100_000_000,
};

const NEW_TOKEN_SECRET: NewTokenSecret = {
  id: "tok-new",
  label: "test-agent",
  cf_client_id: "newclient.access",
  client_secret: "super-secret-value",
  expires_at: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
};

// Wrap with toast provider
function wrap(ui: React.ReactNode) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

// ---------------------------------------------------------------------------
// TokenRow
// ---------------------------------------------------------------------------

describe("TokenRow", () => {
  it("renders label and client_id", () => {
    const onRevoke = vi.fn();
    wrap(
      <table>
        <tbody>
          <TokenRow token={ACTIVE_TOKEN} onRevoke={onRevoke} />
        </tbody>
      </table>,
    );
    expect(screen.getByText("my-agent")).toBeInTheDocument();
    expect(screen.getByText("abc123.access")).toBeInTheDocument();
  });

  it("shows Active badge for non-revoked token", () => {
    const onRevoke = vi.fn();
    wrap(
      <table>
        <tbody>
          <TokenRow token={ACTIVE_TOKEN} onRevoke={onRevoke} />
        </tbody>
      </table>,
    );
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("shows Revoked badge for revoked token", () => {
    const onRevoke = vi.fn();
    wrap(
      <table>
        <tbody>
          <TokenRow token={REVOKED_TOKEN} onRevoke={onRevoke} />
        </tbody>
      </table>,
    );
    expect(screen.getByText("Revoked")).toBeInTheDocument();
  });

  it("shows revoke button only for active token", () => {
    const onRevoke = vi.fn();
    wrap(
      <table>
        <tbody>
          <TokenRow token={ACTIVE_TOKEN} onRevoke={onRevoke} />
        </tbody>
      </table>,
    );
    expect(screen.getByLabelText("Revoke token")).toBeInTheDocument();
  });

  it("does not show revoke button for revoked token", () => {
    const onRevoke = vi.fn();
    wrap(
      <table>
        <tbody>
          <TokenRow token={REVOKED_TOKEN} onRevoke={onRevoke} />
        </tbody>
      </table>,
    );
    expect(screen.queryByLabelText("Revoke token")).not.toBeInTheDocument();
  });

  it("calls onRevoke when revoke button clicked", () => {
    const onRevoke = vi.fn();
    wrap(
      <table>
        <tbody>
          <TokenRow token={ACTIVE_TOKEN} onRevoke={onRevoke} />
        </tbody>
      </table>,
    );
    fireEvent.click(screen.getByLabelText("Revoke token"));
    expect(onRevoke).toHaveBeenCalledWith(ACTIVE_TOKEN);
  });
});

// ---------------------------------------------------------------------------
// RevokeTokenDialog
// ---------------------------------------------------------------------------

describe("RevokeTokenDialog", () => {
  it("renders token label in dialog body", () => {
    wrap(
      <RevokeTokenDialog
        open={true}
        onOpenChange={vi.fn()}
        token={ACTIVE_TOKEN}
        onRevoked={vi.fn()}
      />,
    );
    expect(screen.getByText(/my-agent/i)).toBeInTheDocument();
  });

  it("renders null when token is null", () => {
    const { container } = wrap(
      <RevokeTokenDialog
        open={true}
        onOpenChange={vi.fn()}
        token={null}
        onRevoked={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("calls fetch and onRevoked on confirm", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const onRevoked = vi.fn();
    const onOpenChange = vi.fn();
    wrap(
      <RevokeTokenDialog
        open={true}
        onOpenChange={onOpenChange}
        token={ACTIVE_TOKEN}
        onRevoked={onRevoked}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /revoke/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/tokens/${ACTIVE_TOKEN.id}/revoke`,
        expect.objectContaining({ method: "POST" }),
      );
      expect(onRevoked).toHaveBeenCalled();
    });

    vi.unstubAllGlobals();
  });

  it("shows error toast when fetch fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Server error" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    wrap(
      <RevokeTokenDialog
        open={true}
        onOpenChange={vi.fn()}
        token={ACTIVE_TOKEN}
        onRevoked={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /revoke/i }));

    await waitFor(() => {
      expect(screen.getByText("Server error")).toBeInTheDocument();
    });

    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// CopyTokenCard
// ---------------------------------------------------------------------------

describe("CopyTokenCard", () => {
  beforeEach(() => {
    // happy-dom clipboard stub
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
      writable: true,
    });
  });

  it("renders the one-time warning banner", () => {
    wrap(<CopyTokenCard token={NEW_TOKEN_SECRET} />);
    expect(
      screen.getByText(/only time you'll see the secret/i),
    ).toBeInTheDocument();
  });

  it("renders CF_ACCESS_CLIENT_ID label", () => {
    wrap(<CopyTokenCard token={NEW_TOKEN_SECRET} />);
    // Text appears in both the label <p> and the mcp-remote snippet <code> — use getAllByText
    expect(screen.getAllByText("CF_ACCESS_CLIENT_ID").length).toBeGreaterThan(
      0,
    );
  });

  it("renders CF_ACCESS_CLIENT_SECRET label", () => {
    wrap(<CopyTokenCard token={NEW_TOKEN_SECRET} />);
    expect(
      screen.getAllByText("CF_ACCESS_CLIENT_SECRET").length,
    ).toBeGreaterThan(0);
  });

  it("renders the client_id value", () => {
    wrap(<CopyTokenCard token={NEW_TOKEN_SECRET} />);
    expect(screen.getByText("newclient.access")).toBeInTheDocument();
  });

  it("renders the mcp-remote snippet section", () => {
    wrap(<CopyTokenCard token={NEW_TOKEN_SECRET} />);
    expect(screen.getByText(/mcp-remote snippet/i)).toBeInTheDocument();
    expect(screen.getByText(/npx -y mcp-remote/i)).toBeInTheDocument();
  });

  it("renders Download as JSON button", () => {
    wrap(<CopyTokenCard token={NEW_TOKEN_SECRET} />);
    expect(
      screen.getByRole("button", { name: /download as json/i }),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// IssueTokenDialog
// ---------------------------------------------------------------------------

describe("IssueTokenDialog", () => {
  it("renders the issue form with label input", () => {
    wrap(
      <IssueTokenDialog
        open={true}
        onOpenChange={vi.fn()}
        mailboxId="mb-1"
        onIssued={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/label/i)).toBeInTheDocument();
  });

  it("renders all duration chips", () => {
    wrap(
      <IssueTokenDialog
        open={true}
        onOpenChange={vi.fn()}
        mailboxId="mb-1"
        onIssued={vi.fn()}
      />,
    );
    expect(screen.getByText("30 d")).toBeInTheDocument();
    expect(screen.getByText("90 d (default)")).toBeInTheDocument();
    expect(screen.getByText("1 y")).toBeInTheDocument();
    expect(screen.getByText("forever")).toBeInTheDocument();
  });

  it("shows copy card after successful issue", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        token: NEW_TOKEN_SECRET,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const onIssued = vi.fn();
    wrap(
      <IssueTokenDialog
        open={true}
        onOpenChange={vi.fn()}
        mailboxId="mb-1"
        onIssued={onIssued}
      />,
    );

    // Fill label
    fireEvent.change(screen.getByLabelText(/label/i), {
      target: { value: "test-agent" },
    });
    fireEvent.click(screen.getByRole("button", { name: /issue token/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/only time you'll see the secret/i),
      ).toBeInTheDocument();
      expect(onIssued).toHaveBeenCalled();
    });

    vi.unstubAllGlobals();
  });

  it("shows error toast when label is empty on submit", async () => {
    wrap(
      <IssueTokenDialog
        open={true}
        onOpenChange={vi.fn()}
        mailboxId="mb-1"
        onIssued={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /issue token/i }));
    await waitFor(() => {
      expect(screen.getByText("Label is required")).toBeInTheDocument();
    });
  });

  it("shows error toast when fetch fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Forbidden" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    wrap(
      <IssueTokenDialog
        open={true}
        onOpenChange={vi.fn()}
        mailboxId="mb-1"
        onIssued={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText(/label/i), {
      target: { value: "my-label" },
    });
    fireEvent.click(screen.getByRole("button", { name: /issue token/i }));

    await waitFor(() => {
      expect(screen.getByText("Forbidden")).toBeInTheDocument();
    });

    vi.unstubAllGlobals();
  });
});
