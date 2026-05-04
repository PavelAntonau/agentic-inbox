// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// MailboxNode — a single mailbox row in the left rail.
// Click → navigate /mailbox/:id.
// Right-click → context menu (Share / Unshare / Transfer / Delete) based on
// permission predicates evaluated client-side from the node's ownership.

import { Badge } from "~/ui";
import { ShareNetworkIcon, UserIcon } from "@phosphor-icons/react";
import mailboxPrivateUrl from "~/assets/branding/mailbox-private.png?url";
import mailboxSharedUrl from "~/assets/branding/mailbox-shared.png?url";
import { NavLink, useNavigate } from "react-router";
import { useState, useRef } from "react";
import type { MailboxNode as MailboxNodeData } from "~/routes/_app/api.tree";
import AddToGroupDialog from "~/components/mailbox/AddToGroupDialog";
import RemoveFromGroupDialog from "~/components/mailbox/RemoveFromGroupDialog";
import TransferMailboxOwnershipDialog from "~/components/mailbox/TransferMailboxOwnershipDialog";
import DeleteMailboxDialog from "~/components/mailbox/DeleteMailboxDialog";

interface MailboxNodeProps {
  mailbox: MailboxNodeData;
  /** true when this mailbox belongs to a group (as opposed to private) */
  inGroup?: boolean;
  /** group id when rendered inside a group section */
  groupId?: string;
  actorUserId: string;
  actorRole: "global_owner" | "global_admin" | "user";
  onMutated: () => void;
}

type ContextMenu =
  | "add-to-group"
  | "remove-from-group"
  | "transfer"
  | "delete"
  | null;

export default function MailboxNode({
  mailbox,
  inGroup = false,
  groupId,
  actorUserId,
  actorRole,
  onMutated,
}: MailboxNodeProps) {
  const navigate = useNavigate();
  const [menu, setMenu] = useState<ContextMenu>(null);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const [menuOpen, setMenuOpen] = useState(false);
  const nodeRef = useRef<HTMLDivElement>(null);

  const isOwner = mailbox.owner_user_id === actorUserId;
  const isGlobal = actorRole === "global_owner" || actorRole === "global_admin";
  const canShare = isOwner || isGlobal;
  const canUnshare = (isOwner || isGlobal) && inGroup;
  const canTransfer = isOwner || isGlobal;
  const canDelete = isOwner || isGlobal;

  const displayName =
    mailbox.display_name || mailbox.address.split("@")[0] || mailbox.address;

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setMenuPos({ x: e.clientX, y: e.clientY });
    setMenuOpen(true);
  };

  const closeMenu = () => setMenuOpen(false);

  return (
    <>
      <div ref={nodeRef} onContextMenu={handleContextMenu} className="relative">
        <NavLink
          to={`/mailbox/${mailbox.id}`}
          className={({ isActive }) =>
            `flex items-center gap-2.5 py-2 px-3 rounded-[10px] text-sm transition-colors cursor-pointer ${
              isActive
                ? "bg-tx-card-bg font-semibold text-text-bright"
                : "text-text hover:bg-tx-card-hover"
            }`
          }
        >
          <img
            src={inGroup ? mailboxSharedUrl : mailboxPrivateUrl}
            alt=""
            width={18}
            height={18}
            className="shrink-0 block h-[18px] w-[18px] object-contain select-none"
            draggable={false}
          />
          <span className="truncate flex-1">{displayName}</span>
          {isOwner ? (
            <Badge
              variant="secondary"
              /* UAT round-3: the secondary kumo-fill resolves to a near-white
                 in dark theme that screams against the navy rail. Override
                 with theme-aware classes — soft slate on light, muted
                 translucent navy on dark. */
              className="text-[10px] px-1 py-0 shrink-0 bg-slate-200 text-slate-700 dark:bg-white/10 dark:text-blue-100/85 dark:border dark:border-white/10"
            >
              owner
            </Badge>
          ) : (
            <ShareNetworkIcon
              size={12}
              className="shrink-0 text-text-muted"
              aria-label="Shared mailbox"
            />
          )}
        </NavLink>
      </div>

      {/* Context menu */}
      {menuOpen && (
        <>
          {/* Click-away backdrop */}
          <div
            className="fixed inset-0 z-40"
            onClick={closeMenu}
            onKeyDown={(e) => e.key === "Escape" && closeMenu()}
            role="button"
            tabIndex={-1}
            aria-label="Close menu"
          />
          <div
            className="fixed z-50 bg-card border border-border rounded-[12px] shadow-lg py-1 min-w-[160px]"
            style={{ left: menuPos.x, top: menuPos.y }}
          >
            {canShare && (
              <button
                type="button"
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text hover:bg-tx-card-hover transition-colors"
                onClick={() => {
                  closeMenu();
                  setMenu("add-to-group");
                }}
              >
                <ShareNetworkIcon size={14} />
                Share with group
              </button>
            )}
            {canUnshare && groupId && (
              <button
                type="button"
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text hover:bg-tx-card-hover transition-colors"
                onClick={() => {
                  closeMenu();
                  setMenu("remove-from-group");
                }}
              >
                <ShareNetworkIcon size={14} className="opacity-50" />
                Remove from group
              </button>
            )}
            {canTransfer && (
              <button
                type="button"
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text hover:bg-tx-card-hover transition-colors"
                onClick={() => {
                  closeMenu();
                  setMenu("transfer");
                }}
              >
                <UserIcon size={14} />
                Transfer ownership
              </button>
            )}
            {canDelete && (
              <>
                <div className="border-t border-border my-1" />
                <button
                  type="button"
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-kumo-danger hover:bg-tx-card-hover transition-colors"
                  onClick={() => {
                    closeMenu();
                    setMenu("delete");
                  }}
                >
                  Delete mailbox
                </button>
              </>
            )}
          </div>
        </>
      )}

      {/* Dialogs */}
      {menu === "add-to-group" && (
        <AddToGroupDialog
          mailbox={mailbox}
          open
          onOpenChange={(o) => !o && setMenu(null)}
          onSuccess={() => {
            setMenu(null);
            onMutated();
          }}
        />
      )}
      {menu === "remove-from-group" && groupId && (
        <RemoveFromGroupDialog
          mailbox={mailbox}
          groupId={groupId}
          open
          onOpenChange={(o) => !o && setMenu(null)}
          onSuccess={() => {
            setMenu(null);
            onMutated();
          }}
        />
      )}
      {menu === "transfer" && (
        <TransferMailboxOwnershipDialog
          mailbox={mailbox}
          open
          onOpenChange={(o) => !o && setMenu(null)}
          onSuccess={() => {
            setMenu(null);
            onMutated();
          }}
        />
      )}
      {menu === "delete" && (
        <DeleteMailboxDialog
          mailbox={mailbox}
          open
          onOpenChange={(o) => !o && setMenu(null)}
          onSuccess={() => {
            setMenu(null);
            onMutated();
          }}
        />
      )}
    </>
  );
}
