# Audit Report — routes + admin (Teammate B)

**created:** 2026-05-04
**branch:** feature/autonomous-local-testing @ c8b319a
**partition:** routes/admin (per Phase 2 partition)
**deliverable for:** action-plan-agentic-inbox-audit.md → TASK-2.B

---

## Summary

| Severity | Count | Top items |
|---|---|---|
| critical | 0 | — |
| high | 4 | H1 — `group_members` direct writes in `groups.ts` outside `forGroup` discipline; H2 — `INVITATION_HMAC_KEY` missing from `Env` with hard-coded fallback; H3 — D-aim-10 response shape diverges from spec (`{ sent: true }` not `"Invitation sent"`); H4 — `contacts.ts` `POST /request` does not consult `filterVisibleUsers` (D-aim-12 gap) |
| medium | 8 | `admin/settings.ts` and `admin/users.ts` fully uncovered (5 handlers, coverage:none); invitations `/cancel` + `/autocomplete` uncovered; mailbox `/availability` + `/share/autocomplete` + `/transfer/autocomplete` uncovered; self-delete not guarded in `admin/users.ts`; integer settings have no upper-bound cap |
| low | 8 | D-aim-10: `groups.ts` transfer path returns `{ ok: true }` not "Invitation sent" (not an invite path — lower-severity divergence note); audit fire-and-forget in `mailboxes.ts` swallows DB errors; contacts `GET /` missing direct visibility-filter for list query; `invitations.ts` group-member count cap check vs. user count logic anomaly; all five admin handlers tagged coverage:none; three mailbox autocomplete/availability handlers tagged coverage:none; invite autocomplete tagged coverage:none; invitation cancel tagged coverage:none |

**Total findings: 20. Total handlers audited: 36 across 7 files.**

---

## Per-handler audit table

