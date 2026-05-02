# Deploy State — agentic-inbox

> **Status:** ✅ Live behind Cloudflare Access (OTP gate). Custom domain `mail.actionnow.ai` active. Admin allowlist: `pavel@digifirst.org`.
> **Last deploy:** 2026-05-02
> **Branch:** `setup/actionnow-ai`

---

## Public URLs

| What | URL |
|---|---|
| **Primary** (custom domain) | **https://mail.actionnow.ai** |
| **Primary MCP endpoint** | **https://mail.actionnow.ai/mcp** |
| Worker (dev URL, also live) | https://agentic-inbox.cloudflare-ascertain725.workers.dev |
| Access login | https://cloudflare-ascertain725.cloudflareaccess.com |
| GitHub fork | https://github.com/PavelAntonau/agentic-inbox |
| Setup branch | https://github.com/PavelAntonau/agentic-inbox/tree/setup/actionnow-ai |

## Cloudflare resources

| Resource | Identifier |
|---|---|
| Account | `Cloudflare.ascertain725@simplelogin.com's Account` (`3e96bfb3a3edded75b781064e5d743a3`) |
| Zone | `actionnow.ai` (`264d691b618321577704996c8c4325d0`, plan: Free Website) |
| Worker | `agentic-inbox` |
| Latest version | `719896d9-615b-456b-b1ed-15183e6842f1` |
| R2 bucket | `agentic-inbox` (created `2026-05-02T14:35:32Z`) |
| Email Routing rule | catch-all `*@actionnow.ai` → worker `agentic-inbox` (id `69eeec53c3704946b63a58c266da64f5`) |
| Workers AI | Enabled (243 models) |
| Custom domain | `mail.actionnow.ai` → worker `agentic-inbox` (cert id `0d74da3c-f1cf-4cb4-958e-9c8ba19ec196`, auto-renewing) |
| Cloudflare Access app | `agentic-inbox - Cloudflare Workers` (`15ce94e1-a6ff-41fe-b30a-ad25df988e75`), self_hosted_domains: [`mail.actionnow.ai`, `agentic-inbox.cloudflare-ascertain725.workers.dev`] |
| Cloudflare Access policy | `agentic-inbox - Production` (`197f3a0a-83d1-4acd-b1fe-6f09ab62807f`), reusable, decision=allow |

## Access policy — login allowlist

The Cloudflare Access policy IS the login allowlist for the dashboard and MCP endpoint. Currently:

| Email | Role | Notes |
|---|---|---|
| `pavel@digifirst.org` | **primary admin** | The address you use to receive OTP and log into the dashboard |
| `cloudflare.ascertain725@simplelogin.com` | admin (default) | The Cloudflare account email — auto-added by Cloudflare when you toggled Access on |

To add another user (until the in-app admin UI is built — see Phase 2 vision below), update the policy via API:

```bash
curl -X PUT \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/accounts/3e96bfb3a3edded75b781064e5d743a3/access/policies/197f3a0a-83d1-4acd-b1fe-6f09ab62807f" \
  -d '{
    "name": "agentic-inbox - Production",
    "decision": "allow",
    "include": [
      {"email": {"email": "pavel@digifirst.org"}},
      {"email": {"email": "cloudflare.ascertain725@simplelogin.com"}},
      {"email": {"email": "NEW_USER@example.com"}}
    ],
    "exclude": [],
    "require": []
  }'
```

**Important: login email ≠ mailbox address.** The login email must be deliverable to a mailbox the user can already check (Gmail, etc.) — that's where the OTP PIN is sent. The `@actionnow.ai` mailboxes inside the app are agent identities for sending/receiving, not login identities.

## Bindings (from wrangler.jsonc, deployed)

