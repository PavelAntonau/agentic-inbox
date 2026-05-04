# Mock Inventory — Remote Coupling in `agentic-inbox`

**Created:** 2026-05-03
**Purpose:** T1.1 of `action-plan-autonomous-local-testing.md` — enumerate every external touch the worker has so the MOCK_MODE layer can short-circuit them.
**Source data:** `.scratch/inventory/01-08-*.txt` (8 raw greps over `workers/`, `app/`, `shared/`).

---

## Headline finding

The app is **already 80 % mock-ready**. CF Access has a complete dev-mode mock (`workers/lib/mock-access.ts` + `CF_ACCESS_DEV_MODE=mock`); inbound email has a test ingest endpoint (`workers/routes/__test__/email-ingest.ts`); UI fetches are 100 % relative (`/api/...`). The remaining gaps are:

1. **AI binding** — 5 call sites, all in 2 files. Need a `MOCK_MODE=1` short-circuit returning canned responses.
2. **Outbound email** — 8 call sites, ~all funnel through `sendEmail(env.EMAIL, ...)` + 2 direct `c.env.EMAIL.send()` calls. Need helper-level interception → `.mock-state/outbox.jsonl`.
3. **CF Access management API** — 2 files (`cloudflare-access-policy.ts`, `cloudflare-access-service-tokens.ts`) hit `api.cloudflare.com`. Probably not exercised on the local UI loop, but guard them anyway.
4. **OTP delivery via email** — already routes through `env.EMAIL` → mocking `EMAIL.send()` in (2) automatically captures OTPs in `outbox.jsonl`. We add a tee to `.mock-state/otp.log` for browser-mcp scraping.
5. **OAuth issuer** — **NOT YET BUILT** (clients.ts has stub data; Phase 3 OAuth note in source). No mock needed yet; punt to scenario expansion when the feature lands.

---

## 1. Network surface

### 1a. UI → Worker (frontend `fetch()`)

All 67 frontend `fetch()` call sites use **relative paths** (`/api/...`). No remote domains. Local Miniflare worker fully serves them. **Zero mocking required on the UI side.**

Sample paths (representative):
- `/api/users/me`, `/api/users/search`, `/api/users/discover-by-email`
- `/api/mailboxes`, `/api/mailboxes/:id/policies`, `/api/mailboxes/:id/share`
- `/api/groups`, `/api/groups/:id/members`
- `/api/contacts`, `/api/contacts/:id/accept`, `/api/contacts/:id/block`
- `/api/admin/users`, `/api/admin/obs/audit`
- `/api/notifications/unseen`, `/api/invitations/:id/accept`
- `/api/users/me/clients`, `/api/users/me/sessions/revoke-others`
- `/api/auth/email-otp/send-verification-otp`, `/api/auth/sign-in/email-otp` (better-auth)

Source: `app/services/api.ts` is the only thin wrapper around `fetch`; everything else inlines `fetch("/api/...")`.

### 1b. Worker-internal (DO stubs)

`fetch()` against Durable Object stubs is part of the Workers runtime — Miniflare handles it natively, **no mocking needed**:

- `agentStub.fetch(new Request("https://agents/onNewEmail", ...))` — `workers/index.ts:406` (synthetic origin; routed by DO binding)
- `cacheStub.fetch(...)` / `limiterStub.fetch(...)` — middleware/authz-context.ts, routes/tokens.ts, routes/observability.ts, durableObject/tokens.test.ts
- `mcpHandler.fetch(c.req.raw, ...)` — workers/app.ts:220, 223 (MCP endpoint dispatch)

### 1c. Worker → Real internet

