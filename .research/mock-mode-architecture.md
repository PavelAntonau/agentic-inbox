# MOCK_MODE Architecture — Local Autonomous Testing

**Created:** 2026-05-04
**Companion:** `.research/mock-inventory.md` (T1.1 deliverable)
**Purpose:** T1.2 of `action-plan-autonomous-local-testing.md` — choose the strategy, pick file layout, define wire formats, settle the env-flag conventions.

---

## 1. Strategy: env-flag short-circuit (Strategy C from action plan, refined)

A single env var, `MOCK_MODE`, gates every external call. When set to `"1"`:

1. **CF Access middleware** routes to `mockAccessShim()` (already implemented; we add `MOCK_MODE === "1"` as an extra trigger so users only need to set one var).
2. **AI calls** (`workers/lib/ai.ts` + `workers/agent/index.ts`) return canned responses.
3. **Outbound email** routes to a mock `SendEmail` binding that writes to a JSONL sink + an OTP-tee log.
4. **CF Access management API** calls (`api.cloudflare.com`) short-circuit to fixtures.
5. **`/__mock/*` endpoints** become available — `reset`, `outbox`, `otp-latest`, `inbox` (inbound synthesizer).
6. **Logout link** — server route `/cdn-cgi/access/logout` becomes valid in MOCK_MODE (clears `x-mock-user-email` cookie + 303 to `/login`).

**MOCK_MODE is set ONLY in `.dev.vars`** — gitignored, never deployed. The worker fails closed if MOCK_MODE leaks into production: every MOCK_MODE branch double-checks `c.env.CF_ACCESS_DEV_MODE === "mock"` so a misconfigured MOCK_MODE without a paired `CF_ACCESS_DEV_MODE` is inert.

### Why not Miniflare overrides (Strategy A)?

- `wrangler` config doesn't have a clean `[[mocks]]` block for AI / EMAIL bindings; the override knobs are limited.
- We'd lose the ability to script per-test scenarios (re-run with different fixture sets).
- Branch coverage requires *application-layer* MOCK_MODE branches anyway (e.g., "what does the route do when EMAIL.send throws?").

### Why not MSW (Strategy B)?

- MSW intercepts `fetch()` — but the worker's external surface is `env.AI.run()` and `env.EMAIL.send()`, NOT `fetch()`. MSW can't catch DO-style RPC bindings.
- The two `api.cloudflare.com` `fetch()` sites COULD be MSW'd, but introducing a separate mocking framework for two functions is wrong-sized.

### Why C wins

- Branches are visible in source (`grep MOCK_MODE` enumerates the entire surface).
- Fastest iteration: change a mock response, hit reload, no re-config.
- One file = one decision: `mocks/ai.ts` declares everything AI-related.
- Aligns with the existing `DEV_MOCK_AI` convention in `workers/lib/ai.ts`.

---

## 2. Env-var conventions

| Var | Values | Set where | Implies |
|---|---|---|---|
| `MOCK_MODE` | `"1"` (on) / unset (off) | `.dev.vars` only | All other mock vars are forced on |
| `CF_ACCESS_DEV_MODE` | `"mock"` / `"bypass"` / unset | `.dev.vars` only | Pre-existing; MOCK_MODE=1 forces `"mock"` |
| `DEV_MOCK_AI` | `"true"` / unset | `.dev.vars` only | Pre-existing in `lib/ai.ts`; MOCK_MODE=1 makes it implicit |
| `BOOTSTRAP_OWNER_EMAIL` | email | `wrangler.jsonc` `vars` | First-login auto-promotion (existing) |
| `BOOTSTRAP_DEV_EMAIL` | email | `.dev.vars` (optional) | Default mock identity (existing) |
| `MOCK_OUTBOX_PATH` | R2 prefix | `.dev.vars` (optional) | Default `__mock__/outbox/` |

### `.dev.vars` template (Phase 1 deliverable)

```
# Cloudflare Access — local mock mode
CF_ACCESS_DEV_MODE=mock
POLICY_AUD=local-dev
TEAM_DOMAIN=https://local-dev.cloudflareaccess.com

# Umbrella mock switch — set to 1 for autonomous local testing
MOCK_MODE=1

# Default mock identity (the picker overrides when the user/agent picks)
BOOTSTRAP_DEV_EMAIL=alice@actionnow.ai

# better-auth secret (any random string for local dev)
BETTER_AUTH_SECRET=local-dev-secret-not-a-real-secret-rotate-in-prod
```

### Helper

```ts
// workers/lib/mock-mode.ts
import type { Env } from "../types";

export function isMockMode(env: Env): boolean {
  return env.MOCK_MODE === "1";
}

export function isAiMocked(env: { AI: Ai; MOCK_MODE?: string; DEV_MOCK_AI?: string }): boolean {
  return env.MOCK_MODE === "1" || env.DEV_MOCK_AI?.toLowerCase() === "true";
}
```

