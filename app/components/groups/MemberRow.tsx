// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { Badge, Button } from "~/ui";

interface Member {
  user_id: string;
  role_in_group: "admin" | "member";
  joined_at: number;
  email: string | null;
  display_name: string | null;
  status: string | null;
  is_owner: boolean;
}

interface MemberRowProps {
  member: Member;
  ownerUserId: string;
  actorUserId: string;
  actorIsOwner: boolean;
  actorIsAdmin: boolean;
  isGlobal: boolean;
  onRoleChange: (
    userId: string,
    newRole: "admin" | "member",
  ) => void | Promise<void>;
  onRemove: (userId: string) => void | Promise<void>;
  onTransferOwnership: () => void;
}

export default function MemberRow({
  member,
  ownerUserId,
  actorUserId,
  actorIsOwner,
  actorIsAdmin,
  isGlobal,
  onRoleChange,
  onRemove,
  onTransferOwnership,
}: MemberRowProps) {
  const isSelf = member.user_id === actorUserId;
  const isThisOwner = member.user_id === ownerUserId;

  // Role-management widget visibility (Permission Matrix Footnotes 5/9):
  //   - Only owner OR global can promote/demote any member.
  //   - Admins are peer-immutable (admin cannot demote another admin).
  //   - Self-demote always allowed (admin → member, member → leave).
  const canChangeRole =
    !isThisOwner && (actorIsOwner || isGlobal || (isSelf && actorIsAdmin));

  // Remove visibility: peer-immutable on admins; owner needs transfer-or-delete
  const canRemove =
    !isThisOwner &&
    (actorIsOwner ||
      isGlobal ||
      isSelf ||
      (actorIsAdmin && member.role_in_group === "member"));

  return (
    <div className="flex items-center gap-3 px-5 py-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-sm font-semibold text-text-bright uppercase">
        {(member.display_name ?? member.email ?? "?")[0]}
      </div>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 truncate text-sm font-medium text-text-bright">
          {member.display_name ?? member.email}
          {isSelf && (
            <span className="text-[10px] font-normal text-text-muted">
              (you)
            </span>
          )}
        </p>
        {member.display_name && (
          <p className="truncate text-xs text-text-muted">{member.email}</p>
        )}
      </div>

      <Badge
        variant={
          isThisOwner
            ? "primary"
            : member.role_in_group === "admin"
              ? "secondary"
              : "outline"
        }
      >
        {isThisOwner ? "owner" : member.role_in_group}
      </Badge>

      {/* Action surface */}
      <div className="flex shrink-0 items-center gap-2">
        {isThisOwner && isSelf && (actorIsOwner || isGlobal) && (
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={onTransferOwnership}
          >
            Transfer ownership…
          </Button>
        )}

        {canChangeRole && (
          <select
            aria-label={`Role for ${member.display_name ?? member.email}`}
            className="rounded-[8px] border border-border bg-card px-2 py-1 text-xs text-text-bright focus:border-kumo-brand focus:outline-none"
            value={member.role_in_group}
            onChange={(e) =>
              void onRoleChange(
                member.user_id,
                e.target.value as "admin" | "member",
              )
            }
          >
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
        )}

        {canRemove && (
          <Button
            variant={isSelf ? "ghost" : "secondary-destructive"}
            size="sm"
            type="button"
            onClick={() => void onRemove(member.user_id)}
          >
            {isSelf ? "Leave" : "Remove"}
          </Button>
        )}
      </div>
    </div>
  );
}
