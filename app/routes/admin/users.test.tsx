// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import AdminLayout from "./_layout";
import AdminUsersRoute from "./users";

// AdminLayout now includes <Header /> (which mounts GlobalSearch + a
// useQuery on /api/mailboxes/tree). The Header relocation in commit
// e4c2e19 moved Header out of root.tsx into the authenticated layouts
// to fix the public-shell leak; that means tests rendering the layout
// directly need their own QueryClientProvider. Helper below wraps every
// render with a fresh QueryClient (per-test isolation).
function renderWithProviders(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

// Mock toast manager since happy-dom doesn't have the real provider
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

const SAMPLE_USERS = [
  {
    id: "u-alice",
    email: "alice@actionnow.ai",
    display_name: "Alice",
    role: "global_owner",
    status: "active",
    last_login_at: 1_700_000_000_000,
    owns_mailboxes_count: 0,
  },
  {
    id: "u-bob",
    email: "bob@actionnow.ai",
    display_name: "Bob",
    role: "user",
    status: "active",
    last_login_at: null,
    owns_mailboxes_count: 0,
  },
];

function setupFetchMock(opts: { meStatus?: number; meRole?: string } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/api/admin/users")) {
      return new Response(JSON.stringify({ users: SAMPLE_USERS }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("/api/admin/me")) {
      return new Response(
        JSON.stringify({
          user_id: "u-alice",
          role: opts.meRole ?? "global_owner",
        }),
        {
          status: opts.meStatus ?? 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    return new Response("Not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function setupForbiddenFetchMock() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/api/admin/users")) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("Not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("AdminLayout role gate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("redirects to / when /api/admin/users returns 403", async () => {
    setupForbiddenFetchMock();
    const router = createMemoryRouter(
      [
        {
          path: "/admin",
          element: <AdminLayout />,
          children: [{ path: "users", element: <div>users</div> }],
        },
        { path: "/", element: <div>home</div> },
      ],
      { initialEntries: ["/admin/users"] },
    );
    renderWithProviders(<RouterProvider router={router} />);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/");
    });
  });

  it("renders the outlet when authorized", async () => {
    setupFetchMock();
    const router = createMemoryRouter(
      [
        {
          path: "/admin",
          element: <AdminLayout />,
          children: [{ path: "users", element: <div>users-content</div> }],
        },
        { path: "/", element: <div>home</div> },
      ],
      { initialEntries: ["/admin/users"] },
    );
    renderWithProviders(<RouterProvider router={router} />);
    await waitFor(() => {
      expect(screen.getByText("users-content")).toBeInTheDocument();
    });
  });
});

describe("AdminUsersRoute", () => {
  beforeEach(() => {
    setupFetchMock();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the user table after load", async () => {
    const router = createMemoryRouter(
      [{ path: "/admin/users", element: <AdminUsersRoute /> }],
      { initialEntries: ["/admin/users"] },
    );
    renderWithProviders(<RouterProvider router={router} />);
    await waitFor(() => {
      expect(screen.getByText("alice@actionnow.ai")).toBeInTheDocument();
      expect(screen.getByText("bob@actionnow.ai")).toBeInTheDocument();
    });
  });

  it("shows the Owner badge for global_owner rows", async () => {
    const router = createMemoryRouter(
      [{ path: "/admin/users", element: <AdminUsersRoute /> }],
      { initialEntries: ["/admin/users"] },
    );
    renderWithProviders(<RouterProvider router={router} />);
    await waitFor(() => {
      expect(screen.getByText("Owner")).toBeInTheDocument();
    });
  });

  it("shows Promote action for regular users when actor is owner", async () => {
    const router = createMemoryRouter(
      [{ path: "/admin/users", element: <AdminUsersRoute /> }],
      { initialEntries: ["/admin/users"] },
    );
    renderWithProviders(<RouterProvider router={router} />);
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Promote" }),
      ).toBeInTheDocument();
    });
  });

  it("renders the Invite button", async () => {
    const router = createMemoryRouter(
      [{ path: "/admin/users", element: <AdminUsersRoute /> }],
      { initialEntries: ["/admin/users"] },
    );
    renderWithProviders(<RouterProvider router={router} />);
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Invite/ }),
      ).toBeInTheDocument();
    });
  });
});
