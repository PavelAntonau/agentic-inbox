// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "~/ui/toast";
import NotificationBell from "./NotificationBell";

function renderBell() {
  return render(
    <ToastProvider>
      <NotificationBell />
    </ToastProvider>,
  );
}

describe("NotificationBell", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders no badge when there are zero unseen invitations", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ invitations: [] }), { status: 200 }),
    );
    renderBell();
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Notifications/ }),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId("notification-bell-badge"),
    ).not.toBeInTheDocument();
  });

  it("renders the badge with the unread count when invitations are returned", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          invitations: [
            {
              id: "inv-1",
              group_id: "g-1",
              group_name: "Engineering",
              group_description: null,
              inviter_user_id: "u-1",
              inviter_display_name: "Alice",
              inviter_email: "alice@actionnow.ai",
              invited_at: 1_700_000_000,
            },
            {
              id: "inv-2",
              group_id: "g-2",
              group_name: "Marketing",
              group_description: null,
              inviter_user_id: "u-1",
              inviter_display_name: null,
              inviter_email: "alice@actionnow.ai",
              invited_at: 1_700_000_000,
            },
          ],
        }),
        { status: 200 },
      ),
    );
    renderBell();
    const badge = await screen.findByTestId("notification-bell-badge");
    expect(badge).toHaveTextContent("2");
  });

  it("collapses the badge to 9+ when there are ten or more unseen", async () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      id: `inv-${i}`,
      group_id: `g-${i}`,
      group_name: `Group ${i}`,
      group_description: null,
      inviter_user_id: "u-1",
      inviter_display_name: "Alice",
      inviter_email: "alice@actionnow.ai",
      invited_at: 1_700_000_000,
    }));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ invitations: items }), { status: 200 }),
    );
    renderBell();
    const badge = await screen.findByTestId("notification-bell-badge");
    expect(badge).toHaveTextContent("9+");
  });

  it("renders no badge if the unseen endpoint errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 500 }),
    );
    renderBell();
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Notifications/ }),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId("notification-bell-badge"),
    ).not.toBeInTheDocument();
  });
});
