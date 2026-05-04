// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

// Tests for PolicyCard — TASK-2.5 coverage:
//   - Renders all three sections (External inbound, Internal inbound, Outbound)
//   - external_send_enabled toggle: initial state (false), click → debounced PATCH
//   - external_send_enabled toggle: click again → toggles back
//   - Loading skeleton and fetch-error states

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import PolicyCard from "./PolicyCard";

const BASE_POLICIES = {
  external_inbound_enabled: true,
  external_allow_mode: "all" as const,
  internal_inbound_mode: "everyone" as const,
  allowlist: [],
  external_send_enabled: false,
};

function makePoliciesResponse(overrides: Partial<typeof BASE_POLICIES> = {}) {
  return { ...BASE_POLICIES, ...overrides };
}

function setupFetch(
  opts: {
    policies?: typeof BASE_POLICIES;
    patchSpy?: ReturnType<typeof vi.fn>;
    fetchStatus?: number;
  } = {},
) {
  const policies = opts.policies ?? makePoliciesResponse();
  const patchSpy = opts.patchSpy;
  const fetchStatus = opts.fetchStatus ?? 200;

  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/api/mailboxes/") && url.includes("/policies")) {
        if (init?.method === "PATCH") {
          if (patchSpy) {
            const body = init.body ? JSON.parse(init.body as string) : {};
            patchSpy(body);
          }
          return new Response(JSON.stringify({}), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        // GET
        return new Response(JSON.stringify(policies), {
          status: fetchStatus,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not found", { status: 404 });
    },
  );
}

function renderCard(inboxId = "test-inbox-id") {
  return render(
    <MemoryRouter>
      <PolicyCard inboxId={inboxId} />
    </MemoryRouter>,
  );
}

describe("PolicyCard — Section 3: Outbound (TASK-2.5)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders the Outbound section heading", async () => {
    setupFetch();
    renderCard();
    await waitFor(() => {
      expect(screen.getByText("Outbound")).toBeInTheDocument();
    });
  });

  it("renders the outbound help text", async () => {
    setupFetch();
    renderCard();
    await waitFor(() => {
      expect(
        screen.getByText(
          /can only send to other mailboxes hosted in this app/i,
        ),
      ).toBeInTheDocument();
    });
  });

  it("renders external_send_enabled toggle in off state by default", async () => {
    setupFetch({
      policies: makePoliciesResponse({ external_send_enabled: false }),
    });
    renderCard();
    await waitFor(() => {
      const toggle = screen.getByRole("switch", {
        name: /enable external sending/i,
      });
      expect(toggle).toHaveAttribute("aria-checked", "false");
    });
  });

  it("clicking toggle calls debounced PATCH with external_send_enabled: true", async () => {
    const patchSpy = vi.fn();
    setupFetch({
      policies: makePoliciesResponse({ external_send_enabled: false }),
      patchSpy,
    });
    renderCard();

    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: /enable external sending/i }),
      ).toBeInTheDocument();
    });

    const toggle = screen.getByRole("switch", {
      name: /enable external sending/i,
    });
    fireEvent.click(toggle);

    // Advance past the 300 ms debounce
    await vi.advanceTimersByTimeAsync(350);

    await waitFor(() => {
      expect(patchSpy).toHaveBeenCalledWith({ external_send_enabled: true });
    });
  });

  it("toggle reflects optimistic state immediately after click (before PATCH fires)", async () => {
    setupFetch({
      policies: makePoliciesResponse({ external_send_enabled: false }),
    });
    renderCard();

    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: /enable external sending/i }),
      ).toHaveAttribute("aria-checked", "false");
    });

    const toggle = screen.getByRole("switch", {
      name: /enable external sending/i,
    });
    fireEvent.click(toggle);

    // Optimistic update — should already be true before the debounce fires
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("clicking toggle twice calls PATCH with false (toggles back)", async () => {
    const patchSpy = vi.fn();
    setupFetch({
      policies: makePoliciesResponse({ external_send_enabled: false }),
      patchSpy,
    });
    renderCard();

    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: /enable external sending/i }),
      ).toBeInTheDocument();
    });

    const toggle = screen.getByRole("switch", {
      name: /enable external sending/i,
    });

    // First click — on
    fireEvent.click(toggle);
    // Second click — off (within debounce window, so the timer resets)
    fireEvent.click(toggle);

    await vi.advanceTimersByTimeAsync(350);

    await waitFor(() => {
      // The last PATCH should have false (second click won the debounce race)
      expect(patchSpy).toHaveBeenLastCalledWith({
        external_send_enabled: false,
      });
    });
  });

  it("renders external_send_enabled toggle in on state when policy is true", async () => {
    setupFetch({
      policies: makePoliciesResponse({ external_send_enabled: true }),
    });
    renderCard();
    await waitFor(() => {
      const toggle = screen.getByRole("switch", {
        name: /enable external sending/i,
      });
      expect(toggle).toHaveAttribute("aria-checked", "true");
    });
  });
});

describe("PolicyCard — all three sections present", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders all three section headings", async () => {
    setupFetch();
    renderCard();
    await waitFor(() => {
      expect(screen.getByText("External inbound")).toBeInTheDocument();
      expect(screen.getByText("Internal inbound")).toBeInTheDocument();
      expect(screen.getByText("Outbound")).toBeInTheDocument();
    });
  });

  it("shows loading skeleton before fetch resolves", () => {
    // Never resolves — stays in loading state
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise(() => {}),
    );
    renderCard();
    // The skeleton uses animate-pulse; we verify the sections are not yet visible
    expect(screen.queryByText("External inbound")).not.toBeInTheDocument();
    expect(screen.queryByText("Outbound")).not.toBeInTheDocument();
  });

  it("shows error state when fetch fails", async () => {
    setupFetch({ fetchStatus: 500 });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load policies/i)).toBeInTheDocument();
    });
  });
});