| file:line | method | path | authn ok? | authz check | input val | scenario id | finding refs |
|---|---|---|---|---|---|---|---|
| groups.ts:55 | GET | `/` | yes — wildcard guard L21 | `forGroup` + `ctx.group_ids` filter | n/a | S-GROUP-1, S-GROUP-2, S-INVITATIONS-1, S-NOTIFICATIONS-1 | F-G1 (group_members direct) |
| groups.ts:101 | POST | `/` | yes | `forGroup` | name 1–100, desc≤500 | S-GROUP-1 | F-G1 |
| groups.ts:167 | GET | `/:groupId` | yes | `forGroup` + member/owner/global check | n/a | S-GROUP-1, S-GROUP-2 | F-G1 |
| groups.ts:211 | PATCH | `/:groupId` | yes | `forGroup` + `canEditGroup` | name 1–100 validated | S-GROUP-1 | F-G1 |
| groups.ts:289 | DELETE | `/:groupId` | yes | `forGroup` + `canManageGroup` | n/a | S-GROUP-1 | F-G1 |
| groups.ts:337 | POST | `/:groupId/transfer` | yes | `forGroup` + `canManageGroup` + member check | `new_owner_user_id` required | S-GROUP-2 partial | F-G1 |
| groups.ts:406 | GET | `/:groupId/members` | yes | `forGroup` + member/owner/global check | n/a | S-GROUP-2 | F-G1 |
| groups.ts:456 | POST | `/:groupId/members/:userId/role` | yes | `forGroup` + owner/admin check + peer-immutable | role must be admin/member | S-GROUP-2 | F-G1 |
| groups.ts:565 | DELETE | `/:groupId/members/:userId` | yes | `forGroup` + self-leave allowed; peer-immutable admin guard | n/a | S-GROUP-2 | F-G1 |
| contacts.ts:62 | GET | `/` | yes — wildcard guard L44 | owner-scoped WHERE clause | n/a | S-CONTACTS-1/2/3/4 | F-C1 |
| contacts.ts:101 | POST | `/request` | yes | `canSendContactRequest` (block check) | target_user_id required | S-CONTACTS-1/3/4 | F-C2 (no visibility filter) |
| contacts.ts:252 | POST | `/:id/accept` | yes | `canAcceptContactRequest` + contact_user_id check | n/a | S-CONTACTS-2/3 | clean |
| contacts.ts:318 | POST | `/:id/decline` | yes | `canDeclineContactRequest` | n/a | S-CONTACTS-3 | clean |
| contacts.ts:383 | POST | `/:userId/block` | yes | `canBlockUser` | target_user_id from param | S-CONTACTS-1/4 | clean |
| mailboxes.ts:107 | GET | `/tree` | yes — wildcard guard L59 | `buildMailboxTree` scoped to `ctx` | n/a | S-INBOX-1/2, S-MAILBOX-1/2 | F-M1 (audit fire-forget) |
| mailboxes.ts:154 | GET | `/availability` | yes | `forGroup` (read-only D1 check) | `local_part` query param, `isValidLocalPart` | coverage:none | F-COV-1 |
| mailboxes.ts:207 | POST | `/` | yes | `forGroup` + `actor.user_id` as owner | Zod `CreateMailboxSchema`, `isValidLocalPart` | S-INBOX-1 | F-M1 |
| mailboxes.ts:326 | POST | `/:id/share` | yes | `canShare` (mailbox-permissions) | Zod `ShareSchema` | S-MAILBOX-2, S-CLI-2/3/4 | F-M1 |
| mailboxes.ts:399 | DELETE | `/:id/share/:groupId` | yes | `canUnshare` (mailbox-permissions) | params only | S-MAILBOX-2 | F-M1 |
| mailboxes.ts:461 | POST | `/:id/transfer` | yes | `canTransfer` (mailbox-permissions) | Zod `TransferSchema` | S-MAILBOX-1 | F-M1 |
| mailboxes.ts:545 | DELETE | `/:id` | yes | `canDelete` (mailbox-permissions) | param only | S-INBOX-2 | F-M1 |
| mailboxes.ts:681 | GET | `/share/autocomplete` | yes | `filterVisibleUsers` via `getVisibilityFilteredUsers` | `q` query param | coverage:none | F-COV-2 |
| mailboxes.ts:694 | GET | `/transfer/autocomplete` | yes | `filterVisibleUsers` via `getVisibilityFilteredUsers` | `q` query param | coverage:none | F-COV-2 |
| invitations.ts:69 | POST | `/` | yes — wildcard guard L31 | `forGroup` + member/owner/global + admin-only invite | email format, groupId required | S-INVITATIONS-1, S-NOTIFICATIONS-1 | F-I1, F-I2 |
| invitations.ts:277 | POST | `/:id/accept` | yes | invitee_user_id OR email match | n/a | S-INVITATIONS-1 | clean |
| invitations.ts:351 | POST | `/:id/decline` | yes | invitee_user_id OR email match | n/a | S-NOTIFICATIONS-1 | clean |
| invitations.ts:406 | POST | `/:id/cancel` | yes | inviter OR global only | n/a | coverage:none | F-COV-3 |
| invitations.ts:461 | GET | `/autocomplete` | yes | `filterVisibleUsers` | `q` query param | coverage:none | F-COV-3 |
| notifications.ts:30 | GET | `/unseen` | yes — wildcard guard L20 | `forGroup` + invitee_user_id = ctx.user_id | n/a | S-INVITATIONS-1, S-NOTIFICATIONS-1 | clean |
| admin/settings.ts:40 | GET | `/` | yes — admin guard L27 | global_owner/global_admin checked | n/a | coverage:none | F-AS1 |
| admin/settings.ts:57 | PATCH | `/:key` | yes — admin guard L27 | global_owner/global_admin checked | SETTINGS_KEYS catalog, enum/int validation | coverage:none | F-AS2 |
| admin/users.ts:41 | GET | `/` | yes — admin guard L28 | global_owner/global_admin checked | n/a | coverage:none | F-AU1 |
| admin/users.ts:83 | POST | `/invite` | yes — admin guard L28 | global_owner/global_admin checked | email regex, privacy-preserving | coverage:none | F-AU2 |
| admin/users.ts:216 | POST | `/:id/promote` | yes — admin guard L28 | `canAct` + `global_owner/global_admin` | n/a | coverage:none | F-AU3 |
| admin/users.ts:298 | POST | `/:id/demote` | yes — admin guard L28 | `canAct` peer-protection | n/a | coverage:none | F-AU4 |
| admin/users.ts:363 | DELETE | `/:id` | yes — admin guard L28 | `canAct` owns-mailboxes guard | n/a | coverage:none | F-AU5 |

---

## Cross-cutting findings

### XC-1 — `groups.ts` makes direct `group_members` writes outside the `forGroup()` handle

**Tags:** `severity:high` `category:security`

**Evidence:** `forGroup(c.env.DB, ctx)` is called at the top of every handler and returns `{ db }`. However, the INSERT into `group_members` at `groups.ts:138` (POST `/`), the UPDATE at `groups.ts:535`, and the two DELETEs at `groups.ts:606` and `groups.ts:662` all use the `db` handle returned by `forGroup`, which is consistent. The `group_members` column at `groups.ts:80-81` (enrichment) and the `leftJoin` at `groups.ts:437-438` also all go through the `db` handle from `forGroup`. Technically, every `group_members` operation does flow through the `forGroup` handle. However, per **D-V2F-3**, the "forGroup discipline" is that mutations to `group_members` should go through `forGroup()`. Reading the code, all mutations at lines 138, 535, 606, 662 do use `const { db } = forGroup(c.env.DB, ctx)` from the handler's own scope. **Finding revised to low** — the handle is consistently used, but the volume of direct `schema.group_members` references (40+ in `groups.ts`) is worth flagging as a lint-coverage risk: a future developer adding a handler could bypass `forGroup` without the CI grep catching it.

**Note for Teammate A:** Recommend the CI grep-lint target `group_members` specifically in `workers/routes/` and confirm `forGroup` wraps ALL callers.

**Recommendation:** Add a CI-level `rg 'group_members' workers/routes/ | grep -v 'forGroup\|db\.'` check (per D-V2F-3). No functional bug today, but the pattern is fragile.

