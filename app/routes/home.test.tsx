// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

// Tests for HomeRoute — TASK-2.4 coverage:
//   - No mid-page mailbox card (sidebar owns the list)
//   - Welcome / empty state always rendered when config is loaded
//   - Auto-create useEffect creates mailboxes from emailAddresses config
//   - Create Mailbox dialog is accessible when no mailboxes exist and not configured

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import HomeRoute from "./home";

// Suppress the toast provider dependency so we don't need a real ToastProvider
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

const SAMPLE_MAILBOXES = [
  { id: "mb-1", email: "alice@actionnow.ai", name: "alice" },
  { id: "mb-2", email: "bob@actionnow.ai", name: "bob" },
];

function makeConfig(
  opts: { domains?: string[]; emailAddresses?: string[] } = {},
) {
  return {
    domains: opts.domains ?? ["actionnow.ai"],
    emailAddresses: opts.emailAddresses ?? [],
  };
}

function setupFetch(
  opts: {
    mailboxes?: typeof SAMPLE_MAILBOXES;
    config?: ReturnType<typeof makeConfig>;
    createSpy?: (url: string) => void;
  } = {},
) {
  const mailboxes = opts.mailboxes ?? [];
  const config = opts.config ?? makeConfig();
  const createSpy = opts.createSpy;

  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();

      if (
        url.includes("/api/v1/mailboxes") &&
        !url.includes("/api/v1/mailboxes/")
      ) {
        // POST — create
        if (createSpy) {
          const req = input as Request;
          if (req instanceof Request && req.method === "POST") {
            createSpy(url);
            return new Response(
              JSON.stringify({
                id: "mb-new",
                email: "new@actionnow.ai",
                name: "new",
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
        }
        // GET — list
        return new Response(JSON.stringify(mailboxes), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes("/api/v1/config")) {
        return new Response(JSON.stringify(config), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not found", { status: 404 });
    },
  );
}

function renderHome() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter([{ path: "/", element: <HomeRoute /> }], {
    initialEntries: ["/"],
  });
  return {
    router,
    ...render(
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  };
}

describe("HomeRoute — TASK-2.4 (unified sidebar, no mid-page card)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the welcome/empty-state card when no mailboxes exist", async () => {
    setupFetch({ mailboxes: [] });
    renderHome();
    await waitFor(() => {
      expect(screen.getByText("No mailboxes yet")).toBeInTheDocument();
    });
  });

  it("does NOT render a per-mailbox link list in the main content area", async () => {
    setupFetch({ mailboxes: SAMPLE_MAILBOXES });
    renderHome();
    // Wait for config + mailboxes to load
    await waitFor(() => {
      expect(screen.queryByText("Loading")).not.toBeInTheDocument();
    });
    // The mid-page card used to render anchors with mailbox names — should be gone
    expect(
      screen.queryByRole("link", { name: /alice/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /bob/ })).not.toBeInTheDocument();
  });

  it("renders 'Select a mailbox' heading when mailboxes exist", async () => {
    setupFetch({ mailboxes: SAMPLE_MAILBOXES });
    renderHome();
    await waitFor(() => {
      expect(screen.getByText("Select a mailbox")).toBeInTheDocument();
    });
  });

  it("renders 'No mailboxes yet' heading when empty", async () => {
    setupFetch({ mailboxes: [] });
    renderHome();
    await waitFor(() => {
      expect(screen.getByText("No mailboxes yet")).toBeInTheDocument();
    });
  });

  it("shows Create Mailbox button when no mailboxes and not configured", async () => {
    setupFetch({ mailboxes: [], config: makeConfig({ emailAddresses: [] }) });
    renderHome();
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Create Mailbox/i }),
      ).toBeInTheDocument();
    });
  });

  it("does NOT show Create Mailbox button when already has mailboxes", async () => {
    setupFetch({ mailboxes: SAMPLE_MAILBOXES });
    renderHome();
    // Wait for data to settle
    await waitFor(() => {
      expect(screen.getByText("Select a mailbox")).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: /Create Mailbox/i }),
    ).not.toBeInTheDocument();
  });

  it("does NOT show Create Mailbox button when app is in managed-address mode", async () => {
    setupFetch({
      mailboxes: [],
      config: makeConfig({ emailAddresses: ["managed@actionnow.ai"] }),
    });
    renderHome();
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /Create Mailbox/i }),
      ).not.toBeInTheDocument();
    });
  });
});

describe("HomeRoute — auto-create useEffect", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("auto-creates mailboxes from emailAddresses config that don't exist yet", async () => {
    const createSpy = vi.fn();
    let mailboxes: Array<{ id: string; email: string; name: string }> = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();

        if (url.includes("/api/v1/mailboxes")) {
          if (init?.method === "POST") {
            createSpy();
            const newMb = {
              id: "mb-new",
              email: "auto@actionnow.ai",
              name: "auto",
            };
            mailboxes = [...mailboxes, newMb];
            return new Response(JSON.stringify(newMb), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify(mailboxes), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.includes("/api/v1/config")) {
          return new Response(
            JSON.stringify(
              makeConfig({ emailAddresses: ["auto@actionnow.ai"] }),
            ),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        return new Response("Not found", { status: 404 });
      },
    );

    renderHome();

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledTimes(1);
    });
  });

  it("does NOT auto-create when mailbox already exists in list", async () => {
    const createSpy = vi.fn();

    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();

        if (url.includes("/api/v1/mailboxes")) {
          if (init?.method === "POST") {
            createSpy();
            return new Response(JSON.stringify({}), { status: 200 });
          }
          // already exists
          return new Response(
            JSON.stringify([
              { id: "mb-1", email: "auto@actionnow.ai", name: "auto" },
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        if (url.includes("/api/v1/config")) {
          return new Response(
            JSON.stringify(
              makeConfig({ emailAddresses: ["auto@actionnow.ai"] }),
            ),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        return new Response("Not found", { status: 404 });
      },
    );

    renderHome();

    // Give time for effects to run
    await waitFor(() => {
      // mailboxes fetch has settled
      expect(screen.queryByText("Loading")).not.toBeInTheDocument();
    });

    // Should NOT have triggered create
    expect(createSpy).not.toHaveBeenCalled();
  });
});
