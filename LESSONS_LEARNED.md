# Lessons Learned — agentic-inbox

A small, durable file. Each entry follows: **Context → Root cause → Fix →
Prevention.** Symptoms go in commit messages; this file captures the
underlying mental models so the next agent doesn't re-derive them.

---

## L-2026-05-05 — Schema UNIQUE is the security invariant for tokens and identifiers; non-unique index is silent danger

**Context.** The `agentic-inbox-audit` Phase 2 static review (`.research/audit-auth-permissions.md`) found
**one critical finding** — `oauth_refresh_token.token` declared with `notNull()` and a non-unique index but
no `.unique()` — sitting two columns away from `oauth_access_token.token` (line 594) and `session.token`
(line 292), both of which DO have `.unique()`. The same pattern recurs three more times: `account.(provider_id, account_id)`
(S-6), `verification.identifier` (S-9), `groups.(owner_user_id, name)` (S-8). Four instances of the same near-miss
in a schema that otherwise gets it right.

**Root cause.** The mental rule "if a `notNull()` text column carries a token, an external identifier, or
business-level uniqueness — `.unique()` is the security invariant, not decoration." The four misses all dropped
that rule, leaving lookups by that column ambiguous: any race in token rotation, migration error, or direct-SQL
path can produce duplicate rows that the application reads as a single arbitrary match. For refresh tokens that
silent-duplicate condition is **token replay**: two valid rows for one token, both accepted by rotation, two
access tokens issued for one refresh. **The pattern was correct on adjacent columns** — meaning the rule was
known, just inconsistently applied. That makes it a review-checklist gap, not a knowledge gap.

**Fix.** S-1 fix: `token: text("token").notNull().unique()` + Drizzle migration. The migration must check
for existing duplicates BEFORE adding the constraint (production failure mode is a partial-add that leaves
the schema in a half-constrained state). The cluster fix (S-1 + S-6 + S-8 + S-9) bundles into one migration —
better than four separate ones because the schema-discipline lesson is the same and one migration is one
deploy risk.

**Prevention.**
- **Review checklist for every Drizzle schema PR.** For each new `text("...").notNull()` column, the reviewer
  asks: "is this a token / external identifier / business-unique?" If yes, `.unique()` (or `uniqueIndex`) is
  mandatory.
- **The audit-finding graph node `S-1` (Small World id `ABfhYiMFim3q0u77iasH2`)** + lesson `L-AIA-2`
  (`e5uYaFJqnWiCIYo9Eufxb`) carry this rule across sessions — the next session sees them on `search_knowledge`
  before re-deriving.
- **Adjacent-column heuristic.** When auditing schema, look at adjacent same-table columns; if some carry
  `.unique()` and others don't, the divergence is the audit signal. Three of the four findings in this cluster
  were caught precisely by reading adjacent column properties together.

---

## L-2026-05-05 — Privacy-tier enforcement is per-route discipline; the lib helper is not a chokepoint

**Context.** `D-aim-12` defines a `nobody`-tier visibility ("hidden from non-contacts, non-co-members") and
the `agentic-inbox-audit` Phase 2 traced its actual enforcement points. Result: `routes/invitations.ts` and
`routes/mailboxes.ts` correctly call `getVisibilityFilteredUsers` (which wraps `filterVisibleUsers`); `routes/contacts.ts`
**does not** — `POST /api/contacts/request` (line 101) skips the visibility check entirely (F-C2, severity:high).
Plus the helper's own `enforceContactsAndNobody` flag defaults to `false` (V-2), so any new caller that omits the
flag silently re-enters the unfiltered Phase-3 mode. Two real privacy bypasses, both caused by the same shape:
**the privacy invariant lives in route code, not in a chokepoint**.

**Root cause.** `filterVisibleUsers` is named like a chokepoint and lives in `workers/lib/visibility-filter.ts`,
but it is structurally **just a helper function**. There's no compile-time mechanism that forces every endpoint
accepting a `user_id` to call it; there's no runtime gate; the default-false flag means even the helper itself
is opt-in. So a developer adding `POST /contacts/request` who reasons "this is a permission check — `canSendContactRequest`
covers it" gets to a working, tested-looking endpoint that nevertheless leaks `nobody`-tier user existence to anyone
who knows the target's `user_id`. **The privacy decision (`D-aim-12`) was made; the enforcement chokepoint to back
it up was never built.**

