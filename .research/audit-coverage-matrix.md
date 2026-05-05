# Audit Coverage Matrix — agentic-inbox audit Phase 1

**created:** 2026-05-04
**branch:** `feature/autonomous-local-testing` @ `c8b319a`
**graph project:** `Nj4GAT_PYMKZY8OAC7AIy`
**phase:** `1s5Id6ymC6alEdq2Tdkpy` (current)
**episode:** `ep_4c3f8ad19228` (`main:opus:agentic-inbox-audit-phase1`)

> Static-only audit per **D-AIA-1**. No scenario execution this session
> (USR-directive-4). All mappings derived from `Read` + `grep` —
> Serena MCP was bound to `cld-net`, not `agentic-inbox`, so the
> grep+Read fallback authorized by **USR-directive-2** was used.

---

## Open-Question Resolution

### OQ-AIA-1 — Is the 30-scenario suite green on `c8b319a`?

**Answer:** Suite is **NOT green**. 23 of 30 scenarios have a per-scenario
finding file under `.scratch/findings/S-*-2026-05-{04,05}*.md` written by
the runner — every finding is a captured failure record (severity field is
always `low` or `medium`, never `none`/`info`).

| Scenario | Latest finding (UTC) | Severity |
|---|---|---|
| S-AUTH-1 | 2026-05-04T15:38 | low |
| S-AUTH-2 | 2026-05-04T03:48 | low |
| S-AUTH-3 | 2026-05-04T03:47 | low |
| S-CLI-1 | 2026-05-04T15:57 | low |
| S-CLI-2 | 2026-05-04T15:57 | low |
| S-CLI-3 | 2026-05-04T15:57 | low |
| S-CLI-4 | 2026-05-04T15:57 | low |
| S-CLI-5 | 2026-05-04T15:57 | low |
| S-CONTACTS-1 | 2026-05-04T15:57 | low |
| S-CONTACTS-2 | 2026-05-04T15:57 | low |
| S-CONTACTS-3 | 2026-05-04T15:57 | low |
| S-CONTACTS-4 | 2026-05-04T15:58 | low |
| S-DRAFT-1 | 2026-05-04T15:58 | low |
| S-GROUP-1 | 2026-05-04T15:58 | low |
| S-INBOX-1 | 2026-05-05T01:21 | medium |
| S-INBOX-2 | 2026-05-04T04:27 | medium |
| S-INVITATIONS-1 | 2026-05-04T15:58 | low |
| S-MAILBOX-1 | 2026-05-05T01:10 | low |
| S-MAILBOX-2 | 2026-05-05T01:10 | low |
| S-MSG-1 | 2026-05-04T10:57 | low |
| S-MSG-2 | 2026-05-04T04:44 | medium |
| S-MSG-5 | 2026-05-04T15:57 | low |
| S-NOTIFICATIONS-1 | 2026-05-04T15:58 | low |

**Scenarios with no recent finding** (status unknown — may have passed,
or simply not been re-run after the last failure): `S-AUTH-4`, `S-GROUP-2`,
`S-INBOX-3`, `S-INBOX-3-ALLOWLIST`, `S-INBOX-3-INTERNAL-MODE`, `S-INBOX-4`,
`S-MSG-3`.

**Static audit treats every scenario whose surfaces it covers as
ground-truth regardless of green/red status** (per **D-AIA-3**) — a
red scenario is just an already-known finding, but its surface map is
still valid.

### OQ-AIA-2 — ULTRAREVIEW / CodeQL / Semgrep reports?

**Answer:** None present. Globbed `.research/`, `.scratch/`, repo root,
and `find -maxdepth 4 -iname "*ultrareview*" -o -iname "*codeql*" -o
-iname "*semgrep*"` — zero hits. This audit is the first static-analysis
pass; nothing to cross-reference.

### OQ-AIA-3 — Client-side `app/components/` in scope?

**Default OUT** (per Phase 1 plan). Audit ends at the HTTP boundary
(`workers/routes/*` + `workers/app.ts` inline handlers + supporting
`workers/lib/*` + `workers/db/*`).

---

## Audit Surfaces (canonical)

In-scope per **action-plan-agentic-inbox-audit** Phase 2 partition.
File counts and exported symbols extracted via `grep -nE '^export '`.

