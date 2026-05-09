# Agentic Inbox — Multi-Tenant Fork (MTV2)

Voice-first email client running on Cloudflare Workers + Durable Objects + D1 + R2 +
Workers AI. Forked from upstream `agentic-inbox` to layer in **multi-tenant identity**,
**group-scoped mailboxes**, an **admin panel**, **agent-issued service tokens**, and a
**global-admin observability dashboard**.

This file is the project-scoped supplement to the workspace `CLAUDE.md`. Read both.

The canonical history of how this fork was built lives in the unified action plan
[`.research/action-plan-agentic-inbox-mtv2-unified.md`](./.research/action-plan-agentic-inbox-mtv2-unified.md)
(Phases 1–7, all green). The pre-MTV2 "Sessions A–E" checklist that used to live
here is **superseded** by that plan.

---

## Layout (Outlook three-pane shell)

The authenticated routes render inside `app/routes/_app.tsx` — a desktop-first three-pane
layout (mailbox tree rail · message list · reading pane). `/admin/**` keeps its own
two-pane layout (Phase 2 frozen).

```
agentic-inbox/
├── app/                  React Router 7 SPA
│   ├── ui/                 In-repo primitive library (Phase 1–6 ports of kumo
│   │                       on top of @base-ui/react). See app/ui/CLAUDE.md
│   │                       for the full variant tables.
│   ├── components/         Shell, mailbox-tree rail, dialogs, panels
│   ├── lib/                Client-side utilities
│   ├── routes/             Outlook shell + admin + per-mailbox routes
│   │   ├── _app.tsx          Shell layout (rail + list + pane)
│   │   ├── home.tsx          Domain picker + mailbox creator
│   │   ├── mailbox/...       Per-mailbox screens (settings, search, tokens)
│   │   ├── _app/contacts.tsx Phase 6 contacts page
│   │   ├── admin/            users, settings, tokens, observability
│   │   ├── groups/...        groups + members + invitations
│   │   └── i.$id.tsx         Per-message permalink
│   ├── routes.ts           Route registration (sanity-tested by
│   │                       app/routes/__route-registration.test.ts)
│   └── services/           api client + react-query hooks
├── workers/              Hono worker (Cloudflare Workers runtime)
│   ├── app.ts              Top router: /login, /logout, auth, authzContext, /api/*
│   ├── middleware/         authzContext (D1-backed identity resolution)
│   ├── routes/             admin, groups, tokens, observability, contacts
│   ├── lib/
│   │   ├── ai.ts             Workers AI helpers (DEV_MOCK_AI gates remote calls)
│   │   ├── tools.ts          Agent email tools (verify, draft, send)
│   │   ├── mock-access.ts    Dev-mode JWT shim (header → cookie → env fallback)
│   │   ├── mailbox-permissions.ts        Mailbox ACL predicates (Phase 4)
│   │   ├── mailbox-token-permissions.ts  Token ACL predicates (Phase 5; thin
│   │   │                                 wrapper over shared/permissions/)
│   │   └── visibility-filter.ts          Phase 6 contact visibility filter
│   ├── durableObject/      MailboxDO, EmailAgent, EmailMCP, AgentTokenLimiter,
│   │                       RevocationCache (per-user keying — D-V2U-7)
│   └── db/control-plane/   Drizzle schema + forGroup() row-isolation chokepoint
├── shared/               Code shared by client and worker
│   ├── folders.ts          Folder enum + system folder ids
│   ├── dates.ts            Date helpers
│   └── permissions/
│       └── agent-tokens.ts   canIssueToken / canRevokeToken — single
│                             source of truth (Phase 7 T7.7)
├── public/               Static assets served by the assets binding
├── scripts/              D1 migration helpers + lint guards
├── test/                 Playwright config + visual baselines
├── wrangler.jsonc        Bindings: D1, R2, Workers AI, 5 DO namespaces
└── vite.config.ts        cloudflare-vite-plugin (remoteBindings: false offline)
```

---

## Roles

| Role | Scope | Set by |
|------|-------|--------|
| `global_owner` | Full control over every workspace, group, mailbox, token, observability dashboard | `BOOTSTRAP_OWNER_EMAIL` first-login promotion |
| `global_admin` | Same as owner except cannot demote/promote owners | Admin panel (`/admin/users`) by an owner |
| `user`         | Own private mailboxes + group-shared mailboxes via `group_members` | Invite + accept (`/groups/.../invite`) |

