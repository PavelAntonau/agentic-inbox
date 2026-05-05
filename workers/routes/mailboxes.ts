// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// workers/routes/mailboxes.ts — D1-backed mailbox CRUD + share/unshare/transfer endpoints.
//
// Mounts at /api/mailboxes (see app.ts).
// The legacy /api/v1/mailboxes Bucket-based handlers in index.ts are preserved unchanged.
//
// Endpoints added in Phase 4:
//   GET    /api/mailboxes/tree           — rail tree payload
//   POST   /api/mailboxes               — create personal mailbox (D1 row + ACL row)
//   POST   /api/mailboxes/:id/share     — owner adds mailbox to group
//   DELETE /api/mailboxes/:id/share/:groupId — owner/group-admin removes mailbox from group
//   POST   /api/mailboxes/:id/transfer  — owner transfers ownership
//   DELETE /api/mailboxes/:id           — owner deletes mailbox

import { Hono } from "hono";
import { eq, and, inArray, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import * as schema from "../db/control-plane/schema";
import { forGroup, type AuthzContext } from "../db/control-plane/forGroup";
import type { Env } from "../types";
import { appendAudit } from "../lib/audit-log";
import { buildMailboxTree } from "../lib/mailbox-tree";
import { listMailboxes } from "../lib/email-helpers";
import {
  canShare,
  canUnshare,
  canTransfer,
  canDelete,
  type MailboxRow,
  type GroupRow,
} from "../lib/mailbox-permissions";
import { getSettings } from "../lib/settings-cache";
import {
  PRIMARY_MAIL_DOMAIN,
  isValidLocalPart,
  composeAddress,
  addressIsPrimaryDomain,
} from "../../shared/mail-domain";
import {
  filterVisibleUsers,
  sortByRelevance,
  type UserRef,
  type GroupMemberRef,
} from "../lib/visibility-filter";

type AppVariables = {
  authzContext?: AuthzContext;
};

const router = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// -----------------------------------------------------------------------
// Auth guard — all mailbox routes require authenticated user
// -----------------------------------------------------------------------

router.use("*", async (c, next) => {
  const ctx = c.var.authzContext;
  if (!ctx) return c.json({ error: "Unauthorized" }, 401);
  return next();
});

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function isGlobal(role: AuthzContext["role"]): boolean {
  return role === "global_owner" || role === "global_admin";
}

/** Generate a random nanoid-style id. */
function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchMailbox(
  db: ReturnType<typeof drizzle>,
  mailboxId: string,
): Promise<MailboxRow | null> {
  const row = await db
    .select()
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.id, mailboxId))
    .get();
  return row ?? null;
}

async function fetchGroup(
  db: ReturnType<typeof drizzle>,
  groupId: string,
): Promise<GroupRow | null> {
  const row = await db
    .select()
    .from(schema.groups)
    .where(eq(schema.groups.id, groupId))
    .get();
  return row ?? null;
}

// -----------------------------------------------------------------------
// GET /api/mailboxes/tree — rail tree payload
// -----------------------------------------------------------------------

router.get("/tree", async (c) => {
  const ctx = c.var.authzContext!;
  const tree = await buildMailboxTree(c.env.DB, ctx);

  // Phase 3 — append R2-only legacy mailboxes (e.g. testbox@actionnow.ai)
  // that have no D1 row, so the sidebar shows the union and F-PROD-UI-1
  // is fully resolved (not just "stranded card removed" — the v1 mailbox
  // is rendered alongside D1 mailboxes).
  const knownIds = new Set<string>([
    ...tree.private.map((m) => m.id),
    ...tree.followed.map((m) => m.id),
    ...tree.groups.flatMap((g) => g.mailboxes.map((m) => m.id)),
  ]);
  const knownAddrs = new Set<string>([
    ...tree.private.map((m) => m.address.toLowerCase()),
    ...tree.followed.map((m) => m.address.toLowerCase()),
    ...tree.groups.flatMap((g) =>
      g.mailboxes.map((m) => m.address.toLowerCase()),
    ),
  ]);
  const all = await listMailboxes(c.env);
  for (const m of all) {
    if (m.kind !== "r2") continue;
    if (knownIds.has(m.id)) continue;
    if (knownAddrs.has(m.address.toLowerCase())) continue;
    tree.private.push({
      id: m.id,
      address: m.address,
      display_name: null,
      owner_user_id: ctx.user_id,
      created_at: 0,
    });
  }

  return c.json(tree);
});

