// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SettingsRoute from "./settings";

// Mock toast manager
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

// Mock the mailbox queries — provide a stable mailbox object so the route
// renders past the "loading" guard.
vi.mock("~/queries/mailboxes", () => ({
  useMailbox: () => ({
    data: {
      id: "mb-1",
      name: "Test Mailbox",
      email: "test@example.com",
      settings: { fromName: "Test", agentSystemPrompt: "" },
    },
  }),
  useUpdateMailbox: () => ({
    mutateAsync: vi.fn().mockResolvedValue(undefined),
  }),
}));

function setupFetchMock(
  opts: { visibility?: string; defaultVis?: string } = {},
) {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";

      if (url.endsWith("/api/users/me") && method === "GET") {
        return new Response(
          JSON.stringify({
            id: "u-alice",
            email: "alice@actionnow.ai",
            display_name: "Alice",
            role: "user",
            visibility: opts.visibility ?? "everyone",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.endsWith("/api/admin/settings") && method === "GET") {
        return new Response(
          JSON.stringify({
            settings: [
              {
                key: "default_user_visibility",
                value: opts.defaultVis ?? "everyone",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.endsWith("/api/users/me/visibility") && method === "PATCH") {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        return new Response(
          JSON.stringify({ ok: true, visibility: body.visibility }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response("Not found", { status: 404 });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderRoute() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      {
        path: "/mailbox/:mailboxId/settings",
        element: <SettingsRoute />,
      },
    ],
    { initialEntries: ["/mailbox/mb-1/settings"] },
  );
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("SettingsRoute — Visibility radio (Phase 6)", () => {
  beforeEach(() => {
    setupFetchMock();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the Visibility section", async () => {
    renderRoute();
    await waitFor(() => {
      // Match the visible section header (legend has the same text but is sr-only).
      // Using getAllByText handles both occurrences without ambiguity.
      const matches = screen.getAllByText("Visibility");
      expect(matches.length).toBeGreaterThan(0);
    });
  });

  it("renders all three visibility radio options", async () => {
    renderRoute();
    await waitFor(() => {
      expect(screen.getByLabelText(/Everyone/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Contacts only/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Nobody/i)).toBeInTheDocument();
    });
  });

  it("preselects the radio matching users.visibility from /api/users/me", async () => {
    vi.unstubAllGlobals();
    setupFetchMock({ visibility: "contacts" });
    renderRoute();
    await waitFor(() => {
      const contactsRadio = screen.getByLabelText(/Contacts only/i);
      expect((contactsRadio as HTMLInputElement).checked).toBe(true);
    });
  });

  it("clicking a different radio submits PATCH /api/users/me/visibility", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    renderRoute();
    await waitFor(() => {
      expect(screen.getByLabelText(/Contacts only/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText(/Contacts only/i));

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find((c) => {
        const url = String(c[0]);
        const method = (c[1] as RequestInit | undefined)?.method;
        return url.endsWith("/api/users/me/visibility") && method === "PATCH";
      });
      expect(patchCall).toBeDefined();
      const body = JSON.parse(String((patchCall![1] as RequestInit).body));
      expect(body.visibility).toBe("contacts");
    });
  });

  it("renders the 'Default for new users' caption from settings catalog", async () => {
    vi.unstubAllGlobals();
    setupFetchMock({ defaultVis: "contacts" });
    renderRoute();
    await waitFor(() => {
      expect(screen.getByText(/Default for new users/i)).toBeInTheDocument();
      expect(screen.getByText("contacts")).toBeInTheDocument();
    });
  });
});
