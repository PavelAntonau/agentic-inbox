// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// _app.tsx — Outlook-style two-pane shell.
//
// Layout:   [MailboxTreeRail (left)] | [main content (center)]
//
// All authenticated routes except /admin/** render inside this shell.
// The rail fetches /api/mailboxes/tree on the client and caches per
// React Query's staleTime.  The center pane is always the current <Outlet>.
// The selected-email detail surface lives inside the route's own
// MailboxSplitView (center pane), not as a third shell column.

import { Outlet } from "react-router";
import ComposeEmail from "~/components/ComposeEmail";
import MailboxTreeRail from "~/components/shell/MailboxTreeRail";
import ResizablePanel from "~/components/shell/ResizablePanel";

export default function AppShell() {
  return (
    // flex-1 fills remaining height below the global Header rendered in root.tsx.
    // overflow-hidden prevents double scrollbars; inner panes scroll independently.
    <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* Left rail — resizable + collapsible. The divider next to it owns
          the curved-sheet shadow now (matching the other shell dividers),
          so we keep data-shell-sidebar but rely on the shared divider CSS
          for the visual treatment. */}
      <ResizablePanel
        storageKey="ai.shell.mailboxRail"
        defaultWidth={240}
        minWidth={180}
        maxWidth={420}
        side="left"
        ariaLabel="Resize mailbox rail"
        className="hidden md:flex flex-col bg-card overflow-y-auto relative z-10"
      >
        <div data-shell-sidebar className="flex flex-col w-full h-full">
          <MailboxTreeRail />
        </div>
      </ResizablePanel>

      {/* Center — current route */}
      <main className="flex-1 min-w-0 overflow-hidden">
        <Outlet />
      </main>

      <ComposeEmail />
    </div>
  );
}