**Fix.** F-C2 fix: after `targetUser` lookup in the `request` handler, return privacy-preserving `404 { error: "User not found" }`
when `targetUser.visibility === 'nobody'` AND actor is neither co-member nor accepted-contact. V-2 fix: flip
`enforceContactsAndNobody` default from `false` to `true`; add explicit `false` overrides on any future Phase-3-mode
callers (none today; admin-panel listing would be a candidate). Combined fix is two small edits — but the durable
shape change is the next item.

**Prevention.**
- **Make the chokepoint structural.** Extract a single `assertVisibleTo(actor, target_user_id)` helper that
  every endpoint accepting a `user_id` parameter must call before any other logic. Code review enforcement: every
  new route handler that takes a `user_id` parameter MUST call `assertVisibleTo` early in the handler — not via
  `canSendContactRequest` / `canBlockUser` which are permission checks, not visibility checks.
- **CI grep.** `rg "users\.id\s*===" workers/routes/` should produce zero hits. Raw user-id comparisons in routes
  are the symptom of bypassing the chokepoint.
- **Flag default-false for safety-relevant config.** `enforceContactsAndNobody?: boolean` defaulting to `false`
  is a privacy-regression timebomb. Default-true; require explicit `false` for the rare contrary case.
- The audit-finding graph nodes `F-C2` (`HejuxD6Ia0YOZP805meVV`) and `V-2` (`WeRwoOrlfegljcXaBDCKk`) + lesson
  `L-AIA-3` (`JUz0dO13fGpPwtUGG6Qve`) preserve this rule for cross-session search.

---

## L-2026-05-05 — Scenario coverage is a privilege-escalation surface; orphan handlers are unsafe by default

**Context.** Of the 30 scenarios in `scripts/scenarios/`, **none** exercise `workers/routes/admin/users.ts`
(5 handlers — promote, demote, delete, invite, list) or `workers/routes/admin/settings.ts` (2 handlers — read,
PATCH). Phase 2 audit found that the handlers' admin-role guards and `canAct` peer-protection logic look
correct on inspection — but every one of those 7 mutation paths (some of which alter global role) is unverified
by any executing scenario. Per Teammate B's report: this is the **highest-privilege mutation surface in the
system, with zero scenario coverage**. Plus a real correctness defect (F-AU3): `parseInt(adminCap)` on a malformed
settings row returns `NaN`, the cap-check `NaN >= NaN` is `false`, the cap silently fails open. Static review
caught it; no test would have, because no test exists.

**Root cause.** "Coverage" was treated as a quality goal, not a security gate. New handlers shipped behind their
admin guards; the missing scenario was filed as a coverage gap, not a privilege risk. Over time, **seven of the
most-privileged handlers in the codebase ended up in the orphan-surface bucket together**. The category cluster
isn't a coincidence; it's a workflow signal — admin routes are typically built last, scenarios written second-last,
and "we'll add scenarios in the next sprint" silently turns the most-sensitive code path into the least-tested one.

**Fix.** Eight new scenarios: `S-ADMIN-1` (settings read+PATCH+enum/cap validation), `S-ADMIN-2` (users list+invite),
`S-ADMIN-3` (promote+demote with cap + peer-protection), `S-ADMIN-4` (delete with owns-mailboxes/owner-blocked/success),
plus `S-INVITATIONS-2`, `S-MAILBOX-3..4`, `S-INVITATIONS-3` for the lower-privilege orphan handlers. F-AU3 correctness
fix: `if (isNaN(adminCap)) return c.json({error:"Server misconfigured"}, 500)` — fail closed when cap is unparseable,
not open. F-AS2: per-key `MAX_VALUES` map enforces upper bounds (suggested ceilings recorded in the audit report).

**Prevention.**
- **CI gate on `routes/admin/*`.** Every new handler under that prefix requires at least one scenario assertion
  in the same PR. Diff-coverage check: `git diff --name-only origin/main | grep '^workers/routes/admin/' | xargs -I{} rg
  "{}" scripts/scenarios/` returns at least one hit per added handler.