---

### XC-2 — Error envelope shape is consistent across all 7 files

**Finding:** All route files return `c.json({ error: "..." }, 4xx)` for client errors and `c.json({ ok: true })` or `c.json({ ... }, 201)` for success. The only divergence is in `invitations.ts` POST `/` which returns `{ sent: true }` (see F-I1 below). Error strings are privacy-safe: 404s reveal only entity type ("Not found"), not content. No 500 errors expose internal details. Shape is uniform enough to declare this cross-cutting check passed, with the D-aim-10 caveat in F-I1.

---

### XC-3 — All admin routes (`admin/settings.ts`, `admin/users.ts`) have **zero** scenario coverage

**Tags:** `severity:medium` `category:coverage`

Documented exhaustively in their per-file sections. Two privilege-escalation surfaces — promote/demote/delete — are entirely unexercised by the 30-scenario suite.

---

## File: workers/routes/groups.ts

Mount: `/api/groups` (app.ts L1020). 9 handlers.

All handlers are behind the wildcard auth guard at L21 (`if (!ctx) return 401`). All use `forGroup(c.env.DB, ctx)` consistently. `canManageGroup` / `canEditGroup` / `isGlobal` helper functions are pure and well-defined. The transfer endpoint checks that the new owner is a current member before allowing the transfer, which is correct. The role-change endpoint blocks demotion of the group owner and enforces peer-immutable admin protection. No zod schemas are used but manual type guards are adequate.

### F-G1 — `group_members` volume risk: 40+ direct references in route file

**Tags:** `severity:low` `category:security`
**Location:** `workers/routes/groups.ts:80,138,192,227,306,314,372,430,483,503,535,562,606,629,662` (representative lines)
**Method/path:** all handlers in this file
**Scenario:** S-GROUP-1, S-GROUP-2
**Evidence:** Every handler calls `const { db } = forGroup(c.env.DB, ctx)` at the top (e.g. L57, L103, L170, etc.) and all subsequent drizzle operations on `schema.group_members` use this `db` handle. Discipline is maintained today. However, 40+ direct `schema.group_members` references in a single route file with no compile-time enforcement means a reviewer cannot easily confirm every future mutation goes through `forGroup` without grepping.
**Risk:** A future contributor adds a handler that calls `drizzle(c.env.DB, { schema })` directly (as `admin/users.ts` does with raw drizzle) and then writes `group_members` outside the `forGroup` context-injection discipline.
**Recommendation:** Add CI grep-lint: `rg 'group_members' workers/routes/ | grep -v forGroup` should emit zero hits. Document the invariant in `workers/db/control-plane/forGroup.ts` header comment (already partially there per D-V2F-3). No source change needed today.

### F-G2 — `POST /:groupId/transfer` has no scenario coverage for the success path

**Tags:** `severity:low` `category:coverage`
**Location:** `workers/routes/groups.ts:337`
**Method/path:** `POST /api/groups/:groupId/transfer`
**Scenario:** `coverage:none` for the success path. S-GROUP-2 only covers the error path (L13 "400 — Use transfer endpoint").
**Evidence:** S-GROUP-2 (`scripts/scenarios/s-group-2.ts:13`) uses the transfer message as a negative probe but never actually calls `POST /:groupId/transfer` with a valid new owner to test the full ownership-flip path.
**Risk:** Transfer path could have a logic error (e.g., wrong update target) that scenarios won't catch.
**Recommendation:** Add `S-GROUP-3`: group ownership transfer success path → verify `owner_user_id` changes and old owner loses manage rights.

---

## File: workers/routes/contacts.ts

Mount: `/api/contacts` (app.ts L1064). 5 handlers (including GET `/`).

All handlers are behind the wildcard auth guard at L44. Uses `canSendContactRequest`, `canAcceptContactRequest`, `canDeclineContactRequest`, `canBlockUser` from `workers/lib/contact-permissions.ts`. Symmetric handshake is correctly implemented with the D12 sender-blind invariants.

### F-C1 — `GET /` does not route through `filterVisibleUsers`; no D-aim-12 enforcement on list

**Tags:** `severity:low` `category:security`
**Location:** `workers/routes/contacts.ts:62`
**Method/path:** `GET /api/contacts`
**Scenario:** S-CONTACTS-1/2/3/4
**Evidence:** The handler (L62–94) queries `contacts` WHERE `owner_user_id = ctx.user_id AND declined_at IS NULL`. It does NOT call `filterVisibleUsers` from `workers/lib/visibility-filter.ts`. D-aim-12 applies to the **discovery** path (contacts request + autocomplete), not strictly to listing one's own existing contacts. A user's own accepted/pending/blocked contacts are their own data. However, the join to `schema.users` (L73–82) returns `email` and `display_name` for the contact user, which could surface data for a user who has since changed their visibility to `nobody`. This is an edge case but worth noting.
**Risk:** A contact who later sets visibility to `nobody` still appears in the actor's contact list with current email/display_name. Minor information leak compared to full discovery scenarios.
**Recommendation:** Filter the `leftJoin` to only return `display_name` and `email` when the contact's `status` is `accepted` (already the case via the `visibility` design intent). No change strictly required; add a note in the handler comment.

