# Agentic Inbox — Multi-Tenant Fork

Voice-first email client running on Cloudflare Workers + Durable Objects + D1 + R2 +
Workers AI. Forked from the upstream `agentic-inbox` to layer in multi-tenant identity,
group-scoped mailboxes, and an admin panel.

This file is the project-scoped supplement to the workspace `CLAUDE.md`. Read both.

---

## Layout

```
agentic-inbox/
├── app/                  React Router 7 SPA
│   ├── assets/branding/    Logo + login hero (PNG, served via Vite asset URL)
│   ├── components/         Logo, Header, Sidebar, AgentSidebar, ComposeEmail, ...
│   └── routes/             home, login (dev), mailbox/*, settings, ...
├── workers/              Hono worker (Cloudflare Workers runtime)
│   ├── app.ts              Top-level router: /login, /logout, auth, authzContext, /api/*
│   ├── lib/mock-access.ts  Dev-mode JWT shim (header → cookie → env fallback)
│   ├── lib/authz-context.ts  Loads users + group membership from D1
│   └── ...
├── shared/               Types shared between client and worker
├── public/               Static assets served by the assets binding
│   ├── anai-mail-logo.png        Header lockup (mailbox+eye + wordmark)
│   └── anai-mail-login-hero.png  Login hero (two robots + navy mailbox)
├── scripts/              D1 migration helpers, etc.
├── wrangler.jsonc        Bindings: D1, R2, KV, Durable Objects, Workers AI
└── vite.config.ts        cloudflare-vite-plugin (remoteBindings: false for offline dev)
```

---

## Dev Login Flow (Mock Cloudflare Access)

Local development bypasses real Cloudflare Access and synthesizes JWT claims via
`workers/lib/mock-access.ts`. The shim resolves the active identity in priority order:

1. `X-Mock-User-Email` request header — used by automated tests.
2. `x-mock-user-email` cookie — set by the dev `/login` picker.
3. `BOOTSTRAP_DEV_EMAIL` env var — fallback for cookie-less requests.
4. `BOOTSTRAP_OWNER_EMAIL` env var — last resort, also used by the first-login
   promotion flow that grants Global Owner on first sign-in.

`.dev.vars` (gitignored) holds the mock-mode flag and bootstrap defaults:

```
CF_ACCESS_DEV_MODE=mock
BOOTSTRAP_OWNER_EMAIL=alice@actionnow.ai
BOOTSTRAP_DEV_EMAIL=alice@actionnow.ai
```

### Run the dev server

The Vite SSR runner is flaky against Workers; use the wrangler-on-built-artifacts
loop instead:

```bash
cd /Users/dev/ActionNowAI/agentic-inbox
npm run build
npx wrangler dev --local --port 8788
```

Then open `http://localhost:8788/login`.

### Pick an identity at /login

The picker renders three options:

- **alice@actionnow.ai** — global owner (matches `BOOTSTRAP_OWNER_EMAIL`).
- **bob@actionnow.ai** — non-bootstrap user, member of `g-mkt`.
- **Custom email** — free-form input. Existing D1 user → loaded; unknown email →
  403 (only `BOOTSTRAP_OWNER_EMAIL` may auto-promote).

POST `/login` sets:

```
Set-Cookie: x-mock-user-email=<encoded>; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800
```

Then 303s to `/`. The cookie is read on every subsequent request by `mockAccessShim`,
which builds the JWT and stores it on `c.var.jwt`. `authzContext` then loads the D1
user row and group memberships.

### Verify

```bash
# Pick bob
curl -s -c /tmp/jar.txt -d "email=bob@actionnow.ai" \
  http://localhost:8788/login -o /dev/null

# Confirm authzContext sees bob with marketing group membership
curl -s -b /tmp/jar.txt http://localhost:8788/api/__test__/whoami | jq .
# {"role":"user","group_ids":["g-mkt"], ... }
```

### Sign out

