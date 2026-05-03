// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AuditLogBrowser from "./AuditLogBrowser";

// Mock the toast manager (imported transitively via ~/ui)
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

const SAMPLE_ROWS = [
  {
    id: 1,
    at: 1_700_000_000_000,
    actor_user_id: "u-alice",
    actor_token_id: null,
    action: "email.send",
    target_type: "email",
    target_id: "e-1",
    scope_group_id: null,
    meta_json: null,
    ip: null,
  },
  {
    id: 2,
    at: 1_700_000_001_000,
    actor_user_id: "u-bob",
    actor_token_id: null,
    action: "contact.request",
    target_type: "contact",
    target_id: "u-carol",
    scope_group_id: null,
    meta_json: null,
    ip: null,
  },
  {
    id: 3,
    at: 1_700_000_002_000,
    actor_user_id: null,
    actor_token_id: "tok-1",
    action: "token.issue",
    target_type: "agent_token",
    target_id: "tok-1",
    scope_group_id: null,
    meta_json: null,
    ip: null,
  },
];

function setupFetchMock(opts: { totalCount?: number } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/admin/obs/audit")) {
      return new Response(
        JSON.stringify({
          rows: SAMPLE_ROWS,
          pagination: {
            page: 1,
            per_page: 50,
            total_count: opts.totalCount ?? 3,
            total_pages: Math.ceil((opts.totalCount ?? 3) / 50),
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("Not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("AuditLogBrowser", () => {
  beforeEach(() => {
    setupFetchMock();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the panel header", async () => {
    render(<AuditLogBrowser />);
    await waitFor(() => {
      expect(screen.getByText("Audit Log")).toBeInTheDocument();
    });
  });

  it("renders audit rows after fetch completes", async () => {
    render(<AuditLogBrowser />);
    await waitFor(() => {
      expect(screen.getByText("email.send")).toBeInTheDocument();
      expect(screen.getByText("contact.request")).toBeInTheDocument();
      expect(screen.getByText("token.issue")).toBeInTheDocument();
    });
  });

  it("renders all action preset filter chips", async () => {
    render(<AuditLogBrowser />);
    await waitFor(() => {
      // Each preset chip is a button rendering the prefix as its label
      expect(
        screen.getByRole("button", { name: "email." }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "contact." }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "token." }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "visibility." }),
      ).toBeInTheDocument();
    });
  });

  it("clicking an action chip triggers a refetch with action filter", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    render(<AuditLogBrowser />);
    await waitFor(() => {
      expect(screen.getByText("email.send")).toBeInTheDocument();
    });
    const initialCallCount = fetchMock.mock.calls.length;

    const emailChip = screen.getByRole("button", { name: "email." });
    fireEvent.click(emailChip);

    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(initialCallCount);
      // The latest call should include action=email.
      const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
      expect(String(lastCall[0])).toContain("action=email.");
    });
  });

  it("renders pagination controls when total_count exceeds page size", async () => {
    vi.unstubAllGlobals();
    setupFetchMock({ totalCount: 250 });
    render(<AuditLogBrowser />);
    await waitFor(() => {
      // Pagination controls render when totalCount > perPage
      expect(screen.getByText("email.send")).toBeInTheDocument();
    });
    // Pagination minimal renders prev/next buttons
    await waitFor(() => {
      const summaryNode = screen.getByText(/250 events/);
      expect(summaryNode).toBeInTheDocument();
    });
  });

  it("renders empty state when no rows returned", async () => {
    vi.unstubAllGlobals();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            rows: [],
            pagination: {
              page: 1,
              per_page: 50,
              total_count: 0,
              total_pages: 0,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<AuditLogBrowser />);
    await waitFor(() => {
      expect(screen.getByText(/No audit events found/i)).toBeInTheDocument();
    });
  });
});
