// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// GroupSection — collapsible per-group section in the left rail.
// Contains one MailboxNode per mailbox in the group.

import { UsersThreeIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useState } from "react";
import type {
  GroupNode,
  MailboxNode as MailboxNodeData,
} from "~/routes/_app/api.tree";
import MailboxNode from "~/components/shell/MailboxNode";

interface GroupSectionProps {
  group: GroupNode;
  mailboxes: MailboxNodeData[];
  actorUserId: string;
  actorRole: "global_owner" | "global_admin" | "user";
  onMutated: () => void;
}

export default function GroupSection({
  group,
  mailboxes,
  actorUserId,
  actorRole,
  onMutated,
}: GroupSectionProps) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="mb-1">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-text-muted hover:text-text-bright transition-colors"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={`group-mailboxes-${group.id}`}
      >
        <CaretRightIcon
          size={12}
          className={`shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
          aria-hidden
        />
        <UsersThreeIcon size={14} className="shrink-0" aria-hidden />
        <span className="truncate flex-1 text-left">{group.name}</span>
        <span className="shrink-0 font-normal normal-case tracking-normal">
          {mailboxes.length}
        </span>
      </button>

      {expanded && (
        <ul id={`group-mailboxes-${group.id}`} className="pl-2 space-y-0.5">
          {mailboxes.length === 0 ? (
            <li className="px-3 py-1.5 text-xs text-text-muted italic">
              No mailboxes
            </li>
          ) : (
            mailboxes.map((mb) => (
              <li key={mb.id}>
                <MailboxNode
                  mailbox={mb}
                  inGroup
                  groupId={group.id}
                  actorUserId={actorUserId}
                  actorRole={actorRole}
                  onMutated={onMutated}
                />
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