### A. Auth / lib / db (Teammate A's partition)

| File | LOC | Exported symbols |
|---|---|---|
| `workers/auth/index.ts` | ~120 | `BetterAuthSession` (interface), `ServerAuth` (interface), `createAuth(env): ServerAuth` |
| `workers/auth/consent.ts` | ~330 | `verifyOAuthQuerySignature`, `loadConsentClient`, `submitConsentDecision`, `ConsentClientView`, `ConsentDecisionInput`, `ConsentDecisionResult`, `ConsentForwardError` (class) |
| `workers/lib/bootstrap-owner.ts` | ~30 | `bootstrapOwner` |
| `workers/lib/mailbox-permissions.ts` | ~110 | `PermResult`, `MailboxRow`, `GroupRow`, `canShare`, `canUnshare`, `canTransfer`, `canDelete` |
| `workers/lib/visibility-filter.ts` | ~165 | `VisibilityValue`, `UserRef`, `ActorRef`, `GroupMemberRef`, `ContactRef`, `VisibilityFilterOptions`, `filterVisibleUsers`, `sortByRelevance` |
| `workers/db/schema.ts` | ~85 | `folders`, `emails`, `attachments`, `threads` (Drizzle tables — D1 mailbox plane) |
| `workers/db/control-plane/schema.ts` | ~660 | 24 tables: `users`, `contacts`, `groups`, `group_members`, `group_invitations`, `mailboxes`, `mailbox_groups`, `mailbox_acls`, `agent_tokens`, `agent_instances`, `settings`, `session`, `account`, `verification`, `rate_limit`, `audit_log`, `inboxExternalAllowlist`, `clients`, `clientGrants`, `jwks`, `oauth_client`, `oauth_consent`, `oauth_refresh_token`, `oauth_access_token`, `oauth_personal_access_token` |
| `workers/db/control-plane/forGroup.ts` | ~40 | `AuthzContext`, `forGroup(db, ctx)`, `ForGroupHandle` |

### B. Routes / admin (Teammate B's partition)

Each row = one route file. Mount prefix from `workers/app.ts:1013-1064`.
Path = handler path inside the file. Method/line = registration site.

#### `workers/routes/groups.ts` → `/api/groups` (mount L1020)

| Line | Method | Path | Handler |
|---|---|---|---|
| 55 | GET | `/` | list groups |
| 101 | POST | `/` | create group |
| 167 | GET | `/:groupId` | group detail |
| 211 | PATCH | `/:groupId` | edit group |
| 289 | DELETE | `/:groupId` | delete group |
| 337 | POST | `/:groupId/transfer` | transfer ownership |
| 406 | GET | `/:groupId/members` | list members |
| 456 | POST | `/:groupId/members/:userId/role` | change role |
| 565 | DELETE | `/:groupId/members/:userId` | remove member |

#### `workers/routes/contacts.ts` → `/api/contacts` (mount L1064)

| Line | Method | Path | Handler |
|---|---|---|---|
| 62 | GET | `/` | list contacts |
| 101 | POST | `/request` | send contact request |
| 252 | POST | `/:id/accept` | accept contact request |
| 318 | POST | `/:id/decline` | decline contact request |
| 383 | POST | `/:userId/block` | block user |

#### `workers/routes/mailboxes.ts` → `/api/mailboxes` (mount L1026)

| Line | Method | Path | Handler |
|---|---|---|---|
| 107 | GET | `/tree` | mailbox tree |
| 154 | GET | `/availability` | address availability |
| 207 | POST | `/` | create mailbox |
| 326 | POST | `/:id/share` | share with group |
| 399 | DELETE | `/:id/share/:groupId` | unshare |
| 461 | POST | `/:id/transfer` | transfer ownership |
| 545 | DELETE | `/:id` | delete mailbox |
| 681 | GET | `/share/autocomplete` | share autocomplete |
| 694 | GET | `/transfer/autocomplete` | transfer autocomplete |

#### `workers/routes/invitations.ts` → `/api/invitations` (mount L1021)

| Line | Method | Path | Handler |
|---|---|---|---|
| 69 | POST | `/` | invite to group |
| 277 | POST | `/:id/accept` | accept invitation |
| 351 | POST | `/:id/decline` | decline invitation |
| 406 | POST | `/:id/cancel` | cancel invitation |
| 461 | GET | `/autocomplete` | invitee autocomplete |