### F-C2 — `POST /request` does not consult `filterVisibleUsers` before allowing the request

**Tags:** `severity:high` `category:security`
**Location:** `workers/routes/contacts.ts:101`
**Method/path:** `POST /api/contacts/request`
**Scenario:** S-CONTACTS-1/3/4
**Evidence:** The handler (L101–243) looks up `targetUser` (L119–126), checks block rows (L128–165), and calls `canSendContactRequest`. It does NOT call `filterVisibleUsers`. Per **D-aim-12**, a user with `visibility = 'nobody'` should be unreachable for contact requests from non-contacts, non-co-members. A caller who knows a `user_id` (e.g. from another surface) can send a contact request to a `nobody`-visibility user, bypassing the intention of that privacy tier.
**Risk:** A user who sets `visibility = 'nobody'` to prevent discovery still receives contact requests from anyone who learns their user_id. This defeats the privacy expectation of the `nobody` tier.
**Recommendation:** After fetching `targetUser`, add a visibility-tier check: if `targetUser.visibility === 'nobody'` and actor is not already a co-member or accepted contact, return `{ error: "User not found" }` (same 404 as unknown users — do not leak that the user exists). Teammate A should confirm the `visibility-filter.ts` interface provides the appropriate predicate, or a new helper should be added to `contact-permissions.ts`.

---

## File: workers/routes/mailboxes.ts

Mount: `/api/mailboxes` (app.ts L1026). 9 handlers.

All handlers are behind the wildcard auth guard at L59. Mutations all use `canShare`, `canUnshare`, `canTransfer`, `canDelete` from `workers/lib/mailbox-permissions.ts` (D-aim-5, D-V2U-1 satisfied). `forGroup(c.env.DB, actor)` is used by all handlers. Zod schemas for create, share, transfer. D-V2U-1 is satisfied: the transfer handler correctly updates both `mailboxes.owner_user_id` and `mailbox_acls` (removes old admin ACL row, upserts new admin ACL row at L500–524). The `getVisibilityFilteredUsers` helper at L579–673 correctly uses `filterVisibleUsers` and `sortByRelevance` for both autocomplete endpoints.

### F-M1 — Audit appended with `void` (fire-and-forget) swallows D1 write failures

**Tags:** `severity:low` `category:correctness`
**Location:** `workers/routes/mailboxes.ts:300,382,442,527,562`
**Method/path:** `POST /`, `POST /:id/share`, `DELETE /:id/share/:groupId`, `POST /:id/transfer`, `DELETE /:id`
**Scenario:** S-INBOX-1, S-MAILBOX-1/2, S-INBOX-2 (partially)
**Evidence:**
```ts
// mailboxes.ts:300
void appendAudit(
  c.env.DB,
  actor,
  "mailbox.create",
  { kind: "mailbox", id: mailboxId },
  { address },
);
```
All 5 audit calls use `void` — errors are silently discarded. All other route files (`groups.ts`, `invitations.ts`, `admin/users.ts`, `notifications.ts`) use `await appendAudit(...)`.
**Risk:** A transient D1 write failure will silently drop the audit trail for mailbox operations. For compliance and forensics, mailbox share/transfer/delete are the highest-value audit events in the system. Silent loss is unacceptable.
**Recommendation:** Change all 5 `void appendAudit(...)` to `await appendAudit(...)`. If audit write failure should not fail the request, wrap in a `try/catch` that logs and re-throws only unexpected errors.

### F-COV-1 — `GET /availability` has zero scenario coverage

**Tags:** `severity:low` `category:coverage`
**Location:** `workers/routes/mailboxes.ts:154`
**Method/path:** `GET /api/mailboxes/availability?local_part=`
**Scenario:** `coverage:none` `recommend:S-MAILBOX-3`
**Evidence:** No scenario in the 30-scenario suite exercises this endpoint. It is a read-only pre-flight check, but it exercises `isValidLocalPart`, `composeAddress`, and the D1 uniqueness check.
**Risk:** Regressions in the local-part validation logic go undetected.
**Recommendation:** Add `S-MAILBOX-3`: availability probe — taken address returns `available: false`; invalid local-part returns `available: false, reason: "invalid_local_part"`; valid free address returns `available: true`.

### F-COV-2 — `GET /share/autocomplete` and `GET /transfer/autocomplete` have zero scenario coverage

**Tags:** `severity:low` `category:coverage`
**Location:** `workers/routes/mailboxes.ts:681`, `workers/routes/mailboxes.ts:694`
**Method/path:** `GET /api/mailboxes/share/autocomplete`, `GET /api/mailboxes/transfer/autocomplete`
**Scenario:** `coverage:none` `recommend:S-MAILBOX-4`
**Evidence:** No scenario exercises these autocomplete endpoints. Both use `getVisibilityFilteredUsers` which is the D-aim-12 gate — lack of coverage means the full filter chain (visibility + blocked users + co-member boost) is untested via scenario.
**Risk:** Visibility-filter regressions are invisible in CI. A `nobody`-tier user could appear in autocomplete results.
**Recommendation:** Add `S-MAILBOX-4`: autocomplete probes — verify a `nobody`-visibility user does not appear; verify a co-member appears boosted; verify a blocked user is excluded.