`isAiMocked` keeps backwards compat with the existing `DEV_MOCK_AI` flag in `lib/ai.ts`; we update those two functions to use the shared helper.

---

## 3. File layout

```
workers/
  lib/
    mock-mode.ts          ← NEW — single source of truth for MOCK_MODE detection
    mocks/                ← NEW directory
      ai-responses.ts       canned AI replies (deterministic from input hash)
      email-binding.ts      mock SendEmail binding (writes to R2 + OTP tee)
      fixtures.ts           seed data: 3 users, 4 inboxes, 6 contacts, 2 groups, 1 admin
      cf-access.ts          fixture data for the policy + service-tokens API
      otp-tee.ts            extract OTP from outgoing mail and write to a separate sink
  routes/
    __mock/                ← NEW directory (test routes already in __test__/)
      index.ts              router — mounts /__mock/* with a MOCK_MODE guard
      reset.ts              POST /__mock/reset — truncate + reload fixtures
      outbox.ts             GET /__mock/outbox — list + filter outgoing mail
      inbox.ts              POST /__mock/inbox — synthesize an inbound email
      otp-latest.ts         GET /__mock/otp-latest?email=… — fetch most recent OTP
      health.ts             GET /__mock/health — boots OK + flag confirmation
```

### Why `workers/lib/mocks/` and not a top-level `mocks/`?

Workers can only import from `workers/`, `app/`, `shared/`, plus npm. A top-level `mocks/` requires extra wrangler config to include in the bundle. Putting mocks under `workers/lib/mocks/` follows the existing convention (`workers/lib/mock-access.ts` is already there) and needs zero build-config change.

The action plan said *"Mocks live in `mocks/` at repo root."* — we deviate to `workers/lib/mocks/` for the bundling reason. Documented in the deviation log below.

---

## 4. Wire formats

### 4.1 Outbound mail sink — `outbox.jsonl` over R2

Each outgoing mail in MOCK_MODE writes one R2 object under prefix `__mock__/outbox/`. Key format: `<unix-ms>-<uuid>.json`. Body is the JSON serialization of `SendEmailParams` plus a `_meta` block.

```jsonc
{
  "_meta": {
    "ts_ms": 1714828800123,
    "id": "0fbf3e2c-...",
    "from_user": "alice@actionnow.ai",   // resolved if available
    "is_otp": true,                      // populated by otp-tee
    "otp_code": "284917"                 // populated when is_otp
  },
  "to": "bob@example.com",
  "from": { "email": "noreply@actionnow.ai", "name": "ActionNow.AI" },
  "subject": "Your sign-in code",
  "html": "<div>...284917...</div>",
  "text": "Your sign-in code is: 284917",
  "headers": {}
}
```

**Trade-off:** R2 objects are eventually consistent. For a tight smoke test we ALSO `console.log("[MOCK_EMAIL_OBJECT]", id)` so a log-scraper can correlate without waiting for R2 list visibility.

**OTP detection:** any outgoing mail whose subject matches `/sign[- ]?in code/i` OR body contains a 6-digit token AND was triggered by a `/api/auth/email-otp/*` request gets `is_otp: true`. The OTP code is extracted via `/\b(\d{6})\b/`. If no 6-digit token found, `otp_code: null`.

### 4.2 OTP tee — `__mock__/otp/`