#### `workers/routes/notifications.ts` → `/api/notifications` (mount L1022)

| Line | Method | Path | Handler |
|---|---|---|---|
| 30 | GET | `/unseen` | unseen count |

#### `workers/routes/admin/settings.ts` → `/api/admin/settings` (mount L1014)

| Line | Method | Path | Handler |
|---|---|---|---|
| 40 | GET | `/` | list settings |
| 57 | PATCH | `/:key` | update setting |

#### `workers/routes/admin/users.ts` → `/api/admin/users` (mount L1013)

| Line | Method | Path | Handler |
|---|---|---|---|
| 41 | GET | `/` | list users |
| 83 | POST | `/invite` | invite user |
| 216 | POST | `/:id/promote` | promote to admin |
| 298 | POST | `/:id/demote` | demote from admin |
| 363 | DELETE | `/:id` | delete user |

**Total in-scope handlers:** 36 across 8 files (auth-helpers + db not
counted; lib helpers are reachable via every route that touches groups
or mailboxes).

---

## Scenario → Surface Map

Each row = one scenario. `Surfaces hit` columns flag every audit surface
that the scenario's HTTP path-set actually exercises. Path extraction =
`grep -oE '/(api|__mock)/[a-zA-Z0-9/_:-]+'` over each `s-*.ts`.

Legend (column abbreviations):
- **AU** = `workers/auth/*` (login + consent)
- **LB-perm** = `workers/lib/mailbox-permissions.ts`
- **LB-vis** = `workers/lib/visibility-filter.ts`
- **LB-boot** = `workers/lib/bootstrap-owner.ts`
- **DB-cp** = `workers/db/control-plane/schema.ts` (any control-plane table)
- **DB-mb** = `workers/db/schema.ts` (D1 mailbox plane)
- **DB-fG** = `workers/db/control-plane/forGroup.ts`
- **R-grp** = `workers/routes/groups.ts`
- **R-con** = `workers/routes/contacts.ts`
- **R-mbx** = `workers/routes/mailboxes.ts`
- **R-inv** = `workers/routes/invitations.ts`
- **R-not** = `workers/routes/notifications.ts`
- **R-AdS** = `workers/routes/admin/settings.ts`
- **R-AdU** = `workers/routes/admin/users.ts`
- **OOS** = scenario hits routes outside the audit charter (see "Out-of-charter touches" below)