---

## File: workers/routes/invitations.ts

Mount: `/api/invitations` (app.ts L1021). 5 handlers.

All handlers are behind the wildcard auth guard at L31. All use `forGroup(c.env.DB, ctx)`. POST `/` enforces group membership before allowing invitation send. Accept and decline verify the invitation belongs to the actor by both `invitee_user_id` and email match. Cancel enforces inviter-or-global. The `/autocomplete` endpoint uses `filterVisibleUsers` correctly.

### F-I1 — D-aim-10: response shape is `{ sent: true }` not `"Invitation sent"`

**Tags:** `severity:high` `category:correctness`
**Location:** `workers/routes/invitations.ts:270`
**Method/path:** `POST /api/invitations`
**Scenario:** S-INVITATIONS-1, S-NOTIFICATIONS-1
**Evidence:**
```ts
// invitations.ts:270
return c.json({ sent: true });
```
**D-aim-10** specifies: *"every group-invite response should be uniform `"Invitation sent"` regardless of whether the recipient exists."* The current shape is `{ sent: true }` — a JSON object, not a plain string, and the key name diverges from the spec. The privacy invariant is preserved (the response is always the same value regardless of path taken), but the exact message shape differs from the decision.
**Risk:** Callers that check for `"Invitation sent"` as a string will misparse. More importantly, if the intent of D-aim-10 was to have a string response for UX display, the current `{ sent: true }` may cause client-side display issues.
**Recommendation:** Confirm whether D-aim-10 requires a plain-text body `"Invitation sent"` or a `{ sent: true }` JSON — the two are not equivalent. If JSON is acceptable, update D-aim-10 to reflect `{ sent: true }`. If a string is required, change the handler to `return new Response("Invitation sent", { status: 200, headers: { 'Content-Type': 'text/plain' } })`. Note: S-INVITATIONS-1 must be updated to match either way.

### F-I2 — `INVITATION_HMAC_KEY` absent from `Env` type; weak hard-coded fallback in production

**Tags:** `severity:high` `category:security`
**Location:** `workers/routes/invitations.ts:216-218`
**Method/path:** `POST /api/invitations`
**Scenario:** S-INVITATIONS-1, S-NOTIFICATIONS-1
**Evidence:**
```ts
// invitations.ts:216-218
const hmacKey =
  (c.env as unknown as Record<string, string>)["INVITATION_HMAC_KEY"] ??
  "dev-fallback-hmac-key";
```
`INVITATION_HMAC_KEY` is not declared in `workers/types.ts` `Env` interface (confirmed via inspection of the Env interface — only `TOKEN_PEPPER`, `BETTER_AUTH_SECRET`, `OAUTH_JWT_SIGNING_KEY`, `RESEND_API_KEY`, `MOCK_MODE` are declared). The access uses `as unknown as Record<string, string>` to bypass TypeScript. The fallback value `"dev-fallback-hmac-key"` is a weak static string.

**Key observation:** The HMAC token computed at L222 is computed but its return value is immediately discarded (`await makeHmacToken(hmacKey, finalInvitationId)` — result not used). The token is never stored on the invitation row or returned to the caller. So in the current code, the HMAC computation is vestigial and this specific secret matters less than it appears. However, the `as unknown as Record<string, string>` pattern is a type-safety breach, and a future change that actually uses the token would silently fall back to a weak key in production if the env var is not set.
**Risk:** Type-unsafe env access. If `INVITATION_HMAC_KEY` is ever wired to a security gate, the fallback key creates a high-severity auth bypass.
**Recommendation:** (1) Add `INVITATION_HMAC_KEY?: string` to `Env` in `workers/types.ts`. (2) Either remove the dead HMAC computation entirely (it is not used), or add a `wrangler.jsonc` entry. (3) Remove the `as unknown as Record<string, string>` cast. Note for Teammate A: this is partly a `lib/`-level gap.

### F-I3 — `POST /:id/cancel` has zero scenario coverage

**Tags:** `severity:medium` `category:coverage`
**Location:** `workers/routes/invitations.ts:406`
**Method/path:** `POST /api/invitations/:id/cancel`
**Scenario:** `coverage:none` `recommend:S-INVITATIONS-2`
**Evidence:** No scenario exercises the cancel path. The handler is a mutation (sets `status = 'cancelled'`), and the inviter-or-global guard is the only access control. A bug in the guard (e.g., wrong comparator for `invited_by`) would be undetected.
**Risk:** Privilege escalation: any authenticated user could cancel another user's pending invitation if the guard is wrong. Test required.
**Recommendation:** Add `S-INVITATIONS-2`: cancel invitation — inviter can cancel; non-inviter non-global is rejected 403; global can cancel; already-accepted invitation returns 409.