// -----------------------------------------------------------------------
// GET /api/mailboxes/availability — pre-flight uniqueness check
// -----------------------------------------------------------------------
//
// Lightweight check the New-Mailbox dialog calls (debounced) while the
// user types the local-part. Returns whether `<local_part>@actionnow.ai`
// is currently free. Definitive race safety still lives in the POST
// handler below (UNIQUE-constraint catch); this endpoint just gives the
// UI an early signal.

router.get("/availability", async (c) => {
  const actor = c.var.authzContext!;
  const localPart = (c.req.query("local_part") ?? "").trim().toLowerCase();

  if (!localPart) {
    return c.json({ error: "Missing local_part" }, 400);
  }
  if (!isValidLocalPart(localPart)) {
    return c.json({
      address: composeAddress(localPart),
      available: false,
      reason: "invalid_local_part",
    });
  }

  const address = composeAddress(localPart);
  const { db } = forGroup(c.env.DB, actor);
  const existing = await db
    .select({ id: schema.mailboxes.id })
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.address, address))
    .get();

  return c.json({
    address,
    available: !existing,
    reason: existing ? "taken" : null,
  });
});

// -----------------------------------------------------------------------
// POST /api/mailboxes — create personal mailbox
// -----------------------------------------------------------------------
//
// Domain is HARDCODED to PRIMARY_MAIL_DOMAIN. Clients may submit either
// `local_part` (preferred) or a full `address` ending in @<domain> (legacy
// callers); both are normalised through composeAddress before insert.
//
// Race safety: the SELECT pre-check is a fast-path only; the authoritative
// uniqueness guarantee is the `mailboxes_address_nocase` UNIQUE INDEX in
// schema.ts. Two concurrent INSERTs of the same address result in one
// success and one UNIQUE-constraint violation, which we map to a 409.

const CreateMailboxSchema = z
  .object({
    local_part: z.string().min(1).max(64).optional(),
    address: z.string().email().optional(),
    display_name: z.string().min(1).max(120).optional(),
  })
  .refine((v) => v.local_part || v.address, {
    message: "Either local_part or address is required",
  });

router.post("/", async (c) => {
  const actor = c.var.authzContext!;
  const body = CreateMailboxSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!body.success) {
    return c.json(
      { error: "Invalid request body", details: body.error.flatten() },
      400,
    );
  }

  // Resolve local-part, regardless of which field the client sent.
  let localPart: string;
  if (body.data.local_part) {
    localPart = body.data.local_part.trim().toLowerCase();
  } else {
    const addr = body.data.address!.trim().toLowerCase();
    if (!addressIsPrimaryDomain(addr)) {
      return c.json(
        {
          error: `Mailbox addresses must end with @${PRIMARY_MAIL_DOMAIN}.`,
        },
        400,
      );
    }
    localPart = addr.slice(0, addr.lastIndexOf("@"));
  }

  if (!isValidLocalPart(localPart)) {
    return c.json(
      {
        error:
          "Invalid local-part. Use a-z, 0-9, dots, underscores, plus or hyphen; no leading/trailing or consecutive dots.",
      },
      400,
    );
  }

  const address = composeAddress(localPart);
  const { display_name } = body.data;
  const { db } = forGroup(c.env.DB, actor);
  const now = Date.now();

  // Fast-path uniqueness check — purely advisory; the UNIQUE INDEX is
  // the authoritative guard against the race condition.
  const existing = await db
    .select({ id: schema.mailboxes.id })
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.address, address))
    .get();
  if (existing) {
    return c.json({ error: "Address already in use" }, 409);
  }

  const mailboxId = newId();

  // Insert mailbox — wrapped to translate UNIQUE-constraint races into 409.
  try {
    await db
      .insert(schema.mailboxes)
      .values({
        id: mailboxId,
        address,
        display_name: display_name ?? null,
        owner_user_id: actor.user_id,
        created_at: now,
        created_by: actor.user_id,
      })
      .run();
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message.includes("UNIQUE constraint failed")
    ) {
      return c.json({ error: "Address already in use" }, 409);
    }
    throw err;
  }

  // Insert mailbox_acl owner row (Phase 4: one row per mailbox at creation)
  const ormRaw = drizzle(c.env.DB, { schema });
  await ormRaw
    .insert(schema.mailbox_acls)
    .values({
      mailbox_id: mailboxId,
      user_id: actor.user_id,
      level: "admin",
      granted_at: now,
      granted_by: actor.user_id,
    })
    .run();

  void appendAudit(
    c.env.DB,
    actor,
    "mailbox.create",
    { kind: "mailbox", id: mailboxId },
    {
      address,
    },
  );

  return c.json(
    {
      id: mailboxId,
      address,
      display_name: display_name ?? null,
    },
    201,
  );
});

