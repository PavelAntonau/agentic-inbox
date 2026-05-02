# Deploy State — agentic-inbox

> **Status:** ✅ Live behind Cloudflare Access (OTP gate). Smoke test pending.
> **Last deploy:** 2026-05-02
> **Branch:** `setup/actionnow-ai`

---

## Public URLs

| What | URL |
|---|---|
| Worker | https://agentic-inbox.cloudflare-ascertain725.workers.dev |
| MCP endpoint | https://agentic-inbox.cloudflare-ascertain725.workers.dev/mcp |
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
| Cloudflare Access | One-Time-PIN, on `agentic-inbox.cloudflare-ascertain725.workers.dev` |

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

1. **Custom domain** `mail.actionnow.ai` instead of `*.workers.dev` (one-line addition in Domains & Routes; SSL auto-provisioned).
2. **Per-mailbox authorization** (current: anyone past Access ⇒ all mailboxes). Would require additive change in `EmailMCP.init()` and the in-app agent's `mailboxId` resolution.
3. **Autonomous-send** (replace `draft_email` execute body with `env.EMAIL.send(...)`). Currently agent drafts only — never sends.
4. **Preview URL Access** (`*-agentic-inbox.cloudflare-ascertain725.workers.dev`) — left disabled while user is the only operator and using only production deployments.
5. **MCP integration with Claude Desktop** — `npx mcp-remote https://agentic-inbox.cloudflare-ascertain725.workers.dev/mcp`, OTP-authed.

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