| Site | URL | Purpose | Mock target? |
|---|---|---|---|
| `workers/lib/cloudflare-access-policy.ts:43` | `https://api.cloudflare.com/client/v4/accounts/...` (GET policy) | Read CF Access policy info | YES — short-circuit to canned `{}` in MOCK_MODE |
| `workers/lib/cloudflare-access-policy.ts:60` | `https://api.cloudflare.com/.../policies` (POST) | Update CF Access policy | YES — short-circuit to canned `{ ok: true }` |
| `workers/lib/cloudflare-access-service-tokens.ts:53` | `https://api.cloudflare.com/.../service_tokens` (list/create) | Manage CF Access service tokens | YES — short-circuit to fixture list |
| `workers/lib/cloudflare-access-service-tokens.ts:99` | same | revoke service token | YES — short-circuit to `{ ok: true }` |

These two libs are the **only true remote calls** the worker makes. Both can be wholly disabled in MOCK_MODE; UI flows for autonomous testing don't currently exercise the CF Access management plane (it's an admin-only surface that may be off-screen entirely).

### 1d. Cloudflare Access (cdn-cgi/access/*)

All references to `cdn-cgi/access/...` are either:
- **JWT-validation middleware** in `workers/app.ts` (lines 53–203) — *already_ branched on `CF_ACCESS_DEV_MODE` with the `mockAccessShim()` taking over in dev.
- **Logout link** at `app/components/ProfileMenu.tsx:130` — `<a href="/cdn-cgi/access/logout">`. In MOCK_MODE this hits the real Access endpoint. Plan-level decision: rewrite the logout link to use `signOut()` (per existing `account.tsx:93` anti-regression note) OR teach the worker `/cdn-cgi/access/logout` route to clear the mock cookie and redirect.

---

## 2. AI binding (`env.AI`)

5 call sites total, fully isolated to 2 files:

| File:Line | Code | Model |
|---|---|---|
| `workers/lib/ai.ts:53` | `env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", ...)` | Llama 3.1 8B Fast |
| `workers/lib/ai.ts:165` | `env.AI.run("@cf/meta/llama-4-scout-17b-16e-instruct", ...)` | Llama 4 Scout 17B |
| `workers/agent/index.ts:278` | `createWorkersAI({ binding: env.AI })` | Workers-AI provider factory |
| `workers/agent/index.ts:283` | `workersai("@cf/moonshotai/kimi-k2.5")` (model selector) | Kimi K2.5 |
| `workers/agent/index.ts:336` / `:513` | same factory + model | Kimi K2.5 |

### Mock strategy

Add `if (env.MOCK_MODE === "1") return MOCK_AI_RESPONSE` at the top of:
- `workers/lib/ai.ts` exported functions (looks like 2 — likely `summarize`/`refine` or similar)
- `workers/agent/index.ts` Kimi-driven flows (these run inside a DO `EmailAgent`)

Canned responses:
- Classifier / category prediction → return deterministic label from input hash.
- Summarization → first 280 chars of input + `" [MOCK_SUMMARY]"`.
- Stream/AI SDK `ai` package usage in agent → return a fixed `UIMessage`-shaped reply.

### Imports inventory (for completeness)

```
workers/agent/index.ts:5    import { AIChatAgent } from "@cloudflare/ai-chat";
workers/agent/index.ts:11   import { ... } from "ai";
app/components/AgentPanel.tsx:26   import type { UIMessage } from "ai";
```

The `ai` package is also imported on the client (`AgentPanel.tsx`) as a type-only import — no runtime impact.

---

## 3. EMAIL binding (`env.EMAIL`)

8 call sites; 6 go through the `sendEmail()` helper, 2 are direct.