// -----------------------------------------------------------------------
// POST /api/mailboxes/:id/share — add mailbox to group
// -----------------------------------------------------------------------

const ShareSchema = z.object({ group_id: z.string().min(1) });

router.post("/:id/share", async (c) => {
  const actor = c.var.authzContext!;
  const mailboxId = c.req.param("id")!;
  const body = ShareSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) {
    return c.json({ error: "group_id is required" }, 400);
  }
  const { group_id } = body.data;
  const { db } = forGroup(c.env.DB, actor);

  const [mailbox, group, aclRow] = await Promise.all([
    fetchMailbox(db, mailboxId),
    fetchGroup(db, group_id),
    // MP-1 — read the actor's mailbox_acls.level so canShare can recognise
    // an admin-ACL grantee as owner-equivalent.
    db
      .select({ level: schema.mailbox_acls.level })
      .from(schema.mailbox_acls)
      .where(
        and(
          eq(schema.mailbox_acls.mailbox_id, mailboxId),
          eq(schema.mailbox_acls.user_id, actor.user_id),
        ),
      )
      .get(),
  ]);
  if (!mailbox) return c.json({ error: "Mailbox not found" }, 404);
  if (!group) return c.json({ error: "Group not found" }, 404);

  const perm = canShare(actor, mailbox, group, aclRow?.level ?? null);
  if (!perm.ok) return c.json({ error: perm.reason }, 403);

  // E7: enforce max_groups_per_mailbox cap
  const settings = await getSettings(c.env.DB);
  const capSetting = settings.find((s) => s.key === "max_groups_per_mailbox");
  const cap = capSetting ? parseInt(capSetting.value, 10) : 10;

  const existingLinks = await db
    .select({ group_id: schema.mailbox_groups.group_id })
    .from(schema.mailbox_groups)
    .where(eq(schema.mailbox_groups.mailbox_id, mailboxId))
    .all();

  if (existingLinks.length >= cap) {
    return c.json(
      {
        error: `This mailbox is already in ${cap} groups (cap: E7). Remove it from a group first.`,
      },
      422,
    );
  }

  // Check if already in this group
  const alreadyLinked = existingLinks.some((l) => l.group_id === group_id);
  if (alreadyLinked) {
    return c.json({ error: "Mailbox is already in this group" }, 409);
  }

  await db
    .insert(schema.mailbox_groups)
    .values({
      mailbox_id: mailboxId,
      group_id,
      added_at: Date.now(),
      added_by: actor.user_id,
    })
    .run();

  void appendAudit(
    c.env.DB,
    actor,
    "mailbox.share",
    { kind: "mailbox", id: mailboxId },
    {
      group_id,
    },
  );

  return c.json({ ok: true });
});

// -----------------------------------------------------------------------
// DELETE /api/mailboxes/:id/share/:groupId — remove mailbox from group
// -----------------------------------------------------------------------