`workers/middleware/authzContext.ts` is the only place that resolves a JWT into
`{ user_id, role, group_ids, authorized_mailbox_ids }`. Every D1 access flows through
`forGroup()` (the row-isolation chokepoint) — `scripts/lint/forgroup-bypass.sh` blocks
PR merges that bypass it.

---

## Agent token flow (Phase 5)

Service-token issuance for agents (mcp-remote, automation) lives at
`/admin/tokens` (admin-wide list) and `/mailbox/:mailboxId/tokens` (per-mailbox). The
worker mints a real Cloudflare Access service token (`workers/lib/cloudflare-access-service-tokens.ts`),
caches `cf_client_id` in D1 (`agent_tokens` table), and exposes the secret to the user
**once** via the IssueTokenDialog copy card.

Default duration: **90 days** (`OQ-V2U-4` — forces explicit rotation hygiene before the
dashboard's 1-year refresh complacency sets in). `IssueTokenDialog` exposes 30 d / 90 d
/ 1 y / forever preset chips.

Revocation flows through `routes/tokens.ts:/revoke`:
1. **RevocationCache** (per-user DO, D-V2U-7) marks `cf_client_id` revoked first —
   prevents race-window misses while the Cloudflare DELETE is in flight.
2. **AgentTokenLimiter** (per-token DO) revokes all live instances.
3. **Cloudflare DELETE** removes the upstream token (mocked in dev).

The hot path (`workers/middleware/authzContext.ts`) checks RevocationCache before
hitting D1 on every authenticated service-token request.

`canIssueToken` / `canRevokeToken` live in `shared/permissions/agent-tokens.ts`
(Phase 7 T7.7) so the rail's "Tokens" link and the worker's enforcement render from one
predicate.

---

## Observability (Phase 6)

`/admin/observability` is the global-admin-only dashboard. Three endpoints feed it:

- `GET /api/admin/obs/active-sessions` — RevocationCache + AgentTokenLimiter snapshots
  (10 s in-memory cache; aggregates per-user RevocationCache DOs)
- `GET /api/admin/obs/message-rate` — `audit_log` email-action counts over 24 h / 7 d / 30 d
- `GET /api/admin/obs/last-login` — every user with `last_login_at`
- `GET /api/admin/obs/audit` — paginated `audit_log` browser with action / actor /
  target / group / time-window filters

`audit.action` taxonomy now covers policy-mutation rows (`policy.create/update/delete`
from the admin/users router) so `audit_log` is the canonical local source — no
external Cloudflare audit feed needed regardless of Cloudflare tier (`OQ-V2U-3`
resolved 2026-05-03).

---

## Contacts + visibility (Phase 6)

`contacts` table holds per-user address-book rows; `visibility` column gates whether
each contact is visible to other workspace members. `workers/lib/visibility-filter.ts`
applies the visibility rule at every cross-user query so non-admins never see
private contacts that aren't theirs. `app/routes/_app/contacts.tsx` is the contacts
UI; `/api/users/me/visibility` is the per-user toggle.

---

## DEV_MOCK_AI (Phase 7 OQ-V2U-6)

`workers/lib/ai.ts` short-circuits `isPromptInjection` and `verifyDraft` to safe
defaults (no injection detected; draft unchanged) when `env.DEV_MOCK_AI === "true"`.
Set in `.dev.vars` for local dev so `npm run dev` + headed Playwright don't block on
the Workers AI binding's "remote: true" SSR call. **Production must NOT set this**
(it disables prompt-injection scanning and draft verification).

---

## Dev login (mock Cloudflare Access)

Local dev synthesizes JWT claims via `workers/lib/mock-access.ts`. Priority order:

1. `X-Mock-User-Email` request header — used by automated tests
2. `x-mock-user-email` cookie — set by the dev `/login` picker
3. `BOOTSTRAP_DEV_EMAIL` env var — fallback for cookie-less requests
4. `BOOTSTRAP_OWNER_EMAIL` env var — last resort, also used by the first-login
   promotion flow that grants `global_owner` on first sign-in

`.dev.vars` (gitignored) — see `.dev.vars.example` for the schema:

```
CF_ACCESS_DEV_MODE=mock
BOOTSTRAP_OWNER_EMAIL=alice@actionnow.ai
BOOTSTRAP_DEV_EMAIL=alice@actionnow.ai
DEV_MOCK_AI=true        # Phase 7 — dev only; never set in prod
```

### Run the dev server

The Vite SSR runner is flaky against Workers; use the wrangler-on-built-artifacts
loop:

```bash
cd /Users/dev/ActionNowAI/agentic-inbox
npm run mock:up    # one command: build + apply migrations + wrangler dev --local on :8788
```

Then open `http://localhost:8788/login`.

### Local preview vs production layouts

Under `MOCK_MODE=1`, the worker intercepts `/login` with the dev identity picker
(see "Picker" below). This is fast for scenario runs but doesn't show the
production-shaped React login (with Turnstile widget, mobile bottom-sheet on
`<md`, animated seam glow, OTP step, resend countdown).

Two URLs:

| URL | Renders |
|---|---|
| `http://localhost:8788/login` | Dev identity picker (default; what the scenario suite drives). |
| `http://localhost:8788/login?preview=react` | The real React `/login` route — exactly what production at `mail.actionnow.ai/login` serves. Use this for visual validation of layout / animation / mobile shape changes BEFORE deploying. |

`?picker=skip` is an equivalent alias for `?preview=react`. Both are gated on
`CF_ACCESS_DEV_MODE === "mock"`, which is forbidden in production, so the
escape hatch has zero production effect.

### Local-validate-then-deploy loop

```bash
# 1. Make changes (CSS, components, etc.)
# 2. Rebuild + reload (wrangler dev --local watches build/server/*)
npm run mock:build

# 3. Open the production-shaped page in your browser
open "http://localhost:8788/login?preview=react"

# 4. Iterate until happy. Then deploy:
git push origin main          # if you've merged to main
npx wrangler deploy           # canonical wrangler-deploy path
# (or invoke the cloudflare-deploy skill which runs the full pipeline
#  with the Key MCP token + post-deploy verify)
```

### Picker

- **alice@actionnow.ai** — global owner (matches `BOOTSTRAP_OWNER_EMAIL`)
- **bob@actionnow.ai** — non-bootstrap user, member of `g-mkt`
- **Custom email** — free-form input. Existing D1 user → loaded; unknown email →
  403 (only `BOOTSTRAP_OWNER_EMAIL` may auto-promote)

### Verify

```bash
curl -s -c /tmp/jar.txt -d "email=bob@actionnow.ai" \
  http://localhost:8788/login -o /dev/null
curl -s -b /tmp/jar.txt http://localhost:8788/api/__test__/whoami | jq .
```

### Production

In prod (`CF_ACCESS_DEV_MODE` unset or != `mock`), `/login` 302s to
`${TEAM_DOMAIN}/cdn-cgi/access/login/${POLICY_AUD}`. The mock shim is never
loaded; real Cloudflare Access JWTs are validated upstream.

---

## Deploy to production (Cloudflare) — CANONICAL

**Read this. Do not invent another path. Do not run `wrangler login`.**

**The mandatory deploy path is the `cloudflare-deploy` global skill
(`~/.claude/skills/cloudflare-deploy/SKILL.md`) or its companion Python
script `release/python/scripts/deploy_cloudflare.py`.** This is enforced by
the system-prompt rule `CLOUDFLARE DEPLOYMENT — USE THE cloudflare-deploy
SKILL ONLY` (reprimand-level). Every prior session that reached for
`wrangler login` lost time before circling back here.

### Agent path (in-session)

Use the `cloudflare-deploy` skill. The skill body has the exact tool
sequence: `mcp__key__tool_get_secret` → `mcp__process__run_task` with the
token in `env_vars`. Total: ~50–60 s wall-clock.

### Script path (human or agent)

```bash
# Default: deploy agentic-inbox with all gates
python3 /Users/dev/ActionNowAI/release/python/scripts/deploy_cloudflare.py

# Fast path (skip pre-deploy gates):
python3 /Users/dev/ActionNowAI/release/python/scripts/deploy_cloudflare.py \
    --skip-gates --verify https://mail.actionnow.ai/

# Dry-run (fetch token + check gates, don't actually deploy):
python3 /Users/dev/ActionNowAI/release/python/scripts/deploy_cloudflare.py --dry-run
```

The script does the 3-step Streamable HTTP MCP handshake against the Key
MCP (`initialize` → `notifications/initialized` → `tools/call
tool_get_secret`), exports the token as `CLOUDFLARE_API_TOKEN`, and runs
`npm run deploy`. Token never touches disk; structured `[STEP N/M]` /
`[OK]` / `[FAIL]` output for agent-parseable runs.

### Below this point, the historical detail (kept as belt-and-suspenders):

### One-command deploy

```bash
cd /Users/dev/ActionNowAI/agentic-inbox
CLOUDFLARE_API_TOKEN="$(get from key MCP — see below)" npm run deploy
```

That runs `react-router build` → `wrangler deploy` against the single
production environment defined in `wrangler.jsonc`. Target:
`https://mail.actionnow.ai` (custom domain) and the
`agentic-inbox.cloudflare-ascertain725.workers.dev` default. ~50–60 s
wall-clock per turn.

### Where the API token lives

The Cloudflare deploy token is stored in the Key MCP server. Agents fetch it
via the standard three-operation contract:

```
mcp__key__tool_get_secret(service="cloudflare", account="api-token")
```

Other related secrets in the same service (in case the worker config ever
needs them again):

```
mcp__key__tool_get_secret(service="cloudflare", account="policy-aud")
mcp__key__tool_get_secret(service="cloudflare", account="team-domain")
mcp__key__tool_get_secret(service="cloudflare", account="BETTER_AUTH_SECRET")
```

**Never** call the macOS `security` CLI directly. **Never** copy the token
into a tracked file or echo it back to the user. **Never** run
`wrangler login` — the API token via env var is the deploy path, full stop.

### Pre-deploy gates the agent should run

Before any deploy:

1. `git status -s` clean (or knowingly committed). `git stash list` empty.
2. `npm test` green (vitest, currently 362 / 362).
3. `npm run typecheck` — note: there are **2 pre-existing warnings about
   `MOCK_MODE` typing in `workers/types.ts` / `workers/mcp/index.ts`**.
   Wrangler-typegen widens it to `string` because `.dev.vars` declares it;
   the local `Env` declares it as `string | undefined`. This does NOT block
   deploy (`wrangler deploy` doesn't run tsc) and the runtime is safe
   (`mock-mode.ts` checks `=== "1"` — handles both undefined and string).
   Tracked but tolerated.
4. Local 27-scenario suite ≥ 27/27 across 3 cycles
   (`npm run scenarios:all`). See
   `cld-net/.research/test-findings-phase3-3.md` for the canonical baseline.
5. (Optional, recommended for product-code changes:) verify the change is
   committed locally on `feature/autonomous-local-testing` (no upstream is
   configured for this branch — that's intentional; commits stay local).

### Post-deploy verification

```bash
curl -sIL --max-redirs 0 https://mail.actionnow.ai/ | head -3
# expect: HTTP/2 302; location: https://actionnow.cloudflareaccess.com/cdn-cgi/access/login/...

curl -s -o /dev/null -w "%{http_code}\n" https://mail.actionnow.ai/__mock/health
# expect: 302 (CF Access gate). /__mock/* is doubly-protected: CF Access
# intercepts before the worker runs, AND isMockMode() returns false in prod.
```

If `mail.actionnow.ai` 302s to `actionnow.cloudflareaccess.com` you're
green. If you see a 200 with content, CF Access is misconfigured — surface
to the user immediately.

### History — why this section exists

The deploy procedure was first documented in
`cld-net/.research/action-plan-mail-actionnowai-platform.md:9` and
`cld-net/.research/action-plan-mail-actionnowai-auth.md:6`, but those files
are gitignored on the cld-net side, invisible to anyone reading
`agentic-inbox` directly. As a result agents kept reaching for
`wrangler login` and getting "not authenticated", forcing the user to
re-explain the API-token path. Pinning it here in the project's main
CLAUDE.md is the durable fix.

---

## Send policy — internal-delivery short-circuit + external_send_enabled

The send path lives in `workers/lib/tools.ts` (`toolSendEmail`, `toolSendReply`)
and `workers/lib/internal-delivery.ts`. Decision tree per outbound message:

1. **Resolve destination** via `resolveMailboxBackend(env, toAddress)`
   (`workers/lib/email-helpers.ts`). Hits D1 first, R2 v1 second.
2. **Internal → bypass Cloudflare Email Routing entirely.** If the destination
   address is registered in either D1 or R2, `deliverInternal()` writes
   straight to the destination MailboxDO INBOX (`workers/durableObject/`) and
   appends an `audit_log` row. One round trip; no per-destination CF
   verification required; mirrors the inbound catch-all email handler.
3. **External → gated by per-mailbox `external_send_enabled`.**
   `mailboxes.external_send_enabled` (D1, migration 0010) defaults to `0`.
   When false, the send is rejected with a clear error pointing the user to
   `/mailbox/:id/settings → Outbound`. When true, the send falls through to
   `env.EMAIL.send()` (Cloudflare Email Routing).
4. **CF Email Routing destinations must still be pre-verified.** This is the
   one limitation we did not paper over — see `D-AIPH-5` in the Phase 3
   action plan. With `external_send_enabled=true` and an unverified
   destination, the user sees the standard `"destination address is not a
   verified address"` message. In-app delivery covers every internal route,
   so the verification surprise only surfaces for genuinely external sends.

### Dual-stack reconciliation (D1 + R2 v1)

Two mailbox stacks coexist: D1 (`mailboxes` table; UUID-keyed; per-user
ACLs) and the legacy R2 v1 bucket (`mailboxes/<address>.json`; address-keyed;
no ACL). The system unifies them at the **request layer**, never the data
layer (`D-AIPH-1`). Three reconciliation points landed in Phase 3:

| Surface | File | What it does |
|---|---|---|
| `requireMailbox` middleware | `workers/index.ts` | Resolves `:mailboxId` from D1 (UUID OR address) before falling back to R2; sets `c.var.resolvedMailboxAddress` for downstream `/api/v1/mailboxes/:mailboxId/*` handlers. |
| `lookupMailboxV1()` | `workers/index.ts` | Same resolution for the bare `GET /api/v1/mailboxes/:mailboxId` (root, no sub-path). |
| `verifyMailbox()` (MCP) | `workers/mcp/index.ts` | Returns the resolved address; each tool reassigns its `mailboxId` parameter so `getMailboxStub` keys the correct DurableObject (DOs are address-keyed). |
| `/api/mailboxes/tree` extension | `workers/routes/mailboxes.ts` | Appends R2-only mailboxes to `tree.private` after de-duplication, so the home sidebar shows the union. |

DOs are keyed by **address** via `idFromName(address)`. Always resolve UUID
→ address before constructing a stub.

### MCP tools that expose send/list/etc.

`workers/mcp/index.ts` registers 13 tools. Every one except `list_mailboxes`
goes through `verifyMailbox` for the mailboxId it receives — which now
accepts D1 UUIDs, D1 addresses, and R2 addresses interchangeably. If you add
a new tool, follow the same pattern (`const __vm = await verifyMailbox(...);
if ("isError" in __vm) return __vm; mailboxId = __vm.address;`).

---

## D1 schema (foundation Phase 2.1, in production)

11 tables — `users`, `contacts`, `groups`, `group_members`, `group_invitations`,
`mailboxes`, `mailbox_groups`, `agent_tokens`, `agent_instances`, `settings`,
`audit_log`. Every cross-tenant row carries `group_id`. `forGroup()` is the only
authorized chokepoint; `scripts/lint/forgroup-bypass.sh` blocks PR merges that
bypass it.

Seeded users: `alice@actionnow.ai` (global_owner), `bob@actionnow.ai`
(regular user, member of `g-mkt`).

Apply migrations locally:

```bash
npm run db:migrate:local
```

---

## Mobile-first patterns (mobile-native-redesign, Phase 1–3, 2026-05-08)

The auth surface and shared primitives now follow a mobile-first contract.
Decisions tracked under D-MNR-1..5 + D-MOBILE-1 + D-CSP-1..2 in
[`DECISIONS.md`](./DECISIONS.md). Lessons under L-2026-05-08a..e in
[`LESSONS_LEARNED.md`](./LESSONS_LEARNED.md).

### Size-tier table (Input + Button)

`app/ui/{input,button}.tsx` expose five size tiers; pick by tap-target
floor and visual hierarchy:

| Tier | Height | Font-size | Use for |
|---|---|---|---|
| `sm` | h-8 (32px) | inherits `text-base` (kumo-overridden to 14px) | Compact internal UI; admin tables. |
| `base` | h-9 (36px) | inherits `text-base` (14px) | Default; back-compat with pre-redesign callsites. |
| `md` | h-10 (40px) | inherits `text-base` (14px) | Mid-density desktop forms (settings, dialogs). |
| `lg` | h-11 (44px) | `text-[16px]` literal | Mobile inputs / buttons — meets iOS HIG + Material 3 tap-target floor; the literal `text-[16px]` bypasses iOS Safari zoom-on-focus. |
| `xl` | h-14 (56px) | `text-[16px]` literal | Primary CTA; one per surface. |

The auth surface (`app/routes/{login,consent}.tsx`) uses `lg` for the
email input and `xl` for the primary CTA. Other mobile-facing surfaces
should follow the same pattern. Don't reach below `lg` for any
input or button visible on mobile without a documented reason.

### `MobileBottomSheet` (`app/components/MobileBottomSheet.tsx`)

Mobile-only bottom-sheet shell. At viewports `<md` (`<768px`) it
snaps to the lower 75% of the viewport and anchors content in the
thumb-zone. At `≥md` it renders nothing — the desktop surface uses
its own layout (e.g. centered card). Used by the email + OTP steps
on `/login`.

```tsx
<MobileBottomSheet>{authForm}</MobileBottomSheet>
{/* desktop card sits behind, visible only at md+ */}
<div className="hidden md:block">{authForm}</div>
```

Test scaffolding: `MobileBottomSheet.test.tsx` covers the snap point
and the `<md` / `≥md` visibility split.

### `OTPInput` (`app/ui/otp-input.tsx`)

Six discrete digit boxes implementing the native OTP pattern. Paste
of a 6-digit string spreads across boxes; typed digits auto-advance;
backspace on an empty box pulls focus left; the
`autoComplete="one-time-code"` attribute lives on a hidden master
input so iOS Safari's keyboard suggestions populate the entire
string. Use this everywhere a 6-digit code is collected.

```tsx
<OTPInput value={otp} onChange={setOtp} onComplete={handleVerifyOtp} />
```

### `ResendCountdown` (`app/components/ResendCountdown.tsx`)

30-second countdown affordance for OTP resend. Disables the button
during countdown; shows the seconds remaining; calls `onResend()`
on click after the countdown expires. Required surface on every
OTP step. Phase 2 + T3.3 wires this into `handleResendOtp` in
`login.tsx`, which now also re-attaches the Turnstile token to
the resend fetch.

### Audit conventions

- **CSP / Trusted Types / script-loading audits** MUST run against
  the production-built path (`npm run build && wrangler dev --local`
  via `npm run mock:up`), NEVER against the Vite dev server. Vite's
  HMR runtime injects unnonced inline scripts that look like
  violations but aren't part of the production code path. See
  `D-CSP-2` + `L-2026-05-08d`.
- **Visual regression sweeps** run via
  `scripts/mobile-audit-phase3.sh` — 4 viewports
  (iPhone 14 Pro 393×852, iPhone SE 375×667, Pixel 7 412×915,
  iPad mini 768×1024) × 2 routes (`/login`, `/`). Outputs to
  `.scratch/mobile-audit/post-phase-3/` (gitignored). Pre-redesign
  baseline lives at `.scratch/mobile-audit/post-phase-1/` for
  comparison.
- **Lighthouse mobile-PWA gate** (`>=90`) runs on every PR + main
  push via `.github/workflows/lighthouse-pwa.yml`.

---

## Tests

- **Unit:** `npm test` (vitest) — currently **336 tests** across 31 files
  (workers + app/ui + app/components + app/routes). After T3.3, **+4**
  for `app/services/telemetry.test.ts`.
- **Visual:** `npm run test:visual` (Playwright) — locked baselines in
  `test/visual/__screenshots__/`. Re-locked after Phase 4 (intermediate) and
  Phase 7 (final, launch-time source-of-truth). Phase-3 mobile sweep is
  separate (`scripts/mobile-audit-phase3.sh`, see above).
- **Typecheck:** `npm run typecheck` runs `wrangler types` + `react-router typegen`
  + `tsc -b`. **Run this every phase boundary** — `react-router build` does NOT
  exercise the `workers/` tree's types (see L-2026-05-08e).

### Route-registration sanity (Phase 7 T7.8)

`app/routes/__route-registration.test.ts` fails fast if a `app/routes/**/*.tsx` file
exists on disk but isn't referenced from `app/routes.ts` (or vice-versa). Add an
`EXEMPT_FROM_REGISTRATION` entry there with a one-line reason if you intentionally
ship an unregistered file.

---

## Key files quick reference

| File | Purpose |
|------|---------|
| `workers/app.ts` | Hono router — `/login` + `/logout` registered BEFORE auth middleware. Mounts `/api/admin`, `/api/groups`, `/api/tokens`, `/api/admin/obs`, `/api/contacts`, `/api/users/me`. |
| `workers/middleware/authz-context.ts` | Loads `users` + `group_members` from D1 keyed by JWT. Service-token branch (Phase 5) checks RevocationCache + AgentTokenLimiter. Promotes `BOOTSTRAP_OWNER_EMAIL` to global owner on first login. |
| `workers/db/control-plane/forGroup.ts` | The row-isolation chokepoint. CI lint blocks bypasses. |
| `workers/durableObject/RevocationCache.ts` | Per-user revoked-set DO. Keyed by `agent_tokens.issued_to_user` (D-V2U-7). |
| `app/ui/` | Phase-1–7 ports of kumo on `@base-ui/react`. Variant tables in `app/ui/CLAUDE.md`. |
| `app/routes/_app.tsx` | Three-pane Outlook shell. |
| `shared/permissions/agent-tokens.ts` | `canIssueToken` / `canRevokeToken` — single predicate for client + worker (Phase 7 T7.7). |

---

## Pending sessions — superseded

The pre-MTV2 "Sessions A–E" checklist has been replaced by
[`.research/action-plan-agentic-inbox-mtv2-unified.md`](./.research/action-plan-agentic-inbox-mtv2-unified.md).
That plan is the canonical history of how MTV2 was built; Phases 1–7 are all
green as of the Phase 7 close-out commit.

---

## Phase A-D security audit — production-ready (2026-05-06)

The `feature/autonomous-local-testing` branch shipped 4 security phases in one continuous session: Phase A (deploy local backlog, `61da57c1`), Phase B (file-by-file walkthrough, surfaced 6 NEW P0 + 7 NEW P1 + 19 NEW P2 + ~22 BUG/EDGE), Phase C1+C2+C3 (close-out, `213dbbda` → `33c0cb63` → `06ed5671`), Phase D (full regression + production-ready claim).

**Net result:** 0 P0 / 0 P1 / 0 P2 / 0 BUG findings tracked open. 1046/1046 vitest. 36/37 × 3 cycles scenarios:all (S-INBOX-1 = documented Playwright flake). Worker `06ed5671` live on `mail.actionnow.ai`.

### Cross-cutting patterns surfaced

These show up everywhere in the codebase; treat them as first-class checks during any future security-adjacent change.

1. **Wildcard middleware mounts have gaps at bare paths.** Hono's `app.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox)` matches `:mailboxId/messages` and `:mailboxId/threads` but NOT bare `:mailboxId` (`PUT /api/v1/mailboxes/<id>`). Always pair the wildcard mount with a bare-path mount: `app.use("/api/v1/mailboxes/:mailboxId", requireMailbox)` immediately after. Phase C1's B-04 fix.
2. **Fail-OPEN catches are silent broken locks.** Every `} catch {}` in an authz / authn / rate-limit / revocation path is a failure mode where the wrong answer (allow) wins on uncertainty. Convert each to fail-CLOSED with an explicit status (503 + Retry-After for transient infra; 401/403 for ambiguous identity). Phase C2's A-05/A-06/C-03/D-02 fixes.
3. **Internal vs external delivery trust boundary.** When the system is BOTH the sender and the receiver — `internal-delivery.ts` short-circuits CF Email Routing — the inbound policy gates that protected `receiveEmail` did not apply. Internal sends could bypass spam/contact-status/policy checks. Phase C2's D-01 fix added the gates to internal delivery; Phase C3's BUG-D-1 then surfaced a related bug (R2-only existence check missing V2-D1-only mailboxes — silent inbound drop). The trust boundary lives at the *destination's policy*, not at the entry point.
4. **OAuth JWT must narrow as tightly as PAT.** When OAuth (JWT-bearer) and PAT (raw-token) are both valid auth methods, the harder one (OAuth) must respect the same per-mailbox / per-tool / per-IP scopes the easier one does. Phase C1's C-01 fix plumbed `buildAuthzContextFromUserId` into OAuth dispatch so JWT bearers narrow the same way PATs do.
5. **Wildcard-mount + new surface ≠ inheritance.** When you add a new mount path (`/agents/*`, V2 thread routes), the existing per-route gates do NOT automatically apply. Re-derive the authz needs from first principles for every new mount; don't assume sibling middleware covers you. Phase C1's C-02 + B-01/B-02 fixes.

### Deploy procedure (canonical)

`cloudflare-deploy` skill — one path, no exceptions. Token via Key MCP `cloudflare/api-token`, `npm run deploy` with `CLOUDFLARE_API_TOKEN` env var (token never lands on disk). Never `wrangler login`. Skip via `release/python/scripts/deploy_cloudflare.py [--skip-gates] [--dry-run]` for one-shot scripted deploys.

Pre-deploy gates (skill-enforced): clean git tree, `npm test` green, `npm run typecheck` (the 2 documented MOCK_MODE warnings tolerated), `scenarios:all` ≥27/37 across 3 cycles. Post-deploy: probe matrix per finding (curls confirming each closed exploit returns the expected 4xx).

### Post-deploy probe matrix (canonical)

For every security-relevant change, after deploy and before declaring done, run the following 6-probe matrix against `https://mail.actionnow.ai/`:

```bash
# A-01 invite gate
curl -fsS -X POST https://mail.actionnow.ai/api/auth/sign-in/email-otp \
  -H 'content-type: application/json' \
  -d '{"email":"never-invited@example.com"}'  # expect 403 (CF Access fronts; behind it, 403)

# B-01/B-02 V2 thread IDOR
curl -fsS https://mail.actionnow.ai/api/mailboxes/<other-user-mailbox>/threads/<id>  # 403

# B-03 V1 list narrowing — must return ONLY caller's authorised set
curl -fsS https://mail.actionnow.ai/api/v1/mailboxes -H 'authorization: Bearer <pat>'

# B-04 V1 bare PUT/DELETE
curl -fsS -X PUT https://mail.actionnow.ai/api/v1/mailboxes/<other-user-mailbox>  # 403

# C-01 OAuth JWT mailbox narrowing
curl -fsS -X POST https://mail.actionnow.ai/mcp \
  -H 'authorization: Bearer <jwt>' \
  -H 'content-type: application/json' \
  -d '{"method":"tools/call","params":{"name":"get_email","arguments":{"mailboxId":"<other-user-mailbox>"}}}'  # insufficient_scope

# C-02 EmailAgent authz gate
curl -fsS https://mail.actionnow.ai/agents/email-agent/<other-user-mailbox>  # 403
```

Discovery doc state: `auth_methods_supported = ["client_secret_basic"]` (no `"none"` for introspection); `registration_endpoint` absent (DCR not advertised, P1-7 stop-advertising).

### `scenarios:all` runner — per-agent isolation (post-2026-05-06)

The autonomous-local-testing runner now stamps every browser-mcp call with a stable `agent_id="agentic-inbox-scenarios"` (override via `SCENARIO_AGENT_ID` env). Each session is launched with `headed: false` per session, not via the process-wide `set_headed`. Two consequences:

- Cross-agent anonymous-namespace cross-talk is impossible — the runner's pool is private.
- One agent's autonomous tests cannot flip another agent's interactive headed window. Fix landed in `python/mcp/browser_mcp/` 2026-05-06 (per-session `headless` field on `Session`, `headed: bool | None` on `session_create`).

If a future CI runs scenarios on a fresh machine: nothing extra needed — `agent_id` defaults are sufficient; `npx playwright install chromium` is the only one-shot setup.