```
env.MAILBOX (MailboxDO)         Durable Object
env.EMAIL_AGENT (EmailAgent)    Durable Object
env.EMAIL_MCP (EmailMCP)        Durable Object
env.EMAIL (unrestricted)        Send Email
env.BUCKET (agentic-inbox)      R2 Bucket
env.AI                          Workers AI
env.DOMAINS ("actionnow.ai")    Env var
env.EMAIL_ADDRESSES ([])        Env var (empty = catch-all)
```

## Secrets — agent keychain mirror

All values stored encrypted in the local agent keychain via the keychain MCP server (no plaintext on disk, no `.env` files). For future sessions, retrieve with `mcp__keychain__tool_get_secret(service, account)`.

| Service / account | Purpose |
|---|---|
| `cloudflare/api-token` | Scoped API token (TTL 30d, expires `2026-06-02`) |
| `cloudflare/policy-aud` | Cloudflare Access app AUD claim |
| `cloudflare/team-domain` | Cloudflare Access team URL |

The same `POLICY_AUD` and `TEAM_DOMAIN` values are also stored as encrypted **Worker secrets** in Cloudflare (read by the worker on every request to validate the Access JWT cookie).

## Customization deltas vs upstream

Two commits, both surgical, both upstream-merge-friendly:

| Commit | Change | Files |
|---|---|---|
| `a691d24` | `chore: set DOMAINS to actionnow.ai for inbound email routing` | `wrangler.jsonc` (1 line) |
| `bf19463` | `chore(deps): patch all 14 advisories to zero via npm audit fix` | `package-lock.json` (transitive only — `package.json` unchanged from upstream) |

`package.json` is byte-identical to `cloudflare/agentic-inbox` `main`. Future `git fetch upstream && git merge upstream/main` will be conflict-free.

## What is NOT customized

Per the user's instruction "deploy as-is, defaults only," none of these have been touched:

- UI components (`app/components/`, `app/routes/`)
- Tailwind theme (`app/index.css`, `tailwind.config`)
- Agent system prompt (`workers/agent/index.ts` `DEFAULT_SYSTEM_PROMPT`)
- MCP tool surface (`workers/mcp/index.ts`, 13 tools)
- Guardrails (`workers/lib/ai.ts` — Llama-3.1-8b injection scanner + Llama-4-scout draft verifier)
- DO schemas (`workers/db/schema.ts`)
- Auth model (anyone past Access can act on any mailbox — single trust boundary)

## Decisions deferred to later

1. ~~**Custom domain** `mail.actionnow.ai`~~ — **DONE 2026-05-02.**
2. **Per-mailbox authorization** (current: anyone past Access ⇒ all mailboxes). Would require additive change in `EmailMCP.init()` and the in-app agent's `mailboxId` resolution.
3. **Autonomous-send** (replace `draft_email` execute body with `env.EMAIL.send(...)`). Currently agent drafts only — never sends.
4. **Preview URL Access** (`*-agentic-inbox.cloudflare-ascertain725.workers.dev`) — left disabled while user is the only operator and using only production deployments. Migrate when sandboxes/previews start being used.
5. **Disable the `*.workers.dev` URL** entirely after Phase 2 — single canonical surface (`mail.actionnow.ai`).
6. **MCP integration with Claude Desktop** — `npx mcp-remote https://mail.actionnow.ai/mcp`, OTP-authed.

---

## Phase 2 vision — admin/onboarding UI inside the fork

User-stated requirements (2026-05-02), to be implemented as customizations of the upstream agentic-inbox fork. Ordered by dependency:

### V2.1 — Admin role + invite flow (in-app)