- **Fail-closed parsing of security-relevant settings.** `parseInt`, `JSON.parse`, env-var reads — when the result
  feeds a cap or a permission check, `NaN` / `null` / undefined must NOT silently mean "no cap" or "all access."
  Default to `500 misconfigured` and let an admin notice.
- **Treat orphan-surface lists as deploy blockers, not nice-to-haves.** A handler shipping without coverage to a
  production-shape branch is a coverage debt that compounds; scenarios are part of the handler, not a follow-up task.
- The audit-finding graph nodes `F-AS1`, `F-AS2`, `F-AU1..F-AU5`, `F-I3` (all linked from project
  `Nj4GAT_PYMKZY8OAC7AIy`) + lesson `L-AIA-6` (`GAlG1w8c5ynQ58lTlYlQX`) preserve this cluster for future sessions.

---

## L-2026-05-04 — Dual-stack reconciliation belongs at the request layer, not the data layer

**Context.** Production carries two mailbox stacks: a D1 control plane
(UUID-keyed rows in `mailboxes`, per-user ACLs) and a legacy R2 v1 bucket
(`mailboxes/<address>.json`, no ACL). Phase 1 of MTV2 added D1 alongside R2
without picking a migration; both kept running. The 2026-05-04 production
E2E session surfaced four bugs whose common root cause was the same:
**routes, helpers, and tools each picked one stack and silently failed for
the other.** `/api/v1/mailboxes/:UUID` was R2-only and returned 404 for D1
UUIDs. The MCP `verifyMailbox` helper was R2-only, so every MCP tool except
`list_mailboxes` failed for D1 mailboxes. The home sidebar was D1-only, so
the v1 mailbox was rendered as a stranded mid-page card.

**Root cause.** Each surface tried to "know which stack to use" by
inspecting the input shape (UUID vs. address), the URL pattern, or — worst
— the `kind` field on a row that did not exist yet. No single resolver, no
single chokepoint. Phase 2 added one resolver
(`resolveMailboxBackend(env, address)`) and adopted it in two places
(`toolListMailboxes`, the legacy `/api/v1/mailboxes` list endpoint), but
left the per-mailbox surfaces inconsistent — half-fixing the bug. Half-fix
**is** the bug class.

**Fix.** Phase 3 closed the loop at four request-layer chokepoints, every
one routed through `resolveMailboxBackend` (or its UUID-aware sibling) and
every one returning the canonical address that `idFromName` consumes:
- `requireMailbox` middleware in `workers/index.ts` — already done in Phase
  2 for `/:mailboxId/*`, only the root needed catching up.
- New `lookupMailboxV1()` for the bare `GET /api/v1/mailboxes/:mailboxId`.
- New `verifyMailbox()` in `workers/mcp/index.ts` that returns the resolved
  address; each tool reassigns its `mailboxId` parameter so the downstream
  `getMailboxStub(env, mailboxId)` builds the correct DO key.
- Extended `/api/mailboxes/tree` to merge R2-only legacy mailboxes into
  `tree.private` after de-duplication.

**Prevention.**
- **One resolver, one signature.** Anything that takes a "mailbox id"
  string anywhere in the worker MUST go through `resolveMailboxBackend`
  (address path) or `verifyMailbox` (MCP path) before talking to a DO,
  D1 row, or R2 object. Treat raw `mailboxId` like raw user input.
- **Reconcile at the request layer.** D1 UUIDs and R2 addresses are
  external-facing identifiers; the storage layer doesn't have to know.
  Adding a `kind` column on D1 only papers over the question.
- **Half-fix is the bug.** When a fix lands at one of N similar surfaces,
  enumerate the other N-1 in the commit message AND verify each in the
  retest. The retest is what exposes the gap.
- **Production retest is a real phase, not a victory lap.** Phases 1+2
  were green on local (419 unit tests, 27 scenarios × 3) but production
  exposed gaps the local mock couldn't reach because the mock itself uses
  one stack only. Until the local harness covers both, the production
  retest is the only source of truth for cross-stack regressions.

---

