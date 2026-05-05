# Audit Report — agentic-inbox (Phase 3 Consolidation)

**created:** 2026-05-04 (consolidated 2026-05-05)
**branch / HEAD:** `feature/autonomous-local-testing` @ `c8b319a` (Phase 2 audit anchor); tree at consolidation: `8ec9e9e`
**sources:** `.research/audit-auth-permissions.md` (Teammate A, 26 findings) + `.research/audit-routes-admin.md` (Teammate B, 20 findings)
**total findings:** 46 unique
**graph project:** `Nj4GAT_PYMKZY8OAC7AIy` (`agentic-inbox-audit`); user-request `kD4Tz4nsRP0dQTDCYYsIB`
**phase episode:** `ep_3d5a43bc490f`

> Static audit; zero source modifications during Phases 1-3. Fixes are deferred to a follow-up hardening plan per **D-AIA-4**.

---

## 1. Context Resolution — open questions closed before ranking

**OQ-AIA-4 — visibility-tier count (5 vs 3).** Surfaced to user on 2026-05-05; user redirected to broader hardening focus and accepted **default B**: `D-aim-12` as written (3-tier) is canonical. **Finding V-1 demoted from `high` to `medium` (`category:coverage` rather than `correctness`)** — the codebase implements its documented 3-tier model correctly; the matrix and Phase 2 brief mis-quoted "5-tier" from `USR-good-practice-2`. Recommended follow-ups: amend `USR-good-practice-2` text and the audit-coverage-matrix to read "3-tier" so the carried-forward decision stops drifting; tiers 3/5 are no longer scoped as missing features. Punch-list line for V-1 reduces to "documentation + matrix amendment", not a code change.

**OQ-AIA-1 — scenario suite green on HEAD?** Phase 1 noted no recent run artifacts in `.scratch/` or `test-results/`. Static audit proceeded. Punch list assumes current static state; dynamic-execution Phase 4 deferred per `USR-directive-4`.

**OQ-AIA-2 — ULTRAREVIEW / Semgrep cross-reference?** Phase 1 found none. No prior tooling overlap to dedupe against.

**OQ-AIA-3 — `app/components/` in scope?** Defaulted out (audit ends at HTTP boundary). User did not push back.

**XC-1 / H1 internal demotion (Teammate B).** B's summary header lists H1 as `severity:high` but B's body revised it to `severity:low` after confirming all `groups.ts` mutations DO flow through `forGroup(...).db` — high-severity claim is the route-level chokepoint, low-severity claim is the future-violation-risk surface count (40+ refs). Body wins per the action-plan validation rule. **Final ranking treats XC-1 as `low`**; the genuine high-severity `forGroup` violation is **CC-1** (Teammate A, infrastructure layer at `lib/mailbox-tree.ts:48` and `middleware/authz-context.ts:71`).

**Net effect on counts:**

| Original (Phase 2 preview) | Adjustment | Final (Phase 3) |
|---|---|---|
| critical 1, high 7, medium 16, low 22 | V-1: high → medium; XC-1: high → low | **critical 1, high 5, medium 19, low 21** |

> Body-tag truth (per `severity:` tags in source reports) supersedes summary-header counts where they drift. Net unique findings = **46 = 1 + 5 + 19 + 21**.

---

## 2. Risk Matrix

|                     | security | correctness | schema | coverage | **Σ** |
|:--------------------|:--------:|:-----------:|:------:|:--------:|:-----:|
| **critical**        |     1    |      0      |    0   |     0    | **1** |
| **high**            |     3    |      2      |    0   |     0    | **5** |
| **medium**          |     3    |      4      |    5   |     7    | **19**|
| **low**             |     6    |      6      |    5   |     4    | **21**|
| **Σ**               |    13    |     12      |   10   |    11    | **46**|

**Where the risk lives, in plain terms:**

