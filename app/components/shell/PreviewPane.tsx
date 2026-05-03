// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// PreviewPane — right pane of the Outlook three-pane shell.
// Renders when useUIStore.selectedEmailId is non-null.
// Delegates to EmailPanel for the actual email display — avoids
// duplicating read/reply/forward logic.

import { XIcon } from "@phosphor-icons/react";
import { Button } from "~/ui";
import { useParams } from "react-router";
import { useUIStore } from "~/hooks/useUIStore";
import EmailPanel from "~/components/EmailPanel";

interface PreviewPaneProps {
  emailId: string;
}

export default function PreviewPane({ emailId }: PreviewPaneProps) {
  const { mailboxId } = useParams<{ mailboxId: string }>();
  const { closePanel } = useUIStore();

  // PreviewPane only makes sense inside a mailbox route where mailboxId is set.
  // When the user navigates to a top-level route (home, groups) the shell
  // hides the pane via the conditional in _app.tsx.
  if (!mailboxId) return null;

  return (
    <div className="flex flex-col h-full">
      {/* Minimal pane header — just a close affordance */}
      <div className="flex items-center justify-end px-3 py-2 border-b border-border shrink-0">
        <Button
          variant="ghost"
          shape="square"
          size="sm"
          icon={<XIcon size={16} />}
          onClick={closePanel}
          aria-label="Close preview"
        />
      </div>

      {/* Delegate to the full EmailPanel — it owns read/reply/forward/delete */}
      <div className="flex-1 overflow-hidden">
        <EmailPanel emailId={emailId} />
      </div>
    </div>
  );
}
