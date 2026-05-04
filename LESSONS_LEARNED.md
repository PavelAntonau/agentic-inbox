# Lessons Learned — agentic-inbox

A small, durable file. Each entry follows: **Context → Root cause → Fix →
Prevention.** Symptoms go in commit messages; this file captures the
underlying mental models so the next agent doesn't re-derive them.

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
