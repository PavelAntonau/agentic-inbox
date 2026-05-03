// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

import { Badge, Button } from "~/ui";
import type { AdminUser } from "~/routes/admin/users";

interface UserRowProps {
  user: AdminUser;
  actorRole: "global_owner" | "global_admin" | "user";
  actorUserId: string;
  onPromote: (user: AdminUser) => void;
  onDemote: (user: AdminUser) => void;
  onRemove: (user: AdminUser) => void;
}

function roleBadgeVariant(role: string) {
  if (role === "global_owner") return "primary" as const;
  if (role === "global_admin") return "success" as const;
  return "secondary" as const;
}

function roleLabel(role: string) {
  if (role === "global_owner") return "Owner";
  if (role === "global_admin") return "Admin";
  return "User";
}

export default function UserRow({
  user,
  actorRole,
  actorUserId,
  onPromote,
  onDemote,
  onRemove,
}: UserRowProps) {
  const isOwner = user.role === "global_owner";

  // Determine which actions to show per permission matrix (footnotes 2, 3, 5)
  const canPromote =
    !isOwner &&
    user.role === "user" &&
    (actorRole === "global_owner" || actorRole === "global_admin");

  const canDemote =
    !isOwner &&
    user.role === "global_admin" &&
    (actorRole === "global_owner" ||
      (actorRole === "global_admin" && user.id === actorUserId));

  const canRemove =
    !isOwner &&
    (actorRole === "global_owner" ||
      (actorRole === "global_admin" && user.role === "user"));

  const lastLogin = user.last_login_at
    ? new Date(user.last_login_at).toLocaleDateString()
    : "Never";

  return (
    <tr className="border-b border-border last:border-0 hover:bg-tx-card-hover transition-colors">
      <td className="px-4 py-3 text-sm text-text-bright">{user.email}</td>
      <td className="px-4 py-3 text-sm text-text-muted">
        {user.display_name ?? "—"}
      </td>
      <td className="px-4 py-3">
        <Badge variant={roleBadgeVariant(user.role)}>
          {roleLabel(user.role)}
        </Badge>
      </td>
      <td className="px-4 py-3">
        <Badge variant={user.status === "active" ? "outline" : "destructive"}>
          {user.status}
        </Badge>
      </td>
      <td className="px-4 py-3 text-sm text-text-muted">{lastLogin}</td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1">
          {canPromote && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onPromote(user)}
            >
              Promote
            </Button>
          )}
          {canDemote && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onDemote(user)}
            >
              Demote
            </Button>
          )}
          {canRemove && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => onRemove(user)}
            >
              Remove
            </Button>
          )}
          {isOwner && (
            <span className="text-xs text-text-muted italic">Read-only</span>
          )}
        </div>
      </td>
    </tr>
  );
}