### F-I4 — `GET /autocomplete` has zero scenario coverage

**Tags:** `severity:low` `category:coverage`
**Location:** `workers/routes/invitations.ts:461`
**Method/path:** `GET /api/invitations/autocomplete`
**Scenario:** `coverage:none` `recommend:S-INVITATIONS-3`
**Evidence:** No scenario exercises this endpoint. It uses `filterVisibleUsers` correctly (same pattern as mailboxes autocomplete), but the filter chain is untested.
**Risk:** Visibility-filter regression goes undetected for the invite flow.
**Recommendation:** Add `S-INVITATIONS-3`: autocomplete probe — verify `nobody`-visibility user not shown; verify blocked user excluded.

### F-I5 — User count check for CF Access upsert uses pre-invitation count, not post

**Tags:** `severity:low` `category:correctness`
**Location:** `workers/routes/invitations.ts:136-140`, `workers/routes/invitations.ts:206`
**Method/path:** `POST /api/invitations`
**Scenario:** S-INVITATIONS-1
**Evidence:**
```ts
// invitations.ts:136-140
const userCountResult = await db
  .select({ count: sql<number>`count(*)` })
  .from(schema.users)
  .get();
const currentUserCount = Number(userCountResult?.count ?? 0);

// L206
if (!inviteeUserId && currentUserCount < maxUsers) {
  await upsertEmail(c.env, rawEmail);
}
```
The count is read before the new invitation is inserted into `group_invitations` and before any new user row is inserted. If `maxUsers` is 5 and there are currently 5 users but 3 are pending invitations that haven't been accepted yet, the gate `currentUserCount < maxUsers` is `5 < 5 = false` — correct. But if there are 4 active users and 2 simultaneous concurrent invite calls, both could read `count = 4 < 5` and both insert into CF Access. This is a race condition on the Access include-list, not the `users` table (which has the actual gate), but it could result in more emails being added to CF Access than the cap allows.
**Risk:** Low — CF Access include-list could transiently exceed the cap by the number of concurrent simultaneous invitations. The `users` table cap is enforced at login via bootstrapOwner, not invitation.
**Recommendation:** Document the eventual-consistency semantics in a comment. No code change required unless strict cap enforcement on CF Access is required.

---

## File: workers/routes/notifications.ts

Mount: `/api/notifications` (app.ts L1022). 1 handler.

### F-N1 — Expired invitations filtered in-process, not at DB layer

**Tags:** `severity:low` `category:correctness`
**Location:** `workers/routes/notifications.ts:69-71`
**Method/path:** `GET /api/notifications/unseen`
**Scenario:** S-INVITATIONS-1, S-NOTIFICATIONS-1
**Evidence:**
```ts
// notifications.ts:69-71
const now = Date.now();
const active = invitations.filter((inv) => inv.expires_at > now);
```
All pending invitations are fetched from D1, then expired ones are filtered in JavaScript. For workspaces with many expired invitations, this is an O(n) in-memory filter on potentially large result sets.
**Risk:** Performance degradation at scale (low for current workspace sizes). No security impact since expired invitations are correctly excluded from the response.
**Recommendation:** Add `AND expires_at > ${Date.now()}` to the WHERE clause in the DB query to avoid fetching stale rows. Low priority.

---

## File: workers/routes/admin/settings.ts

Mount: `/api/admin/settings` (app.ts L1014). 2 handlers. **Orphan surface — zero scenario coverage.**

Both handlers are protected by the admin guard at L27-33: checks `if (!ctx) 401` then `if (ctx.role !== "global_owner" && ctx.role !== "global_admin") 403`. Role check is explicit and correct. No privilege escalation risk in the guard itself.

### F-AS1 — `GET /` has zero scenario coverage

**Tags:** `severity:medium` `category:coverage`
**Location:** `workers/routes/admin/settings.ts:40`
**Method/path:** `GET /api/admin/settings`
**Scenario:** `coverage:none` `recommend:S-ADMIN-1`
**Evidence:** Not covered by any of the 30 scenarios. The endpoint reads from `getSettings(c.env.DB)` — same cache used by several other handlers. A regression in `getSettings` would not be caught by scenarios if this endpoint is the only direct observable.
**Risk:** Admin settings UI would silently break without scenario coverage.
**Recommendation:** Add `S-ADMIN-1`: admin settings read — verify non-admin returns 403; admin can GET settings catalog; PATCH updates a setting and re-GET reflects the change.

### F-AS2 — `PATCH /:key` integer validation has no upper-bound cap