| Scenario | smoke | Description | AU | LB-perm | LB-vis | LB-boot | DB-cp | DB-mb | DB-fG | R-grp | R-con | R-mbx | R-inv | R-not | R-AdS | R-AdU | OOS |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| S-AUTH-1 | yes | First-time login via OTP | ✅ | | | ✅ | ✅ | | | | | | | | | | |
| S-AUTH-2 | yes | Sign-out + re-login | ✅ | | | | ✅ | | | | | | | | | | |
| S-AUTH-3 | yes | Two browser sessions + revoke other | ✅ | | | | ✅ | | | | | | | | | | sessions |
| S-AUTH-4 | no | Expired session is filtered from listings | ✅ | | | | ✅ | | | | | | | | | | sessions, clients |
| S-CLI-1 | yes | Connected Agents panel renders | ✅ | | | | ✅ | | | | | | | | | | clients (UI) |
| S-CLI-2 | no | Grant inbox access to a non-browser client | ✅ | ✅ | | | ✅ | | | | | ✅ | | | | | clients |
| S-CLI-3 | no | Revoke a non-browser client | ✅ | ✅ | | | ✅ | | | | | ✅ | | | | | clients |
| S-CLI-4 | no | Revoke a single grant; client itself remains active | ✅ | ✅ | | | ✅ | | | | | ✅ | | | | | clients |
| S-CLI-5 | no | POST `/api/users/me/clients` validation + lifecycle | ✅ | | | | ✅ | | | | | | | | | | clients |
| S-CONTACTS-1 | no | Send + dedup + block on contacts CRUD | ✅ | | ✅ | | ✅ | | | | ✅ | | | | | | admin/me (app.ts inline) |
| S-CONTACTS-2 | no | Two-user accept handshake | ✅ | | ✅ | | ✅ | | | | ✅ | | | | | | admin/me (app.ts inline) |
| S-CONTACTS-3 | no | Decline + D12 sender-blind invariant + re-request edge | ✅ | | ✅ | | ✅ | | | | ✅ | | | | | | admin/me (app.ts inline) |
| S-CONTACTS-4 | no | Block flow with cascading mirror cleanup | ✅ | | ✅ | | ✅ | | | | ✅ | | | | | | admin/me (app.ts inline) |
| S-DRAFT-1 | no | Draft create + replace via v1 drafts API | ✅ | | | | ✅ | ✅ | | | | ✅ | | | | | v1/drafts |
| S-GROUP-1 | no | Group CRUD by the group owner | ✅ | ✅ | | | ✅ | | ✅ | ✅ | | | | | | | |
| S-GROUP-2 | no | Group member role changes + member removal | ✅ | ✅ | | | ✅ | | ✅ | ✅ | | | ✅ | | | | admin/me (app.ts inline) |
| S-INBOX-1 | yes | Create personal mailbox | ✅ | | | | ✅ | | | | | ✅ | | | | | |
| S-INBOX-2 | no | Delete a mailbox | ✅ | ✅ | | | ✅ | | | | | ✅ | | | | | v1/mailboxes |
| S-INBOX-3 | no | external_inbound_enabled disabled bounces inbound | ✅ | | | | ✅ | ✅ | | | | ✅ | | | | | inbox-policies, v1/emails |
| S-INBOX-3-ALLOWLIST | no | external_allow_mode='allowlist' filters senders | ✅ | | | | ✅ | ✅ | | | | ✅ | | | | | inbox-policies, v1/emails |
| S-INBOX-3-INTERNAL-MODE | no | internal_inbound_mode='none' bounces internal senders | ✅ | | | | ✅ | ✅ | | | | ✅ | | | | | inbox-policies, v1/emails |
| S-INBOX-4 | no | Allowlist add / remove (CRUD) | ✅ | | | | ✅ | | | | | ✅ | | | | | inbox-policies/allowlist |
| S-INVITATIONS-1 | no | Group invitation accept lifecycle | ✅ | ✅ | | | ✅ | | ✅ | ✅ | | | ✅ | ✅ | | | |
| S-MAILBOX-1 | no | Mailbox ownership transfer end-to-end | ✅ | ✅ | | | ✅ | | | | | ✅ | | | | | |
| S-MAILBOX-2 | no | Share-with-group lifecycle (single-user variant) | ✅ | ✅ | | | ✅ | | ✅ | ✅ | | ✅ | | | | | |
| S-MSG-1 | yes | Send a new email | ✅ | | | | ✅ | ✅ | | | | ✅ | | | | | v1/emails |
| S-MSG-2 | no | Reply to email (v1 in_reply_to threading) | ✅ | | | | ✅ | ✅ | | | | | | | | | v1/emails, threads/messages |
| S-MSG-3 | no | Forward inbound email via v1 | ✅ | | | | ✅ | ✅ | | | | | | | | | v1/emails, reply-forward |
| S-MSG-5 | no | Mock-inject inbound email | ✅ | | | | ✅ | ✅ | | | | | | | | | v1/emails |
| S-NOTIFICATIONS-1 | no | Group-invitation notifications surface | ✅ | ✅ | | | ✅ | | ✅ | ✅ | | | ✅ | ✅ | | | |

**Notes on the AU + DB-cp columns.** Every scenario starts with `loginAs(...)`
which exercises `workers/auth/*` + `session`/`account`/`verification`
control-plane tables. Treat AU and DB-cp as a baseline (every scenario
hits them); meaningful coverage signal is in the other columns.

---

## Per-Surface Coverage Roll-up

Reading the matrix down each surface column:

