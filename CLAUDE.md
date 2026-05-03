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
npm run build
npx wrangler dev --local --port 8788
```

Then open `http://localhost:8788/login`.

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

## Tests

- **Unit:** `npm test` (vitest) — currently **336 tests** across 31 files
  (workers + app/ui + app/components + app/routes)
- **Visual:** `npm run test:visual` (Playwright) — locked baselines in
  `test/visual/__screenshots__/`. Re-locked after Phase 4 (intermediate) and
  Phase 7 (final, launch-time source-of-truth).
- **Typecheck:** `npm run typecheck` runs `wrangler types` + `react-router typegen`
  + `tsc -b`.

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
