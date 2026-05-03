// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { Button } from "~/ui";
import { UsersThreeIcon } from "@phosphor-icons/react";

export interface UnseenInvitation {
  id: string;
  group_id: string;
  group_name: string;
  group_description: string | null;
  inviter_user_id: string;
  inviter_display_name: string | null;
  inviter_email: string | null;
  invited_at: number;
}

interface InvitationCardProps {
  invitation: UnseenInvitation;
  busy?: boolean;
  onAccept: (id: string) => void | Promise<void>;
  onDecline: (id: string) => void | Promise<void>;
}

export default function InvitationCard({
  invitation,
  busy,
  onAccept,
  onDecline,
}: InvitationCardProps) {
  const inviterLabel =
    invitation.inviter_display_name ?? invitation.inviter_email ?? "Someone";

  return (
    <div className="flex flex-col gap-2 rounded-[12px] bg-card border border-border px-3 py-3">
      <div className="flex items-start gap-2">
        <UsersThreeIcon
          size={18}
          className="mt-0.5 shrink-0 text-text-muted"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-text-bright">
            {invitation.group_name}
          </p>
          {invitation.group_description && (
            <p className="line-clamp-2 text-xs text-text-muted">
              {invitation.group_description}
            </p>
          )}
          <p className="mt-1 text-[11px] text-text-muted">
            Invited by {inviterLabel}
          </p>
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          type="button"
          disabled={busy}
          onClick={() => void onDecline(invitation.id)}
        >
          Decline
        </Button>
        <Button
          variant="primary"
          size="sm"
          type="button"
          disabled={busy}
          onClick={() => void onAccept(invitation.id)}
        >
          Accept
        </Button>
      </div>
    </div>
  );
}