| Surface | Direct scenario coverage (excluding baseline AU+DB-cp) | Count |
|---|---|---|
| `workers/auth/index.ts` | All 30 (baseline) | 30 |
| `workers/auth/consent.ts` | **ZERO** — no scenario exercises OAuth consent flow | **0** |
| `workers/lib/bootstrap-owner.ts` | S-AUTH-1 (first-login owner promotion) | 1 |
| `workers/lib/mailbox-permissions.ts` | S-CLI-2/3/4, S-INBOX-2, S-MAILBOX-1/2, S-GROUP-1/2, S-INVITATIONS-1, S-NOTIFICATIONS-1 | 10 |
| `workers/lib/visibility-filter.ts` | S-CONTACTS-1/2/3/4 | 4 |
| `workers/db/schema.ts` (D1 mailbox plane) | S-DRAFT-1, S-INBOX-3/3-ALLOWLIST/3-INTERNAL-MODE, S-MSG-1/2/3/5 | 8 |
| `workers/db/control-plane/schema.ts` | All 30 (baseline via session table) | 30 |
| `workers/db/control-plane/forGroup.ts` | S-GROUP-1/2, S-INVITATIONS-1, S-MAILBOX-2, S-NOTIFICATIONS-1 | 5 |
| `workers/routes/groups.ts` | S-GROUP-1/2, S-INVITATIONS-1, S-NOTIFICATIONS-1 (via /api/groups), S-MAILBOX-2 (group lookup) | 5 |
| `workers/routes/contacts.ts` | S-CONTACTS-1/2/3/4 | 4 |
| `workers/routes/mailboxes.ts` | S-CLI-2/3/4, S-DRAFT-1, S-INBOX-1/2/3/3-ALLOWLIST/3-INTERNAL-MODE/4, S-MAILBOX-1/2, S-MSG-1 | 13 |
| `workers/routes/invitations.ts` | S-GROUP-2, S-INVITATIONS-1, S-NOTIFICATIONS-1 | 3 |
| `workers/routes/notifications.ts` | S-GROUP-2, S-INVITATIONS-1, S-NOTIFICATIONS-1 | 3 |
| `workers/routes/admin/settings.ts` | **ZERO** — no scenario hits admin settings CRUD | **0** |
| `workers/routes/admin/users.ts` | **ZERO** — no scenario hits admin user CRUD/promote/demote | **0** |

---

## Orphan Surfaces (zero scenario coverage) — TASK-1.2

The following surfaces are **NOT exercised by any of the 30 scenarios**.
They are coverage gaps Phase 2 audits must flag explicitly:

| Surface | Gap kind | Severity for Phase 2 |
|---|---|---|
| `workers/auth/consent.ts` (OAuth consent flow — `verifyOAuthQuerySignature`, `loadConsentClient`, `submitConsentDecision`, `ConsentForwardError`) | Entire OAuth-consent path uncovered | **high** — security-critical surface |
| `workers/routes/admin/settings.ts` GET `/`, PATCH `/:key` | Admin settings CRUD uncovered | **medium** — privilege surface |
| `workers/routes/admin/users.ts` GET `/`, POST `/invite`, POST `/:id/promote`, POST `/:id/demote`, DELETE `/:id` | Admin user CRUD + promote/demote uncovered | **high** — privilege escalation surface |
| `workers/routes/mailboxes.ts` GET `/availability`, GET `/share/autocomplete`, GET `/transfer/autocomplete` | Three GET helpers uncovered (autocomplete + availability) | **low** — read-only autocomplete |
| `workers/routes/invitations.ts` POST `/:id/cancel`, GET `/autocomplete` | Invitation cancel + invitee autocomplete uncovered | **medium** — cancel is mutation |
| `workers/routes/contacts.ts` (every handler covered, but `/block` only via S-CONTACTS-1/4 — no decline-then-block sequence) | Partial — minor combinatorial gap | low |

**`workers/lib/visibility-filter.ts`** is exercised only via the contacts
suite. The 5-tier visibility (USR-good-practice-2 / USR-directive-5) is
not directly observable through the contacts scenarios alone — Phase 2
Teammate A should call this out as a **medium** coverage gap and
recommend additional scenarios for visibility tiers `everyone` /
`contacts` / `nobody` against group-member, mailbox-share, and
discover-by-email surfaces.

---

## Out-of-charter touches (informational)

Several scenarios hit handlers OUTSIDE the audit charter. These are
out-of-scope for Phase 2 audits but documented here so Teammate A/B
know to skip them:

