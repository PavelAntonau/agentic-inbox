// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { Button } from "~/ui";
import { Empty } from "~/ui/empty";
import { PlusIcon, UsersThreeIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { useOutletContext } from "react-router";
import CreateGroupDialog from "~/components/groups/CreateGroupDialog";
import type { GroupSummary } from "./_layout";

interface OutletContext {
  groups: GroupSummary[];
  refetchGroups: () => Promise<void>;
}

export function meta() {
  return [{ title: "Groups | ActionNowAI Mail" }];
}

export default function GroupsIndex() {
  const { groups, refetchGroups } = useOutletContext<OutletContext>();
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 md:px-6 md:py-12">
      {/* Page header */}
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-bright">Groups</h1>
          <p className="mt-1 text-sm text-text-muted">
            Organise mailboxes and team members into groups.
          </p>
        </div>
        <Button
          variant="primary"
          icon={<PlusIcon size={16} />}
          onClick={() => setCreateOpen(true)}
        >
          New group
        </Button>
      </div>

      {groups.length === 0 ? (
        <Empty
          icon={<UsersThreeIcon size={40} className="text-text-muted" />}
          title="No groups yet"
          description="Create a group to share mailboxes and collaborate with your team."
          contents={
            <Button
              variant="primary"
              icon={<PlusIcon size={16} />}
              onClick={() => setCreateOpen(true)}
            >
              Create your first group
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {groups.map((g) => (
            <a
              key={g.id}
              href={`/groups/${g.id}`}
              className="flex flex-col gap-1.5 rounded-[17px] bg-card border border-border px-5 py-4 transition-colors hover:border-kumo-brand/40 hover:bg-tx-card-hover"
            >
              <div className="flex items-center gap-2">
                <UsersThreeIcon
                  size={18}
                  className="shrink-0 text-text-muted"
                />
                <span className="font-semibold text-text-bright truncate">
                  {g.name}
                </span>
                {g.actor_role_in_group === "owner" && (
                  <span className="ml-auto shrink-0 rounded-full bg-kumo-fill px-2 py-0.5 text-[11px] font-medium text-text-muted">
                    owner
                  </span>
                )}
              </div>
              {g.description && (
                <p className="text-sm text-text-muted line-clamp-2">
                  {g.description}
                </p>
              )}
              <p className="text-xs text-text-muted">
                {g.member_count} member{g.member_count !== 1 ? "s" : ""}
              </p>
            </a>
          ))}

          {/* Create card */}
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="flex items-center gap-3 rounded-[17px] border border-dashed border-border bg-transparent px-5 py-4 text-left text-sm text-text-muted transition-colors hover:border-kumo-brand/50 hover:text-text-bright"
          >
            <PlusIcon size={18} className="shrink-0" />
            <span>Create new group…</span>
          </button>
        </div>
      )}

      <CreateGroupDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={async () => {
          await refetchGroups();
          setCreateOpen(false);
        }}
      />
    </div>
  );
}