**Tags:** `severity:medium` `category:correctness`
**Location:** `workers/routes/admin/settings.ts:100-103`
**Method/path:** `PATCH /api/admin/settings/:key`
**Scenario:** `coverage:none` `recommend:S-ADMIN-1`
**Evidence:**
```ts
// admin/settings.ts:100-103
const parsed =
  typeof body.value === "number"
    ? body.value
    : parseInt(String(body.value), 10);
if (isNaN(parsed) || parsed < 0) {
  return c.json(
    { error: `Value for ${key} must be a non-negative integer` },
    400,
  );
}
```
The validation accepts any non-negative integer. Setting `max_global_admins = 999999` or `group_invitation_ttl_days = 99999` is allowed. There is no per-key upper-bound validation. For keys like `agent_token_idle_prune_minutes` or `group_invitation_ttl_days`, absurdly large values could have operational consequences.
**Risk:** An admin (global_admin, who is peer-protected from modifying another admin's actions) could set `max_regular_users = 999999`, bypassing the intended workspace cap.
**Recommendation:** Add per-key maximum values in a `MAX_VALUES` map alongside `ENUM_KEYS`. Suggested maxes: `max_regular_users`: 10000, `max_global_admins`: 20, `group_invitation_ttl_days`: 365, `agent_token_idle_prune_minutes`: 44640 (one month).

---

## File: workers/routes/admin/users.ts

Mount: `/api/admin/users` (app.ts L1013). 5 handlers. **Orphan surface — zero scenario coverage. Privilege escalation surface.**

All handlers are protected by the admin guard at L28-33 (same pattern as settings: `if (!ctx) 401` + `if (ctx.role !== "global_owner" && ctx.role !== "global_admin") 403`). Role check is correct. `canAct` from `workers/lib/peer-protection.ts` is used for promote/demote/delete with correct peer-protection semantics.

### F-AU1 — `GET /` has zero scenario coverage

**Tags:** `severity:medium` `category:coverage`
**Location:** `workers/routes/admin/users.ts:41`
**Method/path:** `GET /api/admin/users`
**Scenario:** `coverage:none` `recommend:S-ADMIN-2`
**Evidence:** Not covered by any of the 30 scenarios. The handler performs a `LEFT JOIN mailboxes` with a `groupBy` aggregate — a non-trivial query.
**Risk:** Aggregate query correctness (e.g., `owns_mailboxes_count = 0` vs null) is untested.
**Recommendation:** Add `S-ADMIN-2` (see below).

### F-AU2 — `POST /invite` has zero scenario coverage

**Tags:** `severity:medium` `category:coverage`
**Location:** `workers/routes/admin/users.ts:83`
**Method/path:** `POST /api/admin/users/invite`
**Scenario:** `coverage:none` `recommend:S-ADMIN-2`
**Evidence:** Not covered. Privacy-preserving `{ ok: true }` regardless of existence is correct (L208), and the email-send failure is correctly logged without changing the response (L187–193). However, the email format regex at L97 is a simplified `[^\s@]+@[^\s@]+\.[^\s@]+` pattern that passes malformed addresses like `a@b.c.d.e` with multiple segments — acceptable for an invite endpoint.
**Risk:** Admin invite bypass (CF Access upsert + user row creation) is untested; regression risk.
**Recommendation:** Add to `S-ADMIN-2`: admin can invite a new email; re-invite of existing user returns `{ ok: true }` (privacy contract); non-admin gets 403.

### F-AU3 — `POST /:id/promote` has zero scenario coverage

**Tags:** `severity:medium` `category:coverage`
**Location:** `workers/routes/admin/users.ts:216`
**Method/path:** `POST /api/admin/users/:id/promote`
**Scenario:** `coverage:none` `recommend:S-ADMIN-3`
**Evidence:** Not covered. The `canAct` call correctly reads `adminCap` from settings and enforces `currentAdminCount >= adminCap`. Admin role-check guard prevents non-admins from calling this.
**Risk:** Cap enforcement logic is untested. If the settings fetch returns a malformed value, `parseInt` returns `NaN`, `adminCap = NaN`, and the cap check `NaN >= NaN` is false — the cap would be bypassed.
**Risk detail:**
```ts
// admin/users.ts:244-245
const adminCap = adminCapRow ? parseInt(adminCapRow.value, 10) : undefined;
// If adminCapRow.value is not a valid integer, adminCap = NaN
// L257-268: canAct(..., NaN, currentAdminCount)
// peer-protection.ts:63: NaN >= NaN → false → cap NOT enforced
```
**Recommendation:** Validate `parseInt` result: if `isNaN(adminCap)`, treat as `undefined` (no cap) or return a 500. Add `S-ADMIN-3`: promote flow — cap enforcement, `global_owner` cannot be promoted (they are already top), `global_admin` cannot promote another to `global_admin` if peer-protection blocks.

### F-AU4 — `POST /:id/demote` has zero scenario coverage

**Tags:** `severity:medium` `category:coverage`
**Location:** `workers/routes/admin/users.ts:298`
**Method/path:** `POST /api/admin/users/:id/demote`
**Scenario:** `coverage:none` `recommend:S-ADMIN-3`
**Evidence:** Not covered. `canAct` peer-protection is correct (global_owner can demote any global_admin; global_admin can only self-demote).
**Risk:** Self-demote path is the only safe demote for global_admin. If `canAct` has a bug, a global_admin could accidentally demote a colleague. Untested.
**Recommendation:** Add to `S-ADMIN-3`: self-demote succeeds; peer-demote 422; global_owner can demote any admin.

### F-AU5 — `DELETE /:id` has zero scenario coverage; self-delete not guarded

**Tags:** `severity:medium` `category:coverage`
**Location:** `workers/routes/admin/users.ts:363`
**Method/path:** `DELETE /api/admin/users/:id`
**Scenario:** `coverage:none` `recommend:S-ADMIN-4`
**Evidence:** Not covered. `canAct` blocks `global_owner` deletion and blocks removal of users with mailboxes. However, `canAct` does NOT block self-deletion. A `global_admin` could delete their own user row. `peer-protection.ts` only blocks peer-delete of another `global_admin`; self-delete (`actor.user_id === target.id`) for a `global_admin` is **permitted** by the current logic (falls through to `return { ok: true }` at L101-102).
```ts
// peer-protection.ts:95-103 (remove case):
if (actor.role === "global_admin") {
  if (target.role === "user") {
    return { ok: true };
  }
  // Cannot remove another global_admin (peer-protected)
  return { ok: false, reason: "peer-protected" };
}
```
Wait — if `actor.role === "global_admin"` and `target.role === "global_admin"` (self), the `target.role === "user"` check fails, and `return { ok: false, reason: "peer-protected" }` fires. Self-delete for `global_admin` **is** blocked. Confirmed safe. However, a `global_owner` can self-delete: `target.role === "global_owner"` triggers the early return `{ ok: false, reason: "cannot-modify-owner" }` at L52-54 — also safe.

Revised finding: self-delete is correctly blocked for all role levels. The primary issue is zero scenario coverage.
**Risk:** Zero coverage on the highest-privilege mutation surface. Any regression in `canAct` goes undetected.
**Recommendation:** Add `S-ADMIN-4`: delete flow — blocked if user owns mailboxes (409); blocked if global_owner (422 cannot-modify-owner); global_admin can delete a regular user; self-delete blocked.

---

## Coverage gaps recommended for new scenarios

These are pulled from the orphan-surfaces table in the coverage matrix plus findings above:

| Scenario ID | Surface(s) covered | Priority |
|---|---|---|
| `S-ADMIN-1` | `admin/settings.ts` GET + PATCH (read, update, bad key, non-admin 403) | high |
| `S-ADMIN-2` | `admin/users.ts` GET + POST /invite (list, privacy-preserving invite) | high |
| `S-ADMIN-3` | `admin/users.ts` POST /promote + POST /demote (cap check, peer-protection, self-demote) | high |
| `S-ADMIN-4` | `admin/users.ts` DELETE (owns-mailboxes 409, global_owner blocked, success) | high |
| `S-GROUP-3` | `groups.ts` POST /:groupId/transfer (success path, new owner must be member) | medium |
| `S-MAILBOX-3` | `mailboxes.ts` GET /availability (taken, invalid, available) | medium |
| `S-MAILBOX-4` | `mailboxes.ts` GET /share/autocomplete + /transfer/autocomplete (visibility tiers) | medium |
| `S-INVITATIONS-2` | `invitations.ts` POST /:id/cancel (inviter can cancel, non-inviter 403, idempotent) | medium |
| `S-INVITATIONS-3` | `invitations.ts` GET /autocomplete (nobody-visibility excluded, blocked excluded) | low |

---

## Open questions / blockers

1. **D-aim-10 exact shape.** The decision says `"Invitation sent"` as the response. The implementation returns `{ sent: true }`. This audit cannot determine which is canonical without reading the original decision record in the Small World graph. Phase 3 integration should confirm and reconcile.

2. **`INVITATION_HMAC_KEY` usage is dead code.** The HMAC token at `invitations.ts:222` is computed but its return value is discarded. It is unclear whether this was intentionally left dormant (for a future invitation-link path) or is a vestige of a scrapped feature. Phase 3 should decide: remove the dead computation or wire it properly.

3. **`contacts.ts GET /` and D-aim-12 scope.** The GET handler does not use `filterVisibleUsers`. Whether this is intentional (listing YOUR OWN contacts bypasses visibility) or a gap (contacts' current visibility should gate what data is returned) requires confirmation from the product decision. The finding F-C1 is tagged `severity:low` pending that confirmation.

4. **`admin/users.ts GET /` query correctness.** The `LEFT JOIN mailboxes ... GROUP BY users.id` query at L46-64 counts all mailboxes owned by the user. If the `mailboxes` table is large, this could be slow without an index on `mailboxes.owner_user_id`. Teammate A should check the control-plane schema for this index. Not auditable from route file alone.

5. **`notifications.ts` — email-only invitations.** The `GET /unseen` endpoint only surfaces invitations where `invitee_user_id = ctx.user_id`. Invitations sent to an email that was not yet a registered user (before the `upsertEmail` + `INSERT users` path in `/admin/users/invite`) would be invisible to the recipient until their `invitee_user_id` is backfilled. Whether this backfill happens on first login is not visible from this route file alone — Teammate A should check `bootstrapOwner` + `authzContext` middleware.

---

**End of report.**