| Out-of-scope surface | Scenarios touching | Mount |
|---|---|---|
| `workers/routes/sessions.ts` | S-AUTH-3, S-AUTH-4 | `/api/users/me/sessions` (L1034) |
| `workers/routes/clients.ts` | S-AUTH-4, S-CLI-1/2/3/4/5 | `/api/users/me/clients` (L1038) |
| `workers/routes/inbox-policies.ts` | S-INBOX-3, S-INBOX-3-ALLOWLIST, S-INBOX-3-INTERNAL-MODE, S-INBOX-4 | `/api/mailboxes/:id/policies(/allowlist)` (L1052) |
| `workers/routes/threads.ts` | S-MSG-2 (`/api/mailboxes/:mid/threads/:tid/messages`) | mounted at `/api/mailboxes` (L1056) |
| `v1` API surfaces — `workers/routes/v1/*` (assumed; not enumerated this phase) | S-DRAFT-1, S-INBOX-3*, S-MSG-1/2/3/5 (`/api/v1/mailboxes/:addr/{drafts,emails}`) | not enumerated |
| `workers/app.ts` inline handlers — `/api/admin/me` (L336), `/api/users/me` (L344), `/api/users/me/visibility` (L616), `/api/users/me/profile` (L674), `/api/users/discover-by-email` (L812), `/api/users/search` (L937), `/api/users/me/avatar` (L380/L482) | S-CONTACTS-2/3/4, S-GROUP-2 hit `/api/admin/me`; visibility/profile/discover hit by contacts indirectly | inline, no router mount |

**Coverage observation:** `/api/admin/me`, `/api/users/me/visibility`,
`/api/users/me/profile`, `/api/users/discover-by-email`, `/api/users/search`
are inline in `workers/app.ts` and **not in the audit charter** but ARE
exercised by scenarios. If Phase 2 surfaces a finding tied to a contacts
or visibility scenario, the actual code under test may be these inline
handlers — Teammate A should treat `workers/app.ts` user-handler region
(L336–L1010) as **adjacent context** and read it once for orientation,
even though it isn't in the charter file list.

---

## Cross-references for Phase 2

- **Carried-forward decisions to honor (per action plan):**
  - **D-aim-5** — per-mailbox token scoping: application-layer (audit `mailbox-permissions.ts` + `mailbox_acls` table; verify enforcement happens in `R-mbx` paths, not in DB constraints).
  - **D-aim-10** — privacy-preserving group invitations: every invite handler in `R-grp` + `R-inv` returns uniform `{ "sent": true }` (JSON, HTTP 200) regardless of recipient existence/visibility/membership. _Amended 2026-05-05 (hardening Phase 1 task 1.3, F-I1 resolution): canonical shape is JSON envelope, not plain-text "Invitation sent." (graph node `tB9b_WFIuRNFVdmG9dOxa`). Privacy invariant — uniformity — is preserved by the JSON shape and is consistent with the rest of the route surface._
  - **D-aim-12** — contacts + 3-tier visibility: `LB-vis` is the canonical filter; every consumer in `R-con` + adjacent `app.ts` user handlers should route through it.
  - **D-V2F-3** — `forGroup()` discipline: any control-plane query that joins `group_members` MUST go through `LB-fG`, never raw drizzle. Phase 2 Teammate A should grep for direct `group_members` joins outside `forGroup()`.
  - **D-V2U-1** — private mailbox semantics: `mailboxes.owner_user_id` + `mailbox_acls` interaction; Phase 2 should verify `R-mbx` `/share`, `/unshare`, `/transfer`, `DELETE` all correctly mutate ACLs.

- **`covers:` strings** in each scenario are an authoritative spec — Phase 2
  should treat the docstring "Branches covered" block as the contract the
  handler MUST satisfy and tag any divergence as `severity:high
  category:correctness`.

---

## Phase 2 Hand-off

Both Phase 2 teammates should:
1. Read this matrix start-to-finish.
2. Use `Surfaces hit` columns to find the in-scope rows for each
   in-partition file.
3. For every Phase 2 finding, cite a **scenario id from this matrix** OR
   tag `coverage:none` with a recommended scenario id.
4. Treat the **Orphan Surfaces** table as a top-priority "no coverage"
   feeder — every orphan surface gets at least one finding (even if just
   `severity:low coverage:none`).

Phase 2 partition is naturally disjoint (auth/lib/db ⨯ routes), already
verified in the action plan's "Partition check (passes)" block.

---

**End of matrix.**