router.delete("/:id/share/:groupId", async (c) => {
  const actor = c.var.authzContext!;
  const mailboxId = c.req.param("id")!;
  const groupId = c.req.param("groupId")!;
  const { db } = forGroup(c.env.DB, actor);

  const [mailbox, group, memberRow, aclRow] = await Promise.all([
    fetchMailbox(db, mailboxId),
    fetchGroup(db, groupId),
    // Determine actor's role in the group
    db
      .select({ role_in_group: schema.group_members.role_in_group })
      .from(schema.group_members)
      .where(
        and(
          eq(schema.group_members.group_id, groupId),
          eq(schema.group_members.user_id, actor.user_id),
        ),
      )
      .get(),
    // MP-1 — actor's mailbox_acls.level for the unshare-side admin
    // recognition.
    db
      .select({ level: schema.mailbox_acls.level })
      .from(schema.mailbox_acls)
      .where(
        and(
          eq(schema.mailbox_acls.mailbox_id, mailboxId),
          eq(schema.mailbox_acls.user_id, actor.user_id),
        ),
      )
      .get(),
  ]);
  if (!mailbox) return c.json({ error: "Mailbox not found" }, 404);
  if (!group) return c.json({ error: "Group not found" }, 404);

  const actorRoleInGroup = memberRow?.role_in_group ?? null;

  const perm = canUnshare(
    actor,
    mailbox,
    group,
    actorRoleInGroup,
    aclRow?.level ?? null,
  );
  if (!perm.ok) return c.json({ error: perm.reason }, 403);

  const result = await db
    .delete(schema.mailbox_groups)
    .where(
      and(
        eq(schema.mailbox_groups.mailbox_id, mailboxId),
        eq(schema.mailbox_groups.group_id, groupId),
      ),
    )
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Mailbox is not in that group" }, 404);
  }

  void appendAudit(
    c.env.DB,
    actor,
    "mailbox.unshare",
    { kind: "mailbox", id: mailboxId },
    {
      group_id: groupId,
    },
  );

  return c.json({ ok: true });
});

// -----------------------------------------------------------------------
// POST /api/mailboxes/:id/transfer — transfer ownership
// -----------------------------------------------------------------------

const TransferSchema = z.object({ new_owner_user_id: z.string().min(1) });

router.post("/:id/transfer", async (c) => {
  const actor = c.var.authzContext!;
  const mailboxId = c.req.param("id")!;
  const body = TransferSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) {
    return c.json({ error: "new_owner_user_id is required" }, 400);
  }
  const { new_owner_user_id } = body.data;
  const { db } = forGroup(c.env.DB, actor);

  const mailbox = await fetchMailbox(db, mailboxId);
  if (!mailbox) return c.json({ error: "Mailbox not found" }, 404);

  const perm = canTransfer(actor, mailbox);
  if (!perm.ok) return c.json({ error: perm.reason }, 403);

  // Resolve receiver
  const receiver = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, new_owner_user_id))
    .get();
  if (!receiver || receiver.status !== "active") {
    return c.json({ error: "Receiver user not found or inactive" }, 404);
  }

  // For non-global actors: receiver must have visibility != 'nobody'
  if (!isGlobal(actor.role) && receiver.visibility === "nobody") {
    return c.json({ error: "Receiver user has restricted visibility" }, 403);
  }

  const now = Date.now();
  await db
    .update(schema.mailboxes)
    .set({ owner_user_id: new_owner_user_id })
    .where(eq(schema.mailboxes.id, mailboxId))
    .run();

  // Update ACL: revoke old owner's admin row; upsert new owner's admin row
  const ormRaw = drizzle(c.env.DB, { schema });
  await ormRaw
    .delete(schema.mailbox_acls)
    .where(
      and(
        eq(schema.mailbox_acls.mailbox_id, mailboxId),
        eq(schema.mailbox_acls.user_id, mailbox.owner_user_id),
        eq(schema.mailbox_acls.level, "admin"),
      ),
    )
    .run();

  await ormRaw
    .insert(schema.mailbox_acls)
    .values({
      mailbox_id: mailboxId,
      user_id: new_owner_user_id,
      level: "admin",
      granted_at: now,
      granted_by: actor.user_id,
    })
    .onConflictDoUpdate({
      target: [schema.mailbox_acls.mailbox_id, schema.mailbox_acls.user_id],
      set: { level: "admin", granted_at: now, granted_by: actor.user_id },
    })
    .run();

  void appendAudit(
    c.env.DB,
    actor,
    "mailbox.transfer",
    { kind: "mailbox", id: mailboxId },
    {
      from_user_id: mailbox.owner_user_id,
      to_user_id: new_owner_user_id,
    },
  );

  return c.json({ ok: true });
});

// -----------------------------------------------------------------------
// DELETE /api/mailboxes/:id — delete mailbox
// -----------------------------------------------------------------------