- **Primary admin = `pavel@digifirst.org`** (already on Access policy; UI stores admin role flag in a settings DO or KV).
- **`/admin/users` page** in the React SPA, only accessible to admin role. Lists current allowlisted login emails with a remove button + an "Invite user" form.
- **Invite flow:** admin types `friend@example.com` → backend (a new worker route, e.g. `POST /admin/invite`) calls Cloudflare Access API to add the email to the existing policy's `include` list, then sends a templated invitation email via `env.EMAIL.send` from a system address (e.g. `noreply@actionnow.ai`) telling the invitee to visit `https://mail.actionnow.ai` and request an OTP.
- **No "complicated steps":** the invitee enters their email, receives Cloudflare's OTP at their real inbox, pastes the code, lands in the dashboard with the default mailbox auto-created (`<their-local-part>@actionnow.ai`).
- **Token lifetime:** Cloudflare Access OTPs are 10-minute single-use; if expired the user just clicks "Resend code." This already matches user's requirement.

### V2.2 — Role tiers

- **Two roles:** `admin` and `user`.
- Admins see `/admin/users` and `/admin/observability`. Users see only their own mailbox.
- Role assignment stored in a per-user settings record (DO or KV); admin promotes/demotes from the `/admin/users` UI. Backend gates each admin route on the role.

### V2.3 — Agent-token-copy

- Each user (admin or regular) sees a **"Connect an agent"** card on their mailbox page. One click reveals a copy-to-clipboard string of the form:
  ```
  npx mcp-remote https://mail.actionnow.ai/mcp
  ```
  Plus a one-line install snippet for `~/.claude/claude_desktop_config.json`. The agent OAuths through Cloudflare Access OTP on first connect, same as the human flow.
- Optional V2.3+: per-user MCP service tokens (Cloudflare Access supports `service_token` IdP — non-interactive, agent-friendly), so an agent can authenticate via header without OTP. Stored as a regenerable secret in the user's mailbox settings.

### V2.4 — Observability dashboard

- **`/admin/observability`** (admin only):
  - Active sessions (count + emails) — pulled from Access logs via API
  - Inbound message counts per mailbox (last 24h, last 7d) — from MailboxDO `emails` table
  - Outbound (sent) counts — from same DO
  - Last login timestamp per user
  - Optional: per-tool MCP call rate (which agents are calling which tools)

### Implementation order (when we get to it)

1. Wire admin role flag (single bit in user settings record).
2. Build `/admin/users` (lists + invite + remove). Backend routes call Cloudflare Access API using a worker secret (rotate the API token to a worker-only one).
3. Add invite-email send step (uses `env.EMAIL.send` already wired).
4. Add agent-token-copy card on mailbox page.
5. Add `/admin/observability` with MailboxDO aggregations.
6. (Optional) Service-token IdP for agent connections.

Each step is additive to upstream — files in `app/routes/admin/*` and `workers/routes/admin.ts` that don't conflict with `cloudflare/agentic-inbox` upstream changes.

## Smoke test checklist

- [ ] Visit worker URL → redirected to OTP page
- [ ] Enter email, receive PIN, log in
- [ ] Create mailbox `pavel@actionnow.ai`
- [ ] Send external email to `pavel@actionnow.ai`
- [ ] Email lands in UI within ~30s
- [ ] Auto-draft reply appears in Drafts folder (not sent)
- [ ] (optional) Connect MCP from Claude Desktop and run `list_mailboxes` / `list_emails`

## Re-deploy from scratch (next session, no human input)

```bash
cd /Users/dev/ActionNowAI/agentic-inbox

# Pull token from keychain (no plaintext on disk)
export CLOUDFLARE_API_TOKEN=$(curl -s ...)        # via mcp__keychain__tool_get_secret
export CLOUDFLARE_ACCOUNT_ID=3e96bfb3a3edded75b781064e5d743a3

# Deploy
npm run deploy
```

Worker secrets persist server-side; they don't need to be re-set unless rotating.

## Token lifecycle reminder

The Cloudflare API token expires **2026-06-02**. Before then:

1. Create a new token with the same 8 scopes (https://dash.cloudflare.com/profile/api-tokens)
2. `mcp__keychain__tool_set_secret(service="cloudflare", account="api-token", value=<new>)`
3. Revoke the old one in the dashboard
