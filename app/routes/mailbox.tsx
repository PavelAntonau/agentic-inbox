// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// mailbox.tsx — per-mailbox route wrapper.
//
// Phase 4: This route is now nested inside _app.tsx which provides the
// three-pane Outlook shell (rail + center + preview).  The full-height layout,
// Sidebar overlay, AgentSidebar, and ComposeEmail are managed by the shell;
// this component just renders the center-pane <Outlet />.

import { useEffect, useRef } from "react";
import { Outlet, useParams } from "react-router";
import AgentSidebar from "~/components/AgentSidebar";
import ResizablePanel from "~/components/shell/ResizablePanel";
import { useMailbox } from "~/queries/mailboxes";
import { useUIStore } from "~/hooks/useUIStore";

export default function MailboxRoute() {
  const { mailboxId } = useParams<{ mailboxId: string }>();
  // Prefetch mailbox data for child components (Header breadcrumb, Sidebar, etc.)
  useMailbox(mailboxId);
  const prevMailboxIdRef = useRef<string | undefined>(undefined);
  const { isAgentPanelOpen, closePanel, closeComposeModal } = useUIStore();

  useEffect(() => {
    if (
      prevMailboxIdRef.current &&
      mailboxId &&
      prevMailboxIdRef.current !== mailboxId
    ) {
      closePanel();
      closeComposeModal();
    }
    prevMailboxIdRef.current = mailboxId;
  }, [mailboxId, closeComposeModal, closePanel]);

  return (
    <div className="flex h-full overflow-hidden">
      {/* Main content — fills center pane provided by _app.tsx shell */}
      <div className="flex-1 flex flex-col min-w-0 bg-card overflow-hidden">
        <main className="flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>

      {/* Agent + MCP sidebar — togglable on desktop, resizable + collapsible
          when open. Toggle via the header robot button drives isAgentPanelOpen
          (mount/unmount); once mounted, the divider's chevron drives an
          intra-session collapse without losing the sidebar's content state.
          data-shell-sidebar / data-shadow-side="left" paints the curved-
          paper drop shadow on the LEFT edge (UAT round-3 second batch). */}
      {isAgentPanelOpen && (
        <ResizablePanel
          storageKey="ai.shell.agentSidebar"
          defaultWidth={380}
          minWidth={280}
          maxWidth={640}
          side="right"
          ariaLabel="Resize agent panel"
          className="hidden lg:flex flex-col bg-card overflow-hidden"
        >
          <div
            data-shell-sidebar
            data-shadow-side="left"
            className="flex flex-col w-full h-full relative"
          >
            <AgentSidebar />
          </div>
        </ResizablePanel>
      )}
    </div>
  );
}
