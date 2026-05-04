// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "~/ui/toast";
import ConnectedAgentsCard, { formatScope } from "./ConnectedAgentsCard";

function renderCard() {
  return render(
    <ToastProvider>
      <ConnectedAgentsCard />
    </ToastProvider>,
  );
}

const NOW = 1_777_900_000_000; // arbitrary fixed clock for relative times

function mkGrant(
  over: Partial<import("./ConnectedAgentsCard").AgentAuthorization> = {},
) {
  return {
    client_id: "client-claude",
    client_name: "Claude Code",
    client_uri: "https://claude.ai",
    client_icon: "https://claude.ai/logo.png",
    scopes: ["mcp:mailbox:read", "mcp:profile:read"],
    granted_at: NOW - 60 * 60 * 1000, // 1h ago
    last_used_at: NOW - 5 * 60 * 1000, // 5m ago
    is_trusted: true,
    ...over,
  };
}

describe("ConnectedAgentsCard", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // formatScope helper
  // -----------------------------------------------------------------------

  it("formatScope pretty-prints mcp:resource:action", () => {
    expect(formatScope("mcp:mailbox:read")).toBe("Mailbox · Read");
    expect(formatScope("mcp:contacts:write")).toBe("Contacts · Write");
    expect(formatScope("mcp:profile:read")).toBe("Profile · Read");
  });

  it("formatScope falls through unexpected scopes verbatim", () => {
    expect(formatScope("admin")).toBe("admin");
    expect(formatScope("mcp:mailbox")).toBe("mcp:mailbox");
    expect(formatScope("foo:bar:baz")).toBe("foo:bar:baz");
  });

  // -----------------------------------------------------------------------
  // Rendering states
  // -----------------------------------------------------------------------

  it("renders the empty state when the API returns []", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("[]", { status: 200 }),
    );
    renderCard();
    expect(
      await screen.findByText(/No connected MCP agents yet/),
    ).toBeInTheDocument();
  });

  it("renders an error message when the API errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 500 }),
    );
    renderCard();
    expect(
      await screen.findByText(/Failed to load \(500\)/),
    ).toBeInTheDocument();
  });

  it("renders one card per grant with name, scopes, and timestamps", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          mkGrant(),
          mkGrant({
            client_id: "client-cursor",
            client_name: "Cursor",
            scopes: ["mcp:mailbox:write"],
            is_trusted: false,
            last_used_at: null,
          }),
        ]),
        { status: 200 },
      ),
    );
    renderCard();

    const cards = await screen.findAllByTestId("connected-agent-card");
    expect(cards).toHaveLength(2);

    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("Cursor")).toBeInTheDocument();

    // Trusted badge on Claude only.
    expect(screen.getAllByTestId("trusted-badge")).toHaveLength(1);
    expect(screen.getByText("Registered")).toBeInTheDocument();

    // Scopes formatted.
    expect(screen.getByText("Mailbox · Read")).toBeInTheDocument();
    expect(screen.getByText("Profile · Read")).toBeInTheDocument();
    expect(screen.getByText("Mailbox · Write")).toBeInTheDocument();

    // Relative times. Both cards share granted_at, so getAllByText.
    expect(screen.getAllByText(/Granted 1h ago/)).toHaveLength(2);
    expect(screen.getByText(/Last used 5m ago/)).toBeInTheDocument();
    expect(screen.getByText(/Never used/)).toBeInTheDocument();
  });

  it("renders the icon image when client_icon is a valid HTTPS URL", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([mkGrant()]), { status: 200 }),
    );
    const { container } = renderCard();
    await screen.findByTestId("connected-agent-card");
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("https://claude.ai/logo.png");
    expect(
      screen.queryByTestId("connected-agent-icon-fallback"),
    ).not.toBeInTheDocument();
  });

  it("falls back to the plug icon when client_icon is non-HTTPS or absent", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          mkGrant({ client_icon: "javascript:alert(1)" }),
          mkGrant({ client_id: "no-icon", client_icon: null }),
        ]),
        { status: 200 },
      ),
    );
    const { container } = renderCard();
    await waitFor(() => {
      expect(screen.getAllByTestId("connected-agent-card")).toHaveLength(2);
    });
    expect(screen.getAllByTestId("connected-agent-icon-fallback")).toHaveLength(
      2,
    );
    expect(container.querySelector("img")).toBeNull();
  });

  it("falls back to client_id when client_name is null/blank", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          mkGrant({
            client_id: "client-anon",
            client_name: null,
            scopes: [],
          }),
          mkGrant({
            client_id: "client-blank",
            client_name: "   ",
            scopes: [],
          }),
        ]),
        { status: 200 },
      ),
    );
    renderCard();
    expect(await screen.findByText("client-anon")).toBeInTheDocument();
    expect(screen.getByText("client-blank")).toBeInTheDocument();
  });

  // -----------------------------------------------------------------------
  // Revoke flow
  // -----------------------------------------------------------------------

  it("calls DELETE :clientId on Revoke and refreshes the list on 204", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify([mkGrant()]), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response("[]", { status: 200 }));

    renderCard();
    const card = await screen.findByTestId("connected-agent-card");
    expect(card).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Revoke Claude Code/ }));

    await waitFor(() => {
      expect(
        screen.getByText(/No connected MCP agents yet/),
      ).toBeInTheDocument();
    });

    // 1: list, 2: delete, 3: re-list
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const deleteCall = fetchSpy.mock.calls[1];
    expect(deleteCall[0]).toBe(
      "/api/users/me/agent-authorizations/client-claude",
    );
    expect((deleteCall[1] as RequestInit).method).toBe("DELETE");
  });

  it("URL-encodes weird client_id characters in the DELETE path", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify([mkGrant({ client_id: "a/b c" })]), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response("[]", { status: 200 }));

    renderCard();
    await screen.findByTestId("connected-agent-card");
    fireEvent.click(screen.getByRole("button", { name: /Revoke/ }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });
    expect(fetchSpy.mock.calls[1][0]).toBe(
      "/api/users/me/agent-authorizations/a%2Fb%20c",
    );
  });

  it("treats 404 on revoke as already-revoked and silently refreshes", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify([mkGrant()]), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Authorization not found" }), {
          status: 404,
        }),
      )
      .mockResolvedValueOnce(new Response("[]", { status: 200 }));

    renderCard();
    await screen.findByTestId("connected-agent-card");
    fireEvent.click(screen.getByRole("button", { name: /Revoke Claude Code/ }));

    await waitFor(() => {
      expect(
        screen.getByText(/No connected MCP agents yet/),
      ).toBeInTheDocument();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