| File:Line | Path | Notes |
|---|---|---|
| `workers/email-sender.ts` | `sendEmail()` helper definition | THE chokepoint — mock here |
| `workers/index.ts:205` | `sendEmail(c.env.EMAIL, ...)` | Email-routing handler outbound (forward/reply) |
| `workers/auth/index.ts:260` | `sendEmail(env.EMAIL, ...)` | OTP email body — sent via `sendOtpEmail()` wrapper |
| `workers/lib/tools.ts:468` | `sendEmail(env.EMAIL, ...)` | MCP tool: send mail |
| `workers/lib/tools.ts:537` | `sendEmail(env.EMAIL, ...)` | MCP tool: forward / reply |
| `workers/routes/invitations.ts:226` | `if (c.env.EMAIL) {` (guard) | Invitation email — direct |
| `workers/routes/invitations.ts:243` | `await c.env.EMAIL.send({ ... })` | Direct call (bypasses helper) |
| `workers/routes/reply-forward.ts:91` | `sendEmail(c.env.EMAIL, ...)` | Reply outbound |
| `workers/routes/reply-forward.ts:177` | `sendEmail(c.env.EMAIL, ...)` | Forward outbound |

### Mock strategy

Patch `workers/email-sender.ts` itself: `sendEmail()` checks `env.MOCK_MODE` first and appends to `.mock-state/outbox.jsonl` (writable from a Workers runtime in dev via the test-routes pattern, or via R2 if filesystem isn't reachable).

Then patch `workers/routes/invitations.ts:243` to route through `sendEmail()` — eliminates the direct-call path AND fixes the inconsistency. (Side benefit: invitation emails now also go through the OTP-style branded HTML template if the helper provides one.)

Implementation note: the Cloudflare worker runtime cannot write to local FS. **`.mock-state/outbox.jsonl` must live in R2** (BUCKET binding already exists) under a known prefix, e.g. `__mock__/outbox/<timestamp>-<uuid>.json`. The smoke verifier reads back via the `BUCKET.list({ prefix: "__mock__/outbox/" })` path.

Alternative (simpler): in MOCK_MODE the helper logs the email to `console.log("[MOCK_EMAIL]", JSON.stringify(payload))` — the smoke verifier scrapes wrangler dev's stderr. This is what tests already do.

### Bonus: `cloudflare:email` import

Greps show NO `cloudflare:email` / `EmailMessage` imports in the worker. Email Routing is bound via the `send_email: [{ "name": "EMAIL" }]` wrangler config; the *inbound* path goes via the `email()` handler exported from `workers/app.ts:1131` and routes into `receiveEmail()` in `workers/index.ts`. **There is already a test-only ingest endpoint** at `workers/routes/__test__/email-ingest.ts` that calls `receiveEmail()` directly — the autonomous loop reuses this for inbound synthesis. **No new endpoint needed for inbound mocking.**

---

## 4. CF Access — already mocked (no work)

`workers/lib/mock-access.ts` is the dev shim. `workers/app.ts:165–206` already routes:

```ts
if (c.env.CF_ACCESS_DEV_MODE === "mock") {
  return mockAccessShim()(c, next);
}
```

The shim synthesizes a JWT from `X-Mock-User-Email` header / `x-mock-user-email` cookie / `BOOTSTRAP_DEV_EMAIL` / `BOOTSTRAP_OWNER_EMAIL` and uses a deterministic UUID for `sub`. The `/login` POST handler at `workers/app.ts:97–125` is the cookie writer. The `/login` GET handler at `:81–95` renders a branded mock-identity picker (lines 910–1116 — the `renderDevLoginPicker()` template).

**MOCK_MODE = 1 should imply CF_ACCESS_DEV_MODE = mock.** Either set both in `.dev.vars`, or have the worker treat `MOCK_MODE === "1"` as forcing the mock-Access branch.

---

## 5. OAuth + MCP discovery

| Marker | Status |
|---|---|
| `/.well-known/...` | Allowlisted as a public path in `workers/app.ts:25`. **No actual handler yet.** |
| `oauth_client_id` column on `clients` table | exists (`workers/db/control-plane/schema.ts:415`) |
| `workers/routes/clients.ts:111` etc. | reads/writes `oauth_client_id` but never validates it against an issuer |
| Source comment | `workers/routes/clients.ts:181`: *"Phase 3 OAuth registration will write real mcp clients; this endpoint serves stub data"* |

**Conclusion:** OAuth issuer mocking is NOT NEEDED for autonomous testing of the current feature surface. Defer until Phase 3 platform code lands. Open question OQ-AUTO-3 in the action plan resolves to: *"AI binding lives at `env.AI` in 2 files; OAuth issuer is not yet built — postpone OAuth mock to a later phase."*

---

## 6. OTP / better-auth

Better-auth is already wired at `/api/auth/*` (workers/app.ts:147–150). The OTP plugin (`emailOTP`) at `workers/auth/index.ts:184–192` calls `sendOtpEmail(env, email, otp, type)` which uses `env.EMAIL`. **Therefore mocking `env.EMAIL` automatically captures OTPs.**

For browser-mcp scraping, the agent reads `outbox.jsonl` (or wrangler dev stderr) and extracts the OTP code from the most recent message addressed to the test user.

UI flow (already implemented):
1. `app/routes/login.tsx` collects email → `POST /api/auth/email-otp/send-verification-otp`
2. Worker calls `sendOtpEmail()` → `env.EMAIL.send()` → MOCK_MODE captures the OTP
3. Browser-mcp reads OTP from sink, fills `<input>` → `POST /api/auth/sign-in/email-otp`
4. Better-auth returns session cookie; redirect to `/`

`emailOTP({ otpLength: 6, ... })` — 6-digit code. Easy to extract via regex `/\b\d{6}\b/`.

---

## 7. Existing mock infrastructure (DO NOT duplicate)

| Asset | What it does | Reuse? |
|---|---|---|
| `workers/lib/mock-access.ts` | Synthesizes JWT in dev | YES — keep as-is |
| `workers/app.ts:81–125` (`/login` GET/POST + picker) | Branded dev login picker writes cookie | YES — preset emails work for fixtures |
| `workers/routes/__test__/email-ingest.ts` | Direct inbound-email injector for tests | YES — extend as `/__mock/email-inbound` (or alias) |
| `CF_ACCESS_DEV_MODE` env var | Switches CF Access middleware to mock | YES — MOCK_MODE=1 should imply this |
| `BOOTSTRAP_OWNER_EMAIL=pavel@digifirst.org` (vars) | First-login auto-promotion to global_owner | YES — fixture user 0 |
| `BOOTSTRAP_DEV_EMAIL` (`.dev.vars`) | Default mock identity | YES |
| `vitest` test specs | 12+ unit tests already use `env.EMAIL` mocked at the helper layer | Reference for style |

---

## 8. Recommended MOCK_MODE design (refines plan Strategy C)

### Single env flag, three implications

`MOCK_MODE=1` (set in `.dev.vars` only — gitignored, never in production) **implies all three:**
1. `CF_ACCESS_DEV_MODE=mock` (force mock-Access shim)
2. AI calls return canned responses
3. Email sends route to `outbox.jsonl` (or stderr) + tee OTP log

### Files touched (Phase 1 implementation)

| File | Change |
|---|---|
| `.dev.vars` | Add `MOCK_MODE=1` (alongside existing `CF_ACCESS_DEV_MODE=mock`) |
| `worker-configuration.d.ts` | Add `MOCK_MODE: string` (regenerated from wrangler types — actually it's generated, so source the type from wrangler.jsonc `vars` if needed) |
| `workers/email-sender.ts` | Top-of-`sendEmail()` MOCK_MODE branch → R2 append OR `console.log`-style sink |
| `workers/routes/invitations.ts:243` | Route the direct `EMAIL.send()` call through the helper for consistency |
| `workers/lib/ai.ts` | MOCK_MODE branch at top of each exported function |
| `workers/agent/index.ts:278/336` | MOCK_MODE branch wraps `createWorkersAI` calls (or fakes the model) |
| `workers/lib/cloudflare-access-policy.ts` | MOCK_MODE → return fixture data without `fetch()` |
| `workers/lib/cloudflare-access-service-tokens.ts` | same |
| `workers/lib/auth.ts` (or new `workers/lib/mock-otp-sink.ts`) | Tee OTP from `sendOtpEmail` to `.mock-state/otp.log` |
| `workers/routes/__mock/reset.ts` | NEW — `POST /__mock/reset` truncates D1 tables, deletes DO state, reloads fixtures. Gated on MOCK_MODE. |
| `mocks/fixtures.ts` | NEW — 3 users, 4 inboxes, 6 contacts, 2 groups, 1 admin |

### Files NOT touched (already mocked)

- `workers/lib/mock-access.ts` — keep as-is
- `workers/app.ts` `/login` picker — keep as-is (preset emails will become the fixture identities)
- `workers/routes/__test__/email-ingest.ts` — extend later if needed; reuse for inbound synthesis

### Validation in dev

`MOCK_MODE=1 npm run dev` (alias `mock:up`):
1. App boots on `:8787` (Vite dev) or `:8788` (wrangler dev)
2. `GET /login` renders the picker (the existing branded one)
3. User clicks `pavel@digifirst.org` → cookie set → `GET /` → home view
4. Browser-mcp dispatches `POST /__mock/reset` first (idempotent fixture load)
5. Smoke flow: create inbox, send email, scrape `outbox.jsonl` from R2 / stderr, revoke client
6. Network capture (`browser_evaluate("performance.getEntriesByType('resource')")`) shows zero requests to non-localhost domains

### Deferred (Phase 2+)

- OAuth issuer mock — until Phase 3 OAuth registration is built.
- KV/R2/D1 mocking — Miniflare handles these for free; document only.
- WebSocket / SSE for real-time inbox updates — `routeAgentRequest` at `workers/app.ts:876–880` exists; mock if needed.

---

## 9. Open inventory questions (resolve in implementation)

| ID | Question | Default decision |
|---|---|---|
| INV-1 | Does `npm run dev` (which runs `react-router dev`) actually wire wrangler / Miniflare? | Verify in Phase 1.5 — if not, switch `mock:up` to bare `wrangler dev --persist-to .miniflare-state`. |
| INV-2 | Where to write outbox.jsonl from inside the worker — R2 or `console.log`? | Start with `console.log("[MOCK_EMAIL]", json)` (simpler, scraped from wrangler dev stderr); upgrade to R2 prefix `__mock__/outbox/` if the smoke verifier needs structured access. |
| INV-3 | Do agent SSE streams need MOCK_MODE? | If `EmailAgent` (DO) calls `env.AI.run` internally, yes — see `workers/agent/index.ts:278/336/513`. Wrap the model factory. |
| INV-4 | Is `BUCKET` (R2) reachable from `wrangler dev` without `--remote`? | YES — local R2 is Miniflare-backed when `--remote` is omitted (default). |
| INV-5 | Does the `/cdn-cgi/access/logout` link in `ProfileMenu.tsx:130` break the loop? | Probably — clicking it takes the browser off-app. Either teach the worker to route `/cdn-cgi/access/logout` in MOCK_MODE (clear cookie + 303 to `/login`) or rewrite the link. Pick the worker route — minimal blast radius. |

---

## 10. Next step (T1.2)

Decision document `.research/mock-mode-architecture.md` (T1.2 deliverable):
- Confirm Strategy C with the above refinements
- Define the wire format for `outbox.jsonl` entries
- Define the `/__mock/reset` endpoint contract
- Define fixture seed data (the 3 users, 4 inboxes, 6 contacts, 2 groups)

After that, T1.3 implements the 6 mock files, T1.4 adds fixtures + reset, T1.5 writes the smoke verifier. Phase 1 closes when `MOCK_MODE=1 npm run dev` boots clean and the smoke verifier exits 0.
