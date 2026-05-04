// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { ReactNode } from "react";
import ComposePanel from "~/components/ComposePanel";
import EmailPanel from "~/components/EmailPanel";
import ResizablePanel from "~/components/shell/ResizablePanel";
import ComposeIcon from "~/components/branding/ComposeIcon";

interface MailboxSplitViewProps {
  selectedEmailId: string | null;
  isComposing: boolean;
  children: ReactNode;
}

function NoSelectionPlaceholder() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 px-8 py-12 text-center">
      {/* ONE robot image — the artwork already shows two robots flanking a
          mailbox; duplicating the asset was the round-3 batch-2 mistake.
          Large (~360 px) decorative mark using the original transparent
          PNG (863×651) shipped in assets_new. */}
      <ComposeIcon size={360} className="max-w-[60vw] max-h-[40vh] h-auto" />
      <h2 className="text-xl font-semibold text-text-bright">
        Select an email or compose
      </h2>
      <p className="max-w-sm text-sm italic text-text-muted">
        Pick a conversation from the list, or start a new one — your trusted
        agent inbox awaits.
      </p>
    </div>
  );
}

export default function MailboxSplitView({
  selectedEmailId,
  isComposing,
  children,
}: MailboxSplitViewProps) {
  const isPanelOpen = selectedEmailId !== null || isComposing;

  // The third shell divider lives here, between the email list and the
  // email/compose pane. On mobile we collapse one side or the other so the
  // ResizablePanel only attaches on md+ when both panes are visible.
  const showSplit = isPanelOpen;

  return (
    <div className="flex h-full">
      {showSplit ? (
        <>
          {/* List — visible only on md+ when the right pane is active. */}
          <ResizablePanel
            storageKey="ai.shell.emailList"
            defaultWidth={380}
            minWidth={280}
            maxWidth={620}
            side="left"
            ariaLabel="Resize email list"
            className="hidden md:flex flex-col bg-card overflow-hidden"
          >
            {children}
          </ResizablePanel>
          {/* Detail / compose — flex-1 on the right of the divider. */}
          <div className="flex flex-1 flex-col min-w-0 overflow-hidden w-full md:w-auto">
            {isComposing && !selectedEmailId ? (
              <ComposePanel />
            ) : isComposing && selectedEmailId ? (
              <div className="flex flex-col h-full overflow-y-auto">
                <ComposePanel />
                <div className="border-t border-border">
                  <EmailPanel emailId={selectedEmailId} />
                </div>
              </div>
            ) : selectedEmailId ? (
              <EmailPanel emailId={selectedEmailId} />
            ) : (
              <NoSelectionPlaceholder />
            )}
          </div>
        </>
      ) : (
        // No selection yet: the list takes the full available width on
        // mobile and a fixed 380 px on desktop with the placeholder to its
        // right. We don't attach a divider here because there's nothing to
        // resize against.
        <>
          <div className="flex flex-col w-full md:w-[380px] shrink-0 min-w-0 md:border-r md:border-border">
            {children}
          </div>
          <div className="hidden md:flex flex-1 flex-col min-w-0 overflow-hidden">
            <NoSelectionPlaceholder />
          </div>
        </>
      )}
    </div>
  );
}