router.delete("/:id", async (c) => {
  const actor = c.var.authzContext!;
  const mailboxId = c.req.param("id")!;
  const { db } = forGroup(c.env.DB, actor);

  const mailbox = await fetchMailbox(db, mailboxId);
  if (!mailbox) return c.json({ error: "Mailbox not found" }, 404);

  const perm = canDelete(actor, mailbox);
  if (!perm.ok) return c.json({ error: perm.reason }, 403);

  // Cascade: schema has onDelete: "cascade" for mailbox_groups and mailbox_acls
  await db
    .delete(schema.mailboxes)
    .where(eq(schema.mailboxes.id, mailboxId))
    .run();

  void appendAudit(
    c.env.DB,
    actor,
    "mailbox.delete",
    { kind: "mailbox", id: mailboxId },
    {
      address: mailbox.address,
    },
  );

  return c.body(null, 204);
});

// -----------------------------------------------------------------------
// Shared autocomplete helper — builds visibility-filtered user list
// -----------------------------------------------------------------------

async function getVisibilityFilteredUsers(
  db: ReturnType<typeof drizzle>,
  ctx: AuthzContext,
  q: string,
): Promise<UserRef[]> {
  const allUsers = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      display_name: schema.users.display_name,
      visibility: schema.users.visibility,
      status: schema.users.status,
    })
    .from(schema.users)
    .where(eq(schema.users.status, "active"))
    .all();

  const groupMembers: GroupMemberRef[] = await db
    .select({
      user_id: schema.group_members.user_id,
      group_id: schema.group_members.group_id,
    })
    .from(schema.group_members)
    .all();

  const contactRows = await db
    .select({ contact_user_id: schema.contacts.contact_user_id })
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.owner_user_id, ctx.user_id),
        eq(schema.contacts.status, "accepted"),
      ),
    )
    .all();
  const acceptedContactIds = new Set(contactRows.map((r) => r.contact_user_id));

  const blockedRows = await db
    .select({
      owner_user_id: schema.contacts.owner_user_id,
      contact_user_id: schema.contacts.contact_user_id,
    })
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.status, "blocked"),
        or(
          eq(schema.contacts.owner_user_id, ctx.user_id),
          eq(schema.contacts.contact_user_id, ctx.user_id),
        ),
      ),
    )
    .all();
  const blockedUserIds = new Set<string>();
  for (const row of blockedRows) {
    if (row.owner_user_id === ctx.user_id)
      blockedUserIds.add(row.contact_user_id);
    else blockedUserIds.add(row.owner_user_id);
  }

  const userRefs: UserRef[] = allUsers.map((u) => ({
    id: u.id,
    email: u.email,
    display_name: u.display_name,
    visibility: u.visibility as UserRef["visibility"],
    status: u.status as UserRef["status"],
  }));

  const actorGroupSet = new Set(ctx.group_ids);
  const coMemberIds = new Set<string>(
    groupMembers
      .filter(
        (gm) => actorGroupSet.has(gm.group_id) && gm.user_id !== ctx.user_id,
      )
      .map((gm) => gm.user_id),
  );

  const filtered = filterVisibleUsers({
    actor: { user_id: ctx.user_id, group_ids: ctx.group_ids },
    users: userRefs,
    groupMembers,
    acceptedContactIds,
    blockedUserIds,
    enforceContactsAndNobody: true,
  });

  const matched = q
    ? filtered.filter(
        (u) =>
          u.email.toLowerCase().includes(q) ||
          (u.display_name ?? "").toLowerCase().includes(q),
      )
    : filtered;

  return sortByRelevance(matched, q, coMemberIds).slice(0, 20);
}

// -----------------------------------------------------------------------
// GET /api/mailboxes/share/autocomplete?q= — visibility-filtered user search
// Used by AddToGroupDialog / share flow to suggest eligible recipients.
// -----------------------------------------------------------------------

router.get("/share/autocomplete", async (c) => {
  const ctx = c.var.authzContext!;
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const { db } = forGroup(c.env.DB, ctx);
  const users = await getVisibilityFilteredUsers(db, ctx, q);
  return c.json({ users });
});

// -----------------------------------------------------------------------
// GET /api/mailboxes/transfer/autocomplete?q= — visibility-filtered user search
// Used by TransferMailboxOwnershipDialog to suggest eligible recipients.
// -----------------------------------------------------------------------

router.get("/transfer/autocomplete", async (c) => {
  const ctx = c.var.authzContext!;
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const { db } = forGroup(c.env.DB, ctx);
  const users = await getVisibilityFilteredUsers(db, ctx, q);
  return c.json({ users });
});

export default router;
