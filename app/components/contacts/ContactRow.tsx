// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// ContactRow — a single contact row with status badge and action buttons.

import { Badge, Button } from "~/ui";
import { useToastManager } from "~/ui/toast";
import { useState } from "react";
import BlockUserDialog from "./BlockUserDialog";

export interface Contact {
  owner_user_id: string;
  contact_user_id: string;
  status: "pending" | "accepted" | "blocked";
  initiated_by: string;
  created_at: number;
  accepted_at: number | null;
  email: string | null;
  display_name: string | null;
}

interface ContactRowProps {
  contact: Contact;
  /** The current actor's user_id */
  actorUserId: string;
  onMutated: () => void;
}

const STATUS_VARIANTS: Record<
  Contact["status"],
  "primary" | "secondary" | "destructive"
> = {
  accepted: "primary",
  pending: "secondary",
  blocked: "destructive",
};

export default function ContactRow({
  contact,
  actorUserId,
  onMutated,
}: ContactRowProps) {
  const toastManager = useToastManager();
  const [blockOpen, setBlockOpen] = useState(false);
  const [acting, setActing] = useState(false);

  // The row is from actor's perspective:
  // owner_user_id = actor → this shows contacts actor added or blocked
  // contact_user_id = actor, initiated_by != actor → pending request FROM someone else
  const isIncoming =
    contact.contact_user_id === actorUserId &&
    contact.initiated_by !== actorUserId;
  const isOutgoing =
    contact.owner_user_id === actorUserId &&
    contact.initiated_by === actorUserId &&
    contact.status === "pending";

  const displayName =
    contact.display_name || contact.email || contact.contact_user_id;

  async function handleAccept() {
    setActing(true);
    try {
      const res = await fetch(`/api/contacts/${contact.owner_user_id}/accept`, {
        method: "POST",
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        toastManager.add({
          title: d.error ?? "Failed to accept",
          variant: "error",
        });
        return;
      }
      toastManager.add({ title: "Contact request accepted" });
      onMutated();
    } catch {
      toastManager.add({ title: "Network error", variant: "error" });
    } finally {
      setActing(false);
    }
  }

  async function handleDecline() {
    setActing(true);
    try {
      const res = await fetch(
        `/api/contacts/${contact.owner_user_id}/decline`,
        { method: "POST" },
      );
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        toastManager.add({
          title: d.error ?? "Failed to decline",
          variant: "error",
        });
        return;
      }
      toastManager.add({ title: "Contact request declined" });
      onMutated();
    } catch {
      toastManager.add({ title: "Network error", variant: "error" });
    } finally {
      setActing(false);
    }
  }

  return (
    <>
      <div className="flex items-center justify-between py-3 border-b border-border last:border-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="size-8 rounded-full bg-kumo-fill flex items-center justify-center shrink-0">
            <span className="text-sm font-medium text-text-muted">
              {(displayName[0] ?? "?").toUpperCase()}
            </span>
          </div>
          <div className="min-w-0">
            <p className="text-sm text-text-bright truncate">{displayName}</p>
            {contact.display_name && contact.email && (
              <p className="text-xs text-text-muted">{contact.email}</p>
            )}
            {isIncoming && contact.status === "pending" && (
              <p className="text-xs text-text-muted">Sent you a request</p>
            )}
            {isOutgoing && (
              <p className="text-xs text-text-muted">Request sent</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0 ml-3">
          <Badge variant={STATUS_VARIANTS[contact.status]}>
            {contact.status}
          </Badge>

          {/* Incoming pending: accept / decline */}
          {isIncoming && contact.status === "pending" && (
            <>
              <Button
                variant="primary"
                size="xs"
                loading={acting}
                onClick={() => void handleAccept()}
              >
                Accept
              </Button>
              <Button
                variant="ghost"
                size="xs"
                loading={acting}
                onClick={() => void handleDecline()}
              >
                Decline
              </Button>
            </>
          )}

          {/* Accepted: block option */}
          {contact.status === "accepted" && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setBlockOpen(true)}
            >
              Block
            </Button>
          )}
        </div>
      </div>

      <BlockUserDialog
        open={blockOpen}
        onOpenChange={setBlockOpen}
        targetUserId={contact.contact_user_id}
        targetDisplayName={displayName}
        onBlocked={() => {
          setBlockOpen(false);
          onMutated();
        }}
      />
    </>
  );
}
