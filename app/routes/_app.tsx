// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// _app.tsx — Outlook-style three-pane shell.
//
// Layout:   [MailboxTreeRail (left)] | [main content (center)] | [PreviewPane (right, conditional)]
//
// All authenticated routes except /admin/** render inside this shell.
// The rail fetches /api/mailboxes/tree on the client and caches per
// React Query's staleTime.  The center pane is always the current <Outlet>.
// The right pane renders when an email is selected (useUIStore.selectedEmailId).

import { Outlet } from "react-router";
import ComposeEmail from "~/components/ComposeEmail";
import MailboxTreeRail from "~/components/shell/MailboxTreeRail";
import PreviewPane from "~/components/shell/PreviewPane";
import { useUIStore } from "~/hooks/useUIStore";

export default function AppShell() {
  const { selectedEmailId } = useUIStore();

  return (
    // flex-1 fills remaining height below the global Header rendered in root.tsx.
    // overflow-hidden prevents double scrollbars; inner panes scroll independently.
    <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* Left rail — always visible on desktop. data-shell-sidebar marks
          the surface so the dedicated multi-layer shadow rule in
          app/index.css can target it (Phase 3f). */}
      <div
        data-shell-sidebar
        className="hidden md:flex w-[240px] shrink-0 border-r border-border flex-col bg-card overflow-y-auto relative z-10"
      >
        <MailboxTreeRail />
      </div>

      {/* Center — current route */}
      <main className="flex-1 min-w-0 overflow-hidden">
        <Outlet />
      </main>

      {/* Right — preview pane when an email is selected */}
      {selectedEmailId && (
        <div className="hidden lg:flex w-[380px] shrink-0 border-l border-border flex-col bg-card overflow-hidden">
          <PreviewPane emailId={selectedEmailId} />
        </div>
      )}

      <ComposeEmail />
    </div>
  );
}