```bash
curl -s -b /tmp/jar.txt -c /tmp/jar.txt http://localhost:8788/logout -o /dev/null
# Clears cookie via Max-Age=0; 303 → /login
```

### Production

In prod (`CF_ACCESS_DEV_MODE` unset or != `mock`), `/login` 302s to
`${TEAM_DOMAIN}/cdn-cgi/access/login/${POLICY_AUD}`. The mock shim is never
loaded; real Cloudflare Access JWTs are validated upstream.

---

## Branding & Theme

- **Logo:** `app/assets/branding/anai-mail-logo.png` — horizontal lockup. Imported
  via `import logoUrl from "~/assets/branding/anai-mail-logo.png?url";` in
  `app/components/Logo.tsx` and rendered globally in `app/root.tsx`'s `Layout`.
  Also mirrored to `public/` so the worker can reference it from inline HTML
  (the `/login` picker).
- **Login hero:** `app/assets/branding/anai-mail-login-hero.png` (two robots +
  navy mailbox + glowing arc). Mirrored to `public/anai-mail-login-hero.png`
  for the inline picker.
- **Tokens:** Tailwind v4 `@theme inline` directive in `app/app.css` defines the
  Small World palette: cream/forest (light) and dark gray/Material green (dark)
  with 17 px panel radius. Header uses `bg-card border-b border-border sticky top-0 z-10`.
- **Known polish gaps (Session B+):**
  - Logo PNG has a non-transparent white background. Renders as a white card
    in dark mode. CSS filter (`dark:brightness-110 dark:contrast-95`) is interim.
  - Default button color (`bg-primary`) still resolves to Tailwind's default
    blue rather than SW forest green — the `+ New Mailbox` CTA is bright blue.
  - Kumo's `<Empty>` primitive emits its own classes that ignore the SW theme.

---

## Key Files

| File | Purpose |
|------|---------|
| `workers/app.ts` | Hono router — `/login` + `/logout` registered BEFORE auth middleware so unauthenticated users can reach them. |
| `workers/lib/mock-access.ts` | `mockAccessShim()` synthesizes JWT in dev. `readCookie()` URL-decodes cookie values. `deterministicUuid()` derives stable `sub` from email (FNV-1a → UUID shape). |
| `workers/lib/authz-context.ts` | Loads `users` + `users_groups` rows from D1 keyed by JWT `sub`. Promotes `BOOTSTRAP_OWNER_EMAIL` to global owner on first login. |
| `app/root.tsx` | `Layout` mounts `<Header />` globally so the logo appears on every authenticated route. |
| `app/components/Logo.tsx` | `<Link>`-wrapped `<img>` from `?url` import; `dark:brightness-110 dark:contrast-95` for dark mode. |
| `app/components/Header.tsx` | Logo on left at height=32. Conditional mailbox sub-controls based on `useParams().mailboxId`. |

---

## D1 Schema (Multi-Tenant Foundation)

11 tables — `users`, `groups`, `users_groups`, `mailboxes`, `mailboxes_groups`,
`emails`, `attachments`, `agent_runs`, `agent_run_steps`, `invitations`, `audit_log`.
Migrations live in `scripts/`. Apply locally:

```bash
npm run db:migrate:local
```

`alice@actionnow.ai` is seeded as global owner; `bob@actionnow.ai` as a regular
user in `g-mkt`. See action plan `agent/.research/action-plan-agentic-inbox-mtv2-foundation.md`.

---

## Test Endpoints (dev only)

- `GET /api/__test__/whoami` — returns the active `authzContext` (role + group_ids).
- `GET /login` — picker (mock) or 302 to Access (prod).
- `POST /login` — sets cookie, 303 to `/`.
- `GET /logout` — clears cookie, 303 to `/login`.

---

## Pending Sessions

Session A (theme + login picker) — DONE.
Session B (admin API + internal email router) — UPCOMING.
Session C (admin panel UI).
Session D (invitations + tokens).
Session E (production deploy).
