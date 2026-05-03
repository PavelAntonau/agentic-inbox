// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import AdminSettingsRoute from "./settings";

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

const SAMPLE_SETTINGS = [
  {
    key: "max_regular_users",
    value: "100",
    updated_at: 1_700_000_000_000,
    updated_by: null,
  },
  {
    key: "max_global_admins",
    value: "5",
    updated_at: 1_700_000_000_000,
    updated_by: null,
  },
  {
    key: "default_user_visibility",
    value: "everyone",
    updated_at: 1_700_000_000_000,
    updated_by: null,
  },
];

function setupFetchMock(opts: { status?: number } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/api/admin/settings")) {
      if (opts.status && opts.status !== 200) {
        return new Response(JSON.stringify({ error: "Server error" }), {
          status: opts.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ settings: SAMPLE_SETTINGS }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("Not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("AdminSettingsRoute", () => {
  beforeEach(() => {
    setupFetchMock();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the settings page header", async () => {
    const router = createMemoryRouter(
      [{ path: "/admin/settings", element: <AdminSettingsRoute /> }],
      { initialEntries: ["/admin/settings"] },
    );
    render(<RouterProvider router={router} />);
    await waitFor(() => {
      expect(screen.getByText("Workspace Settings")).toBeInTheDocument();
    });
  });

  it("renders catalog rows after fetch completes", async () => {
    const router = createMemoryRouter(
      [{ path: "/admin/settings", element: <AdminSettingsRoute /> }],
      { initialEntries: ["/admin/settings"] },
    );
    render(<RouterProvider router={router} />);
    await waitFor(() => {
      expect(screen.getByText("Max regular users")).toBeInTheDocument();
      expect(screen.getByText("Max global admins")).toBeInTheDocument();
    });
  });

  it("renders the visibility enum dropdown for default_user_visibility", async () => {
    const router = createMemoryRouter(
      [{ path: "/admin/settings", element: <AdminSettingsRoute /> }],
      { initialEntries: ["/admin/settings"] },
    );
    render(<RouterProvider router={router} />);
    await waitFor(() => {
      expect(screen.getByText("Default user visibility")).toBeInTheDocument();
    });
  });

  it("shows an error and retry on fetch failure", async () => {
    vi.unstubAllGlobals();
    setupFetchMock({ status: 500 });
    const router = createMemoryRouter(
      [{ path: "/admin/settings", element: <AdminSettingsRoute /> }],
      { initialEntries: ["/admin/settings"] },
    );
    render(<RouterProvider router={router} />);
    await waitFor(() => {
      expect(screen.getByText(/Failed to load settings/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    });
  });
});