1. **Schema / control-plane discipline (1 critical + 4 schema-medium + 5 schema-low).** The `oauth_refresh_token` UNIQUE gap (S-1) is the only ranked-critical finding in the entire audit. The pattern around it — non-unique indexes where UNIQUE was the actual security invariant — repeats in `account.(provider_id, account_id)`, `verification.identifier`, `groups.(owner_user_id, name)`. A single migration can close this whole cluster.
2. **Token / secret hygiene (4 security-high, 7 security-low).** `INVITATION_HMAC_KEY` (F-I2), the bootstrap-owner `.trim()` divergence (A-1), and the visibility-filter privacy-bypass at `POST /api/contacts/request` (F-C2) are independent but share a root: env access and predicate logic that bypasses the documented chokepoint. **F-I2 + A-1 are 1-line / 1-trim fixes; F-C2 is a 3-line guard.** Cheapest high-severity wins in the punch list.
3. **Coverage gaps on the privilege-escalation surface (7 coverage-medium).** The five `admin/users.ts` handlers (`promote`, `demote`, `delete`, `invite`, `GET /`), both `admin/settings.ts` handlers, and `invitations.ts /:id/cancel` have **zero scenario coverage**. These are the most-privileged mutation routes in the system. Eight new scenarios (`S-ADMIN-1..4`, `S-INVITATIONS-2..3`, `S-MAILBOX-3..4`) close the gap.
4. **`forGroup` discipline cracked at the infrastructure layer (1 security-high + 1 security-low).** CC-1 — `lib/mailbox-tree.ts:48` and `middleware/authz-context.ts:71` both call `drizzle()` directly outside the chokepoint. The runtime guarantee held by `forGroup()` is documentation-only (F-1); two actual bypasses + a 40-reference surface in `groups.ts` (XC-1) means the CI-lint that should have caught it must be deployed and tested.
5. **Privacy-tier completeness (1 correctness-high + 2 correctness-medium).** Even after V-1's demotion to coverage, the autocomplete + contact-request paths have one real bug (F-C2: `POST /request` skips `filterVisibleUsers`) and one latent regression (V-2: `enforceContactsAndNobody` defaults to `false` — every new caller that omits the flag silently re-introduces Phase 3 mode). Default-true makes the safe behavior the default.

---

## 3. Top-10 Hardening Punch List

Ordered by **(severity × ease) / fan-out**. Each line carries: `[ID]` graph link, severity, category, file/line, scenario coverage, est. complexity, blast radius.

