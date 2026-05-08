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
import Header from "~/components/Header";
import MailboxTreeRail from "~/components/shell/MailboxTreeRail";
import ResizablePanel from "~/components/shell/ResizablePanel";
import { useAuthGuard } from "~/hooks/useAuthGuard";

export default function AppShell() {
  // Post-CF-Access cutover (2026-05-07, commit bc7297e): the SPA shell is
  // publicly served. Without this guard, an unauthenticated incognito tab
  // can load the empty shell and never get redirected to /login. The
  // server still 401s every data API — this is purely UX recovery.
  useAuthGuard();
  return (
    // The Header was previously mounted at the App root (root.tsx) for ALL
    // routes, which leaked the search bar, notification-bell polling,
    // mailbox-tree fetches, and the avatar fallback onto the pre-auth
    // /login screen. Header now lives INSIDE this authenticated shell;
    // /login, /consent, and /not-found render bare.
    <>
      <Header />
      {/* flex-1 fills remaining height below the Header.
          overflow-hidden prevents double scrollbars; inner panes scroll
          independently. Panels are FLUSH against the viewport edges per
          UAT round-3 batch-3 directive. */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left rail — resizable + collapsible. data-shell-sidebar paints
            a curved-paper drop shadow on the RIGHT edge (see app/index.css
            → [data-shell-sidebar][data-shadow-side="right"]). */}
        <ResizablePanel
          storageKey="ai.shell.mailboxRail"
          defaultWidth={240}
          minWidth={180}
          maxWidth={420}
          side="left"
          ariaLabel="Resize mailbox rail"
          className="hidden md:flex flex-col bg-card overflow-y-auto relative z-10"
        >
          <div
            data-shell-sidebar
            data-shadow-side="right"
            className="flex flex-col w-full h-full relative"
          >
            <MailboxTreeRail />
          </div>
        </ResizablePanel>

        {/* Center — current route */}
        <main className="flex-1 min-w-0 overflow-hidden">
          <Outlet />
        </main>

        <ComposeEmail />
      </div>
    </>
  );
}
