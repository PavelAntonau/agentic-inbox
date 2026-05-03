// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { ReactNode } from "react";
import ComposePanel from "~/components/ComposePanel";
import EmailPanel from "~/components/EmailPanel";
import heroUrl from "~/assets/branding/anai-mail-login-hero.png?url";

interface MailboxSplitViewProps {
  selectedEmailId: string | null;
  isComposing: boolean;
  children: ReactNode;
}

function NoSelectionPlaceholder() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 py-12 text-center">
      <img
        src={heroUrl}
        alt=""
        className="h-56 w-auto opacity-90"
        draggable={false}
      />
      <h2 className="text-xl font-semibold text-text-bright">
        Select an email or compose
      </h2>
      <p className="max-w-sm text-sm text-text-muted">
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

  return (
    <div className="flex h-full">
      {/* Left pane: list. On desktop always 380px so the right pane can host
          either the active email/compose surface or the no-selection robot. */}
      <div
        className={`flex-col min-w-0 shrink-0 ${
          isPanelOpen
            ? "hidden md:flex md:w-[380px] md:border-r md:border-border"
            : "flex w-full md:w-[380px] md:border-r md:border-border"
        }`}
      >
        {children}
      </div>
      {/* Right pane: detail / compose / placeholder. Hidden on mobile when
          nothing is active, so the list takes the full mobile viewport. */}
      <div
        className={`flex-col min-w-0 overflow-hidden ${
          isPanelOpen
            ? "flex flex-1 w-full md:w-auto"
            : "hidden md:flex md:flex-1"
        }`}
      >
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
    </div>
  );
}