| # | ID | Severity / Category | File / Line | Action | Complexity | Scenario |
|:--:|:--|:--|:--|:--|:--:|:--|
| **1** | **S-1** | critical / security+schema | `workers/db/control-plane/schema.ts:563` | Add `.unique()` to `oauth_refresh_token.token` + Drizzle migration. Mirror migration on existing prod D1. | S | Add `S-AUTH-OAUTH-TOKEN-1`: duplicate refresh-token rejected. |
| **2** | **F-I2** | high / security | `workers/routes/invitations.ts:216-218`, `workers/types.ts` | Add `INVITATION_HMAC_KEY?: string` to `Env`; remove `as unknown as Record<string,string>` cast; either delete the dead `makeHmacToken` call OR wire the token to the invitation row + `wrangler secret put`. | S | Existing `S-INVITATIONS-1`. |
| **3** | **F-C2** | high / security | `workers/routes/contacts.ts:101` | After `targetUser` lookup, return `404` (privacy-preserving) if `visibility==='nobody'` AND actor not co-member / not accepted-contact. Reuse `filterVisibleUsers` predicate or extract into `contact-permissions.ts`. | S | Extend `S-CONTACTS-1`: `nobody`-tier user → 404 on `/request`. |
| **4** | **A-1** | high / correctness | `workers/auth/index.ts:314-315` | Add `.trim()` to `BOOTSTRAP_OWNER_EMAIL` read in better-auth hook (matches `bootstrap-owner.ts:30`). Extract shared `isBootstrapEmail()` predicate. | XS | Strengthen `S-AUTH-1`: assert `role==='global_owner'` after first-login. |
| **5** | **CC-1** | high / security | `workers/lib/mailbox-tree.ts:48`, `workers/middleware/authz-context.ts:71` | Either route both call sites through `forGroup(...).db`, or add a scoped `buildGroupIds(db, userId)` helper inside `forGroup.ts` that's the documented exemption. **Then deploy the CI grep-lint** (`rg 'from\(.*group_members' workers/`) — currently undeployed per A's open-question #3. | M | Add `S-GROUP-FORGROUPDISCIPLINE-1`: CI guard fails on direct-`drizzle()` query of `group_members`. |
| **6** | **F-I1** | high / correctness | `workers/routes/invitations.ts:270`; D-aim-10 record | **Decision needed:** is D-aim-10's `"Invitation sent"` a JSON-string literal or a plain-text body? Either change the handler to `c.text("Invitation sent")` OR amend D-aim-10 to record `{ sent: true }` as canonical. Update `S-INVITATIONS-1` to assert the chosen shape. | XS | `S-INVITATIONS-1` assertion update. |
| **7** | **V-2** | medium / correctness | `workers/lib/visibility-filter.ts:64` | Flip the `enforceContactsAndNobody?` default from `false` to `true`. Add explicit `false` overrides on the two known Phase-3-mode callers (none today; admin panel is the candidate if it ever needs unfiltered listing). | XS | Negative-test: omitting the flag from an autocomplete caller still excludes `nobody`-tier. |
| **8** | **DB-1 + S-2 + S-3** | medium / schema (×3, performance) | `workers/db/schema.ts` (emails), `workers/db/control-plane/schema.ts` (contacts, group_invitations) | One schema migration adds 4 indexes: `emails_thread_id_idx`, `emails_message_id_idx`, `contacts_contact_user_id_idx`, `group_invitations_invitee_user_idx`. Bundle for one D1 round-trip. | S | Performance scenario optional. |
| **9** | **F-AS1 + F-AS2 + F-AU1..5** | medium / coverage (×7) + correctness (F-AS2, F-AU3) | `workers/routes/admin/{settings,users}.ts` | Add `S-ADMIN-1..4` scenarios (settings read+PATCH; users list+invite; promote+demote; delete). Then fix F-AS2 (per-key `MAX_VALUES` map) and F-AU3 (validate `parseInt(adminCap)`; `NaN` → treat as `undefined` cap or fail-closed). | M | `S-ADMIN-1..4` (4 scenarios, ~15 assertions each). |
| **10** | **MP-1 + V-1 (docs)** | medium / correctness + medium / coverage | `workers/lib/mailbox-permissions.ts:41-56`; `USR-good-practice-2` text + audit-coverage-matrix | Extend `canShare` to accept caller's `mailbox_acls.level` and treat `admin` as equivalent to owner (per D-aim-5). Separately: amend `USR-good-practice-2` and audit-coverage-matrix to read "3-tier" (V-1 cleanup per OQ-AIA-4 default B). | S | `S-MAILBOX-2` variant: admin-ACL grantee can share. |

**Punch list out-of-scope-but-flagged:**

- **C-1, C-2, C-3 (consent.ts orphan surface, 3 mediums).** Consent flow has zero scenario coverage. Add `S-AUTH-OAUTH-CONSENT-1..3` to cover clock-skew (±30 s tolerance), error-detail leak prevention, and scope-intersection enforcement at the lib layer. Lower priority because consent.ts is one rarely-changed file; bundle into a single later phase.
- **S-7 (oauth_client.clientSecret plaintext, low).** Promotes to medium if/when confidential-client OAuth clients are actually issued. Currently dormant — no production confidential clients. Track but don't fix yet.

---

## 4. Ranked Findings (full)

### 4.1 Critical (1)

#### S-1 — `oauth_refresh_token.token` lacks UNIQUE; allows token-replay / substitution
- **Tags:** `severity:critical` `category:security` `category:schema`
- **Location:** `workers/db/control-plane/schema.ts:563`
- **Coverage:** none (recommend `S-AUTH-OAUTH-TOKEN-1`)
- **Source report:** Teammate A (S-1)
- **Why critical:** `oauth_refresh_token.token` has only a non-unique index. `oauth_access_token.token` (line 594) and `session.token` (line 292) both have `.unique()`. A race in token rotation, a migration error, or a corrupted insert path would silently produce duplicate token rows; lookup returns an arbitrary one of the duplicates → token replay. The pattern is already correct on adjacent tables; this one was missed.
- **Fix:** `token: text("token").notNull().unique()`. Drizzle migration to add the constraint (will fail on production if duplicates already exist — script must check first).

### 4.2 High (5)

#### CC-1 — `forGroup` discipline broken at the infrastructure layer
- **Tags:** `severity:high` `category:security`
- **Location:** `workers/lib/mailbox-tree.ts:48`, `workers/middleware/authz-context.ts:71`
- **Coverage:** none (recommend `S-GROUP-FORGROUPDISCIPLINE-1` — CI lint deployment + canary test)
- **Source report:** Teammate A (CC-1)
- **Why high:** Both call sites call `drizzle(db, { schema })` directly and query `group_members` outside the documented `forGroup()` chokepoint. The CI grep-lint that should reject this (per **D-V2F-3**) is not deployed (Teammate A open-question #3 — no `.github/workflows/` rule observed). Two distinct documented bypasses + an undeployed guard = the chokepoint is fictional today.
- **Fix:** route both call sites through the `forGroup` handle (or add a documented exemption helper `buildGroupIds(db, userId)` inside `forGroup.ts` whose grep-lint is explicitly allow-listed). Then deploy and CI-test the lint.

#### A-1 — bootstrap-owner dual-path `.trim()` divergence
- **Tags:** `severity:high` `category:correctness`
- **Location:** `workers/auth/index.ts:314-315` vs `workers/lib/bootstrap-owner.ts:30`
- **Coverage:** `scenario:S-AUTH-1` (existing — no role assertion)
- **Source report:** Teammate A (A-1)
- **Why high:** The better-auth `databaseHooks.user.create.before` hook compares raw `BOOTSTRAP_OWNER_EMAIL` (no `.trim()`); `bootstrap-owner.ts` does `.trim()`. If the env var has trailing whitespace, the better-auth path silently fails to promote (regular role) while the CF Access path correctly promotes. Diverged production deployments end up with wrong-role admin if CF Access is later disabled.
- **Fix:** add `.trim()` to the hook; extract shared predicate `isBootstrapEmail(login, env)` used by both paths.

#### F-C2 — `POST /api/contacts/request` bypasses visibility filter
- **Tags:** `severity:high` `category:security`
- **Location:** `workers/routes/contacts.ts:101`
- **Coverage:** `scenario:S-CONTACTS-1/3/4` (existing — no `nobody`-tier negative case)
- **Source report:** Teammate B (F-C2)
- **Why high:** Direct violation of **D-aim-12**. A `visibility='nobody'` user is supposed to be unreachable for contact-request from non-contacts, non-co-members. The handler skips `filterVisibleUsers` entirely; any authenticated user who knows a target's `user_id` (e.g., from another surface, leaked log, etc.) can send them a contact request, defeating the privacy tier.
- **Fix:** After `targetUser` lookup, if `visibility==='nobody'` AND actor is not co-member / not accepted-contact, return `{ error: "User not found" }` with status 404 (privacy-preserving — same shape as unknown user).

#### F-I1 — D-aim-10 response shape mismatch (`{ sent: true }` vs `"Invitation sent"`)
- **Tags:** `severity:high` `category:correctness`
- **Location:** `workers/routes/invitations.ts:270`
- **Coverage:** `scenario:S-INVITATIONS-1, S-NOTIFICATIONS-1` (existing — assertion may be wrong)
- **Source report:** Teammate B (F-I1)
- **Why high:** D-aim-10 says `"Invitation sent"` (uniform text) was the canonical response. Code returns `{ sent: true }` (JSON object). The privacy invariant is preserved (response is uniform regardless of recipient existence) — but the carried-decision contract is broken. Either the handler or the decision is wrong.
- **Fix:** **Needs a 1-line decision**: is D-aim-10 a plain-text body or a JSON shape? Update whichever is wrong. If text: `return c.text("Invitation sent")`. If JSON: amend D-aim-10 to record `{ sent: true }`. Then update `S-INVITATIONS-1` to assert the chosen shape exactly.

#### F-I2 — `INVITATION_HMAC_KEY` type-unsafe + weak hard-coded fallback
- **Tags:** `severity:high` `category:security`
- **Location:** `workers/routes/invitations.ts:216-218`, `workers/types.ts` (Env interface)
- **Coverage:** `scenario:S-INVITATIONS-1` (existing — secret-validation not asserted)
- **Source report:** Teammate B (F-I2). Cross-referenced by Teammate A (open-question #2).
- **Why high:** `(c.env as unknown as Record<string, string>)["INVITATION_HMAC_KEY"]` bypasses the `Env` type. Fallback is the literal string `"dev-fallback-hmac-key"`. The `makeHmacToken` call's return value is currently discarded — it is dead code TODAY. **But if a future change wires it to a security gate, the dev fallback creates a silent auth bypass in production whenever the env var is unset.**
- **Fix:** Add `INVITATION_HMAC_KEY?: string` to the `Env` interface in `workers/types.ts`; remove the `as unknown` cast; **either** delete the dead HMAC code entirely **or** wire the token to the invitation row + add a `wrangler secret put INVITATION_HMAC_KEY` step to deploy.

### 4.3 Medium (18)

#### V-1 — 5-tier visibility hierarchy partially implemented (DEMOTED FROM HIGH per OQ-AIA-4)
- **Tags:** `severity:medium` `category:coverage` (was `correctness` pre-resolution)
- **Location:** `workers/lib/visibility-filter.ts:19, 83-139`; matrix and brief
- **Coverage:** none (would need `S-CONTACTS-VIS-COC-1` / `S-CONTACTS-VIS-EXPLICIT-1` IF spec ever changes)
- **Source report:** Teammate A (V-1)
- **Resolution:** OQ-AIA-4 default B. Codebase implements 3-tier per **D-aim-12**. Matrix and brief mis-quoted "5-tier" from `USR-good-practice-2`. **Action:** amend documentation, not code. Tiers 3 (`contacts-of-contacts`) and 5 (`explicit-allow`) are **not** scoped as missing features.
- **Fix:** edit `USR-good-practice-2` text and `audit-coverage-matrix.md` to read "3-tier"; remove `S-CONTACTS-VIS-COC-1` / `S-CONTACTS-VIS-EXPLICIT-1` from the recommended scenarios list.

#### V-2 — `enforceContactsAndNobody` defaults to `false`; new callers silently re-enter Phase 3 mode
- **Tags:** `severity:medium` `category:correctness`
- **Location:** `workers/lib/visibility-filter.ts:64`; callers `routes/invitations.ts:548`, `routes/mailboxes.ts:662`
- **Source report:** Teammate A (V-2)
- **Fix:** flip default to `true`; add explicit `false` override on any future Phase-3-semantics caller.

#### MP-1 — `canShare` ignores `mailbox_acls.level`; admin-ACL grantee can't share
- **Tags:** `severity:medium` `category:correctness`
- **Location:** `workers/lib/mailbox-permissions.ts:41-56`
- **Source report:** Teammate A (MP-1). Body tag `severity:medium` (summary header inconsistent — body wins).
- **Fix:** extend `canShare`/`canUnshare` signatures to accept caller's ACL `level`; treat `admin` ACL as equivalent to owner.

#### C-1 — consent.ts: no clock-skew tolerance on `exp` check
- **Tags:** `severity:medium` `category:security`
- **Location:** `workers/auth/consent.ts:80`
- **Source report:** Teammate A (C-1)
- **Fix:** allow `±30 s` of skew. Real-world failure: mobile background/foreground cycle between consent click and redirect.

#### C-2 — `ConsentForwardError` re-exposes plugin error body to client
- **Tags:** `severity:medium` `category:security`
- **Location:** `workers/auth/consent.ts:295-298`
- **Source report:** Teammate A (C-2)
- **Fix:** strip the plugin's error detail; user-facing string is fixed `"Consent request could not be completed"`.

#### C-3 — `loadConsentClient` returns full registered scope; no intersection at lib layer
- **Tags:** `severity:medium` `category:security`
- **Location:** `workers/auth/consent.ts:129-170`
- **Source report:** Teammate A (C-3)
- **Fix:** accept `requestedScopes: string[]` parameter; return `intersection(registeredScopes, requestedScopes)` so callers cannot accidentally over-scope.

#### DB-1 — `emails` table missing indexes on `thread_id`, `message_id`, `folder_id`
- **Tags:** `severity:medium` `category:schema` (performance)
- **Location:** `workers/db/schema.ts:13-39`
- **Source report:** Teammate A (DB-1)
- **Fix:** add three Drizzle indexes; one DO migration per mailbox.

#### S-2 — `contacts` missing index on `contact_user_id`
- **Tags:** `severity:medium` `category:schema`
- **Location:** `workers/db/control-plane/schema.ts:60-86`
- **Source report:** Teammate A (S-2)
- **Fix:** add `contacts_contact_user_id_idx`.

#### S-3 — `group_invitations` missing index on `invitee_user_id`
- **Tags:** `severity:medium` `category:schema`
- **Location:** `workers/db/control-plane/schema.ts:121-149`
- **Source report:** Teammate A (S-3)
- **Fix:** add `group_invitations_invitee_user_idx`. Hot path: `GET /api/notifications/unseen` polled on every page load.

#### S-4 — `groups.owner_user_id` / `mailboxes.owner_user_id` no documented `onDelete` policy
- **Tags:** `severity:medium` `category:schema`
- **Location:** `workers/db/control-plane/schema.ts:93-95, 158-160`
- **Source report:** Teammate A (S-4). Body tag `severity:medium` (summary inconsistent — body wins).
- **Fix:** declare `onDelete: "restrict"` (or `"set null"` with cascade-to-cleanup). Document the chosen policy in `DECISIONS.md`. Admin user-delete handler (F-AU5 area) must handle the constraint gracefully.

#### S-6 — `account` missing UNIQUE on `(provider_id, account_id)`
- **Tags:** `severity:medium` `category:schema`
- **Location:** `workers/db/control-plane/schema.ts:324-327`
- **Source report:** Teammate A (S-6)
- **Fix:** change `index("account_provider_idx")` to `uniqueIndex("account_provider_idx")`. Better-auth manages this table — schema-level uniqueness catches bugs the ORM can't.

#### F-AS1 — `GET /api/admin/settings` zero coverage
- **Tags:** `severity:medium` `category:coverage`
- **Source report:** Teammate B (F-AS1)
- **Fix:** add `S-ADMIN-1` (read+PATCH paths).

#### F-AS2 — `PATCH /api/admin/settings/:key` integer values have no upper-bound cap
- **Tags:** `severity:medium` `category:correctness`
- **Location:** `workers/routes/admin/settings.ts:100-103`
- **Source report:** Teammate B (F-AS2)
- **Fix:** add per-key `MAX_VALUES` map. Suggested caps: `max_regular_users` ≤ 10000, `max_global_admins` ≤ 20, `group_invitation_ttl_days` ≤ 365, `agent_token_idle_prune_minutes` ≤ 44640.

#### F-AU1 — `GET /api/admin/users` zero coverage
- **Tags:** `severity:medium` `category:coverage`
- **Source report:** Teammate B (F-AU1)
- **Fix:** part of `S-ADMIN-2`.

#### F-AU2 — `POST /api/admin/users/invite` zero coverage
- **Tags:** `severity:medium` `category:coverage`
- **Source report:** Teammate B (F-AU2)
- **Fix:** part of `S-ADMIN-2` — verify privacy-preserving `{ ok: true }` for both new + re-invite paths.

#### F-AU3 — `POST /api/admin/users/:id/promote` zero coverage + `parseInt(adminCap)` fail-open on `NaN`
- **Tags:** `severity:medium` `category:coverage` + `category:correctness`
- **Location:** `workers/routes/admin/users.ts:244-245, 257-268`
- **Source report:** Teammate B (F-AU3)
- **Risk:** if `settings.max_global_admins` row's `value` is malformed, `parseInt` returns `NaN`, `canAct(..., NaN, ...)` evaluates `NaN >= NaN` → `false`, cap silently bypassed.
- **Fix:** validate `parseInt` result. `isNaN` → treat as `undefined` (no cap) OR fail-closed with 500. Add `S-ADMIN-3`.

#### F-AU4 — `POST /api/admin/users/:id/demote` zero coverage
- **Tags:** `severity:medium` `category:coverage`
- **Source report:** Teammate B (F-AU4)
- **Fix:** part of `S-ADMIN-3`.

#### F-AU5 — `DELETE /api/admin/users/:id` zero coverage
- **Tags:** `severity:medium` `category:coverage`
- **Source report:** Teammate B (F-AU5)
- **Note:** Self-delete already correctly blocked (`canAct` peer-protection); coverage gap is the issue.
- **Fix:** add `S-ADMIN-4`.

#### F-I3 — `POST /api/invitations/:id/cancel` zero coverage
- **Tags:** `severity:medium` `category:coverage`
- **Source report:** Teammate B (F-I3)
- **Fix:** add `S-INVITATIONS-2`. Verify inviter can cancel; non-inviter non-global → 403; already-accepted → 409.

### 4.4 Low (22)

Compact list; full evidence in source reports.

| ID | File:line | Issue | Action |
|:--|:--|:--|:--|
| **A-2** | `auth/index.ts:124-128` | localhost trustedOrigins hardcoded in prod bundle | gate behind `MOCK_MODE` |
| **A-3** | `auth/index.ts:246-254` | OTP email send not separately rate-limited | add `S-AUTH-OTP-RATELIMIT` |
| **C-4** | `auth/consent.ts:107-108` | `logoUri` sanitization is JSDoc-only | brand `SafeHref` type or apply at lib layer |
| **C-5** | `auth/consent.ts:268-270` | submitConsentDecision forwards all cookies | forward only `__Host-anai.session_token` |
| **B-1** | `lib/bootstrap-owner.ts:34-40` | email lookup case-sensitive vs lowered index | use `lower(email)` in lookup |
| **V-3** | `lib/visibility-filter.ts:103-138` | dead co-member check in Phase-3-mode branch | remove or comment |
| **DB-2** | `db/schema.ts:66-77` | `threads.tip_message_id` logical FK unenforced | documented intent; no action |
| **S-5** | `db/control-plane/schema.ts:72-74` | `contacts.initiated_by` no cascade (unreachable) | document intent or `onDelete: "set null"` |
| **S-7** | `db/control-plane/schema.ts:498` | `oauth_client.clientSecret` plaintext | hash via `TOKEN_PEPPER` HMAC; `client_secret_prefix` for display |
| **S-8** | `db/control-plane/schema.ts:88-98` | `groups.name` no UNIQUE per owner | `uniqueIndex("groups_owner_name_unique")` on `(owner_user_id, name)` |
| **S-9** | `db/control-plane/schema.ts:330-344` | `verification.identifier` no UNIQUE | confirm with better-auth, then `uniqueIndex` |
| **F-1** | `db/control-plane/forGroup.ts:29-38` | `forGroup()` is convention only, not enforcement | document the architecture model in header comment |
| **F-G1** | `routes/groups.ts` (40+ refs) | high `group_members` reference count, lint-coverage risk | deploy `rg 'group_members' workers/routes/ \| grep -v forGroup` CI rule |
| **F-G2** | `routes/groups.ts:337` | `POST /:groupId/transfer` success-path no scenario | add `S-GROUP-3` |
| **F-C1** | `routes/contacts.ts:62` | `GET /` skips `filterVisibleUsers` (own contacts only) | document intent (own data); no code change |
| **F-M1** | `routes/mailboxes.ts:300, 382, 442, 527, 562` | 5× `void appendAudit(...)` swallows D1 errors | change to `await`; try/catch logs without re-throw |
| **F-COV-1** | `routes/mailboxes.ts:154` | `GET /availability` zero coverage | add `S-MAILBOX-3` |
| **F-COV-2** | `routes/mailboxes.ts:681, 694` | share/transfer autocomplete zero coverage | add `S-MAILBOX-4` |
| **F-I4** | `routes/invitations.ts:461` | `GET /autocomplete` zero coverage | add `S-INVITATIONS-3` |
| **F-I5** | `routes/invitations.ts:136-140, 206` | user-count read pre-insert; CF Access cap may transiently overshoot | document eventual-consistency; no code change |
| **F-N1** | `routes/notifications.ts:69-71` | expired invitations filtered in JS not SQL | move filter into WHERE clause |
| **XC-1** | `routes/groups.ts` (cross-cutting) | (already covered as F-G1) | (see F-G1) |

---

## 5. New Scenarios — coverage-gap recommendations

Aggregated across both reports + this consolidation. **12 new scenarios** close every named coverage gap.

| Scenario | Surface(s) | Priority | Source |
|:--|:--|:--|:--|
| `S-AUTH-OAUTH-TOKEN-1` | `oauth_refresh_token` UNIQUE | **high** | A (S-1) |
| `S-AUTH-OAUTH-CONSENT-1` | `consent.ts` clock-skew + sig + valid path | medium | A (C-1, C-4, C-5) |
| `S-AUTH-OAUTH-CONSENT-2` | plugin error body not reflected | medium | A (C-2) |
| `S-AUTH-OAUTH-CONSENT-3` | scope intersection enforced at lib | medium | A (C-3) |
| `S-AUTH-OTP-RATELIMIT` | `auth/index.ts` 429 after N attempts | low | A (A-3) |
| `S-GROUP-FORGROUPDISCIPLINE-1` | CI-lint catches direct group_members | high | A (CC-1, F-1) + B (F-G1) |
| `S-GROUP-3` | group ownership transfer success path | medium | B (F-G2) |
| `S-MAILBOX-3` | `GET /availability` (taken / invalid / available) | medium | B (F-COV-1) |
| `S-MAILBOX-4` | share+transfer autocomplete (visibility tiers, blocked excluded) | medium | B (F-COV-2) |
| `S-INVITATIONS-2` | `POST /:id/cancel` (inviter / non-inviter / already-accepted) | medium | B (F-I3) |
| `S-INVITATIONS-3` | `GET /autocomplete` (nobody-tier, blocked) | low | B (F-I4) |
| `S-ADMIN-1` | `admin/settings.ts` GET + PATCH (read, update, bad key, non-admin) | high | B (F-AS1, F-AS2) |
| `S-ADMIN-2` | `admin/users.ts` GET + POST /invite (list, privacy invite) | high | B (F-AU1, F-AU2) |
| `S-ADMIN-3` | `admin/users.ts` POST /promote + /demote (cap, peer-protection, self-demote) | high | B (F-AU3, F-AU4) |
| `S-ADMIN-4` | `admin/users.ts` DELETE (owns-mailboxes 409, owner blocked, success) | high | B (F-AU5) |
| `S-ADMIN-USER-DELETE-1` | user delete with owned groups/mailboxes graceful handling | medium | A (S-4, S-5) |
| `S-MSG-THREAD-1` | thread tip integrity | low | A (DB-2) |

(Total = 17 — three more than the 12 footprint; some scenarios consolidate findings.)

---

## 6. Cross-cutting hardening themes — what the audit revealed about the project's shape

These are the patterns that recurred — i.e., the system-design-level lessons. Each is mirrored as a `lesson` node in Small World; verbatim in `LESSONS_LEARNED.md` Phase 3 update.

1. **Type-unsafe env access via `as unknown as Record<string, string>` is a pattern, not a one-off** (F-I2 + adjacent). The project's `Env` type in `workers/types.ts` is the security boundary. Bypassing it with an `unknown` cast and a string default is how `dev-fallback-hmac-key` got into production-shape code. **Prevention:** every binding goes in `Env`; cast bypass is a CI-blocker.
2. **Schema UNIQUE is not optional decoration; it's the security invariant for tokens, identifiers, and unique-by-business-rule columns** (S-1 + S-6 + S-9 + S-8 + parallel UNIQUE on `session.token`, `oauth_access_token.token`, `oauth_personal_access_token.tokenHash`). Non-unique index + business-level uniqueness expectation = silent dup risk. **Prevention:** review checklist for every new `.notNull()` text column → "is this a token/identifier/business-unique? → `.unique()`."
3. **Privacy tiers must be enforced at every discovery surface, not just the documented one** (F-C2 + V-2 + adjacent). `nobody`-tier is meaningful only if every endpoint that accepts a `user_id` checks it. The `/contacts/request` gap shows the chokepoint isn't structural; it's per-route. **Prevention:** every new endpoint that takes a `user_id` parameter routes through a single helper (`assertVisibleTo` or similar) before any other logic; a CI grep checks for raw `users.id ===` comparisons in route files.
4. **`forGroup` is documentation-only enforcement; the CI grep-lint is the actual guard, and it's not deployed** (CC-1 + F-1 + F-G1 + XC-1). The `forGroup()` factory returns a plain Drizzle handle. The architecture relies on the CI rule rejecting direct `drizzle()` calls outside `forGroup.ts`. **Prevention:** ship the lint rule; canary-test it (a deliberate violation must fail CI before the rule is "deployed").
5. **`void` audit-write swallows D1 errors silently for the highest-value mutations** (F-M1 — 5 occurrences). Mailbox share/transfer/delete are the highest-value forensic events; fire-and-forget is the wrong default. **Prevention:** `await appendAudit` always; if downstream failure must not fail the request, wrap in `try { await ... } catch (e) { logger.error(e) }` — never `void`.
6. **Coverage is a privilege-escalation surface in itself.** Seven medium-severity findings reduce to one root cause: `admin/users.ts` and `admin/settings.ts` together hold 7 of the most-privileged mutation handlers in the system, and **all 7 have zero scenario coverage**. **Prevention:** scenario-coverage gating in CI: every new handler under `routes/admin/*` requires at least one scenario assertion before merge.

---

## 7. Resolved Open Questions (for the record)

- **OQ-AIA-1, 2, 3** — already resolved in Phase 1 (no recent run artifacts; no prior tooling overlap; client out of scope).
- **OQ-AIA-4** — resolved 2026-05-05, default B. V-1 reduced from `high/correctness` to `medium/coverage`. Action: amend `USR-good-practice-2` text + audit-coverage-matrix line to read "3-tier".
- **A-1 (open-question #2 from Teammate A) — `INVITATION_HMAC_KEY`** — merged into F-I2 (Teammate B). Single owner.
- **A-1 (open-question #3 from Teammate A) — CI grep-lint deployment status** — confirmed undeployed via repo scan (no `.github/workflows/forgroup-lint.yml`); rolled into CC-1's punch-list line.
- **B's open-question #1 — D-aim-10 exact shape** — flagged as F-I1, escalated to user as a punch-list decision (item #6).
- **B's open-questions #4 + #5** — schema/index questions on `mailboxes.owner_user_id` index and `notifications` email-only invitations — neither rises to ranked-finding severity; rolled into the punch list as part of S-3 / DB-1 follow-on.

---

## 8. Status — handoff to hardening-fixes phase

**Phase 3 deliverables:** ✅ this report, ✅ Small World finding nodes (≥medium → ranked nodes; see graph), ✅ top-10 punch list (§3 above), ✅ LESSONS_LEARNED Phase 3 update.

**No code changes were made in this phase**, per **D-AIA-4**. Fixes are deferred to a follow-up plan whose Phase 1 will be: "harden the punch-list top-5 + bundle the schema migration + add the 8 admin-coverage scenarios."

**Suggested next session prompt (warm-up for `/forward`):** *"Phase 1 of agentic-inbox-hardening: implement punch-list items 1-4 (S-1 unique constraint + migration; F-I2 env type fix; F-C2 visibility check; A-1 trim fix). Single commit per item. Add `S-AUTH-OAUTH-TOKEN-1` and extend `S-CONTACTS-1` with the `nobody`-tier negative case."*

---

**End of consolidated audit report.**