## L-2026-05-04 — Cloudflare Email Routing demands verified destinations; in-app delivery skips that toll

**Context.** F-PROD-MAIL-1: a `testbox → testbox` internal loopback test
on production failed with `"destination address is not a verified address"`.
The user's reaction was unambiguous: *"only within our application … move
and implement everything you possibly can within our application,
especially all those email-related features that can be managed
internally"* (USR-directive-2). Calling `env.EMAIL.send()` for a
destination we already host is wasted CF Email Routing surface area and
forces every mailbox owner through an out-of-band CF dashboard
verification ritual.

**Root cause.** Pre-fix, every send went through `env.EMAIL.send()`
regardless of whether the destination was one of our own mailboxes. CF
Email Routing then enforced its blanket rule: "destination must be in the
account's verified destination list." There is no exemption for
intra-account loopback.

**Fix.** Phase 1 added `workers/lib/internal-delivery.ts`
(`deliverInternal()`) and a destination-resolution step in `toolSendEmail`
/ `toolSendReply`. When the destination resolves to D1 OR R2, the message
is written straight to the destination MailboxDO `INBOX` via
`createEmail()` and an `audit_log` row is appended; CF Email Routing is
never consulted. Phase 1 also added per-mailbox `external_send_enabled`
(D1 migration 0010, default `0`) so external sends require an explicit
opt-in toggle in `/mailbox/:id/settings → Outbound`. Phase 3 confirmed
the loopback test green in production.

**Prevention.**
- **Never call `env.EMAIL.send()` for a destination we already host.**
  Resolve first, short-circuit if internal, fall through only for
  external + flag-on. The `decideSendPolicy()` helper encapsulates this;
  every send path uses it.
- **Default to internal-only.** New mailboxes ship with both
  `external_send_enabled=0` and (in spirit) `external_inbound_enabled=0`
  — the user opts into external behavior explicitly. Existing rows keep
  their inbound flag so live production isn't silently downgraded
  (D-AIPH-3).
- **CF destination verification is a real limitation, not a bug.**
  Document it in CLAUDE.md and surface a clear in-app message that
  points the user at the toggle. Don't push the user to the CF
  dashboard (USR-directive-3, AI-1).

---

## L-2026-05-04 — A 600 s ProcessMCP timeout on `npm run mock:up` cascades into 14 spurious test failures

**Context.** Cycle 3 of the local `scenarios:all` × 3 baseline produced 13
PASS + 14 FAIL — every failure after `S-MSG-5` showed `fetch failed` on
`http://127.0.0.1:8788/__mock/reset`. The runner correctly classified it
as a "transport wedge" but couldn't recover. Investigation showed the
cycle-3 failures all timestamped after the mock worker's parent
ProcessMCP task hit its 10-minute (`timeout=600`) ceiling and was killed
mid-cycle. The 13 scenarios that ran before the mock died had passed.

**Root cause.** The mock worker is a long-running `wrangler dev` process,
not a one-shot. When I started it via `mcp__process__run_task` with
`timeout=600`, ProcessMCP enforced that ceiling and SIGKILLed the
process tree the moment cycle 3 was a third of the way through. The
cascade is structural: as soon as the worker dies, every subsequent
`/__mock/reset` fails, and every scenario starts with a reset.

**Fix.** Re-launched `npm run mock:up` with `timeout=1500` (25 min,
covers 3 cycles + setup + slack), confirmed reachable via
`/__mock/health`, re-ran cycle 3 → 27/27 PASS.

**Prevention.**
- **Long-running daemons need a long-running timeout.** Default
  `timeout=120` (2 min) is for one-shot commands; daemons need
  `timeout=1500` minimum for a 3-cycle workload, longer if the workload
  scales.
- **A "wedge detected — restarting browser-mcp" log line is a friction
  signal, not a recovery.** When the runner reports a transport wedge in
  the same scenario all-after-some-point, suspect the mock worker first;
  curl `/__mock/health` to confirm before treating the FAIL as a real
  regression.
- **Read the timestamps before re-running.** Failures clustered in a
  single 30-second window after a long PASS streak almost always trace
  to a single death event; one diagnostic call beats 14 retries.

---
