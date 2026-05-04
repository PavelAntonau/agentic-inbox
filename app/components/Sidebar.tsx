// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Sidebar — compose-actions rail only (Phase 4 repurpose, OQ-V2U-2 default).
//
// Navigation was subsumed by MailboxTreeRail in Phase 4.
// This component is kept (not deleted) to preserve compose-action affordances
// accessible from mobile (hamburger toggle) and any surface that still
// needs a "Compose" entry point in a slot-based layout.
//
// Retained: Compose button + folder links for the current mailbox.
// Removed: "back to mailboxes" navigation (rail owns that).

import { Badge, Button, Dialog, Input, Tooltip } from "~/ui";
import {
  ArchiveIcon,
  FileIcon,
  FolderIcon,
  PaperPlaneTiltIcon,
  PlusIcon,
  TrashIcon,
  TrayIcon,
} from "@phosphor-icons/react";
import ComposeIcon from "~/components/branding/ComposeIcon";
import { useMemo, useState } from "react";
import { NavLink, useParams } from "react-router";
import { Folders, SYSTEM_FOLDER_IDS } from "shared/folders";
import { useCreateFolder, useFolders } from "~/queries/folders";
import { useUIStore } from "~/hooks/useUIStore";

const FOLDER_ICONS: Record<string, React.ReactNode> = {
  [Folders.INBOX]: <TrayIcon size={18} weight="regular" />,
  [Folders.SENT]: <PaperPlaneTiltIcon size={18} weight="regular" />,
  [Folders.DRAFT]: <FileIcon size={18} weight="regular" />,
  [Folders.ARCHIVE]: <ArchiveIcon size={18} weight="regular" />,
  [Folders.TRASH]: <TrashIcon size={18} weight="regular" />,
};

const SYSTEM_FOLDER_LINKS = [
  { id: Folders.INBOX, label: "Inbox" },
  { id: Folders.SENT, label: "Sent" },
  { id: Folders.DRAFT, label: "Drafts" },
  { id: Folders.ARCHIVE, label: "Archive" },
  { id: Folders.TRASH, label: "Trash" },
];

interface FolderLinkProps {
  to: string;
  icon: React.ReactNode;
  label: string;
  unreadCount?: number;
  onClick?: () => void;
}

function FolderLink({
  to,
  icon,
  label,
  unreadCount,
  onClick,
}: FolderLinkProps) {
  return (
    <NavLink
      to={to}
      onClick={onClick}
      className={({ isActive }) =>
        `flex items-center gap-3 py-2 px-3 rounded-md text-sm transition-colors ${
          isActive
            ? "bg-tx-card-bg font-semibold text-text-bright"
            : "text-text hover:bg-tx-card-hover"
        }`
      }
    >
      <span className="shrink-0">{icon}</span>
      <span className="truncate flex-1">{label}</span>
      {unreadCount != null && unreadCount > 0 && (
        <Badge variant="secondary">{unreadCount}</Badge>
      )}
    </NavLink>
  );
}

export default function Sidebar() {
  const { mailboxId } = useParams<{ mailboxId: string }>();
  const { data: folders = [] } = useFolders(mailboxId);
  const createFolderMutation = useCreateFolder();
  const { startCompose, closeSidebar } = useUIStore();
  const [isCreateFolderOpen, setIsCreateFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");

  const customFolders = useMemo(
    () =>
      folders.filter(
        (f) => !(SYSTEM_FOLDER_IDS as readonly string[]).includes(f.id),
      ),
    [folders],
  );

  const getUnreadCount = (folderId: string) => {
    const found = folders.find((f) => f.id === folderId);
    return found?.unreadCount || 0;
  };

  const handleCreateFolder = (e: React.FormEvent) => {
    e.preventDefault();
    if (newFolderName.trim() && mailboxId) {
      createFolderMutation.mutate({ mailboxId, name: newFolderName.trim() });
      setNewFolderName("");
      setIsCreateFolderOpen(false);
    }
  };

  const handleNavClick = () => {
    closeSidebar();
  };

  return (
    <aside className="h-full w-64 bg-card flex flex-col shrink-0 border-r border-border">
      {/* Compose — primary action */}
      <div className="px-3 py-3 pt-4">
        <Button
          variant="primary"
          icon={<ComposeIcon size={20} />}
          onClick={() => startCompose()}
          className="w-full"
        >
          Compose
        </Button>
      </div>

      {/* Folder navigation for current mailbox */}
      <nav className="flex-1 overflow-y-auto px-2 space-y-0.5">
        {SYSTEM_FOLDER_LINKS.map((folder) => (
          <FolderLink
            key={folder.id}
            to={`/mailbox/${mailboxId}/emails/${folder.id}`}
            icon={FOLDER_ICONS[folder.id]}
            label={folder.label}
            unreadCount={getUnreadCount(folder.id)}
            onClick={handleNavClick}
          />
        ))}

        {/* Custom folders */}
        <div className="pt-5">
          <div className="flex items-center justify-between px-3 mb-1.5">
            <span className="text-xs uppercase tracking-wider font-semibold text-text-muted">
              Folders
            </span>
            <Tooltip content="New folder" asChild>
              <Button
                variant="ghost"
                shape="square"
                size="sm"
                icon={<PlusIcon size={16} />}
                onClick={() => setIsCreateFolderOpen(true)}
                aria-label="Create new folder"
              />
            </Tooltip>
          </div>
          {customFolders.map((folder) => (
            <FolderLink
              key={folder.id}
              to={`/mailbox/${mailboxId}/emails/${folder.id}`}
              icon={<FolderIcon size={18} />}
              label={folder.name}
              unreadCount={folder.unreadCount}
              onClick={handleNavClick}
            />
          ))}
        </div>
      </nav>

      {/* Create folder dialog */}
      <Dialog.Root
        open={isCreateFolderOpen}
        onOpenChange={setIsCreateFolderOpen}
      >
        <Dialog size="sm" className="p-6">
          <Dialog.Title className="text-base font-semibold mb-4">
            Create folder
          </Dialog.Title>
          <form onSubmit={handleCreateFolder} className="space-y-4">
            <Input
              label="Folder name"
              placeholder="e.g. Projects"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              required
            />
            <div className="flex justify-end gap-2">
              <Dialog.Close
                render={(props) => (
                  <Button {...props} variant="secondary">
                    Cancel
                  </Button>
                )}
              />
              <Button
                type="submit"
                variant="primary"
                disabled={!newFolderName.trim()}
              >
                Create
              </Button>
            </div>
          </form>
        </Dialog>
      </Dialog.Root>
    </aside>
  );
}