For deterministic, low-latency OTP retrieval (browser-mcp doesn't want to scrape JSON), a separate R2 prefix `__mock__/otp/<email>.json` keeps a single-row "latest OTP" per address:

```jsonc
{
  "email": "alice@actionnow.ai",
  "code": "284917",
  "issued_at_ms": 1714828800123,
  "outbox_id": "0fbf3e2c-..."
}
```

`GET /__mock/otp-latest?email=alice@actionnow.ai` → returns the JSON above. `null` if none.

### 4.3 Inbound email synthesizer — `POST /__mock/inbox`

Reuses the existing `workers/routes/__test__/email-ingest.ts` underneath. Request body:

```jsonc
{
  "to": "alice@actionnow.ai",       // routes to the user's MailboxDO
  "from": "external@gmail.com",
  "subject": "External email test",
  "text": "Body",
  "html": null,                     // optional
  "headers": {                      // optional
    "Message-ID": "<external-test-1@gmail.com>"
  }
}
```

Response: `{ ok: true, mailbox_id: "...", thread_id: "..." }` once the DO has processed.

### 4.4 Reset endpoint — `POST /__mock/reset`

Body (all optional):

```jsonc
{
  "scope": "all" | "users" | "inboxes" | "contacts" | "groups",
  "fixture_set": "default" | "minimal" | "stress",
  "preserve_audit": false
}
```

Defaults: `scope="all"`, `fixture_set="default"`, `preserve_audit=false`.

Response: `{ ok: true, restored: { users: 3, inboxes: 4, contacts: 6, groups: 2 }, ms: 142 }`.

Implementation: directly `DELETE` from D1 tables in dependency order, drop DO storage via `obj.storage.deleteAll()` for every known DO (iterate via D1 user→mailbox map), then re-insert fixtures via `INSERT`. R2 `BUCKET.list({ prefix: "" })` + `delete()` for `avatars/`, `__mock__/outbox/`, `__mock__/otp/`, attachments.

**Hard guard:** the entire `/__mock/*` router checks `isMockMode(env)` at mount time and 404s every request when it isn't set. Belt-and-suspenders inside each handler too.

---

## 5. Per-call-site MOCK_MODE rewiring

| Layer | File | Change |
|---|---|---|
| **AI** | `workers/lib/ai.ts:48` | `if (isAiMocked(env)) return false;` ← already done; switch to shared helper |
| **AI** | `workers/lib/ai.ts:160` | same; shared helper |
| **AI** | `workers/agent/index.ts:278` | wrap `createWorkersAI({ binding: env.AI })` in mock check; if MOCK_MODE return a stub `LanguageModelV1` that yields a canned `UIMessage` reply |
| **AI** | `workers/agent/index.ts:336` | same |
| **AI** | `workers/agent/index.ts:513` | same |
| **EMAIL** | `workers/email-sender.ts` | unchanged — keep helper signature `sendEmail(binding, params)` |
| **EMAIL** | call sites (8) | wrap `env.EMAIL` → `getEmailBinding(c.env)` (returns mock impl in MOCK_MODE) |
| **EMAIL** | `workers/routes/invitations.ts:243` | rewrite direct `c.env.EMAIL.send(...)` → `sendEmail(getEmailBinding(c.env), ...)` |
| **CF Access policy** | `workers/lib/cloudflare-access-policy.ts:43,60` | top-of-function MOCK_MODE branch → return fixture |
| **CF Access service tokens** | `workers/lib/cloudflare-access-service-tokens.ts:53,99` | same |
| **CF Access middleware** | `workers/app.ts:169` | already triggers on `CF_ACCESS_DEV_MODE === "mock"`; MOCK_MODE=1 implies CF_ACCESS_DEV_MODE=mock at startup (in the helper, or just document the `.dev.vars` requirement) |
| **Logout** | NEW route in `workers/app.ts` (or `workers/routes/logout.ts`) | `app.get("/cdn-cgi/access/logout", ...)` → in MOCK_MODE clear cookie + 303 to `/login`; in prod 404 (let CF intercept) |

The `getEmailBinding(env)` helper:

```ts
// workers/lib/mocks/email-binding.ts
import { isMockMode } from "../mock-mode";
import type { Env } from "../../types";
import { writeOutboxEntry } from "./outbox-writer";

export function getEmailBinding(env: Env): SendEmail {
  if (!isMockMode(env)) return env.EMAIL;
  return mockEmailBinding(env);
}

function mockEmailBinding(env: Env): SendEmail {
  return {
    async send(message: any): Promise<{ messageId: string }> {
      const messageId = await writeOutboxEntry(env, message);
      return { messageId };
    },
  } as SendEmail;
}
```

`writeOutboxEntry` handles R2 put + OTP tee + the `console.log("[MOCK_EMAIL]", ...)` correlation marker.

---

## 6. Fixture set (`default`)

3 users (1 global_owner, 1 user, 1 user-pending):

| email | role | display_name | status |
|---|---|---|---|
| `pavel@digifirst.org` | global_owner | Pavel | active |
| `alice@actionnow.ai` | user | Alice | active |
| `bob@actionnow.ai` | user | Bob | active |

4 inboxes:

| name | owner | policies |
|---|---|---|
| Personal | alice | external_inbound=allowed, allowlist=[] |
| Marketing | alice | external_inbound=allowed, allowlist=[*@gmail.com] |
| Engineering | bob | internal_inbound=contacts_only |
| Admin | pavel | external_inbound=blocked |

6 contacts (mix of accepted / pending / blocked):

| owner | contact | status |
|---|---|---|
| alice | bob | accepted |
| bob | alice | accepted |
| alice | pavel | accepted |
| pavel | alice | accepted |
| alice | charlie@external.com | pending |
| bob | spam@external.com | blocked |

2 groups:

| name | members | shared inbox |
|---|---|---|
| `marketing` | alice (admin), pavel | Marketing |
| `engineering` | bob (admin) | Engineering |

1 admin client (already implicit via `pavel` role).

These fixtures cover S-AUTH-1, S-INBOX-1..6, S-MSG-1..4, S-CON-1..2, S-GRP-1..2, S-ADM-1..2.

---

## 7. Boot sequence

`MOCK_MODE=1 npm run dev`:

1. `react-router dev` invokes Vite → wrangler dev under the hood (or `wrangler dev` directly — verify in T1.5).
2. Worker reads `.dev.vars` → `MOCK_MODE=1`.
3. CF Access middleware → mock shim path.
4. First `GET /` → no mock cookie → redirect to `/login` → branded picker.
5. Browser-mcp hits `POST /__mock/reset` (idempotent: clears + loads fixtures).
6. Browser-mcp picks `alice@actionnow.ai` → POST `/login` → cookie set → `GET /` → home.
7. Test scenarios proceed. AI calls return canned data instantly. Email sends land in R2 + OTP tee.

Smoke verifier (T1.5) does this end-to-end and asserts:
- HTTP 200 on `/` after sign-in.
- Zero non-localhost network requests (browser network panel).
- Outbox JSONL contains exactly the expected sends after `mock:reset`.

---

## 8. Deviation from action plan (documented)

| Plan said | We chose | Why |
|---|---|---|
| `mocks/` at repo root | `workers/lib/mocks/` | Worker bundle config; fewer build changes |
| OAuth issuer mock | Deferred | Phase 3 OAuth not yet built — no surface to mock |
| `.mock-state/outbox.jsonl` filesystem | R2 prefix `__mock__/outbox/` | Workers cannot write local FS; R2 is bound and free in Miniflare |
| `MOCK_MODE` flag only | `MOCK_MODE` umbrella + reuse existing `CF_ACCESS_DEV_MODE` + `DEV_MOCK_AI` | Don't break the partial mock that already works |
| `mock:up` npm script | Same — script alias for `MOCK_MODE=1 npm run dev` | Direct match |

These deviations are NOT scope creep — they make implementation cheaper (each one removes work the plan would otherwise require).

---

## 9. Concrete next-step list (T1.3, T1.4, T1.5)

### T1.3 — Implement mock layer

1. `workers/lib/mock-mode.ts` (10 lines) — `isMockMode` + `isAiMocked` helpers.
2. `workers/lib/mocks/ai-responses.ts` — canned responses keyed by purpose (injection-scan, draft-verify, agent-reply).
3. `workers/lib/mocks/email-binding.ts` — `mockEmailBinding(env)` + `getEmailBinding(env)`.
4. `workers/lib/mocks/outbox-writer.ts` — R2 put + OTP tee + console-correlation log.
5. `workers/lib/mocks/cf-access.ts` — fixtures for the policy + service-token endpoints.
6. Edit `workers/lib/ai.ts` — switch to shared `isAiMocked`.
7. Edit `workers/agent/index.ts` — wrap 3 `createWorkersAI`/`workersai(...)` sites.
8. Edit 8 EMAIL call sites — `env.EMAIL` → `getEmailBinding(c.env)`.
9. Edit 2 CF Access lib files — top-of-function MOCK_MODE branch.

### T1.4 — Fixtures + reset endpoint

1. `workers/lib/mocks/fixtures.ts` — `DEFAULT_FIXTURES`, `MINIMAL_FIXTURES`, `STRESS_FIXTURES`.
2. `workers/routes/__mock/index.ts` — router with global guard.
3. `workers/routes/__mock/reset.ts` — D1 truncate + DO clear + R2 prefix purge + fixture load.
4. `workers/routes/__mock/outbox.ts`, `inbox.ts`, `otp-latest.ts`, `health.ts`.
5. Mount `/__mock/*` router in `workers/app.ts` between auth and the SPA catch-all.

### T1.5 — Smoke verifier

1. `scripts/verify-mock-mode.ts` — boots `wrangler dev` (or `npm run dev`) in a child process, polls `/__mock/health`, runs the 5-step smoke (login → home → create-inbox → send → revoke) via direct HTTP, kills the server, exits 0/non-zero.
2. `npm run mock:up` and `npm run mock:reset` in `package.json`.
3. Verify NO real network calls via `lsof`-style verification or by asserting the absence of `fetch` to non-`localhost` in worker logs.

### Phase 1 acceptance test

```
MOCK_MODE=1 npm run dev &
sleep 5
curl -s http://localhost:8787/__mock/health | jq .ok       # → true
curl -s -X POST http://localhost:8787/__mock/reset | jq .ok # → true
node scripts/verify-mock-mode.ts                            # → exit 0
```

If all three commands succeed, Phase 1 closes and `/forward` fires into Phase 2 (UI scenario library).
