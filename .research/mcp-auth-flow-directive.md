# MCP Authorization — User Directive (2026-05-04, evening)

**Status:** Active research → planning → implementation pipeline begins next context.
**Effort:** xhigh (user explicitly raised). **Severity:** "Must be complete to ship."
**Slug:** `mcp-auth-flow`

---

## Verbatim user statement (parsed from speech-recognition input)

> Right now, what we have there is just nonsense. It says we need to wipe the
> user's session key from the browser, and there's some other stuff —
> honestly, it's complete rubbish.
>
> Look, I want us to move to the next phase, where we put in the **maximum
> effort**. We really pushed hard on this. We did research on the proper way
> to handle it, looking into best practices and recommendations from others.
> Maybe there are ready-made implementations or official examples showing
> how this should be done.
>
> We need to allow the user to connect in two ways. Basically — when MCP
> starts up and sees that authorization needs to be launched through the
> browser, and the second way is through tokens. **This absolutely must be
> implemented right now, one hundred percent, so the application can truly
> be considered complete.**
>
> Again, this is about **security**, and it's important. We need to do a
> thorough preliminary research of the documentation and user
> recommendations.

---

## Interpretation

The "rubbish" the user is pointing at: the **"Authentication — known gap"
amber notice** I shipped in `app/components/MCPPanel.tsx` during round-3
batch-3 (commit `5632f0a`). It currently tells the user the auth flow isn't
wired and that the in-browser token issuance is "next on the roadmap." The
user is rejecting that as a holding pattern — they want the real flow
shipped now.

### Two auth paths required (both, not one)

1. **Browser-launched OAuth flow.** When an MCP-aware client (Claude Code,
   Cursor, ChatGPT desktop, etc.) connects to `mail.actionnow.ai/mcp` and
   doesn't have a credential, the MCP server must signal "authorization
   required" in a way the client recognises. The client then opens a
   browser tab to a consent / sign-in page. After consent, the server
   issues a token the client uses for subsequent calls.

2. **Programmatic bearer token issuance.** For headless agents (cron jobs,
   server-side workflows, agents running in CI), the user must be able to
   generate a long-lived inbox-scoped token from an authenticated browser
   session and paste it into the agent's MCP config. This is the path the
   round-3 batch-3 panel was *trying* to describe with curl commands but
   doing badly — actual implementation must let the user generate the
   token *in the browser UI* and copy a single ready-to-use command.

Both paths must coexist. Path 1 is for interactive humans + their AI
clients; path 2 is for fire-and-forget agents that can't open a browser.

### "About security, and it's important"

The user explicitly framed this as a **security requirement**. That means:
- No half-baked tokens in localStorage with weak entropy.
- No bearer tokens transmitted over query params or logged in audit trails.
- Revocation must work end-to-end (already partially wired via
  `RevocationCache` DO + `agent_tokens.revoked_at`).
- Token scoping must be per-mailbox (not workspace-wide) so a leaked token
  for `tail2@actionnow.ai` cannot read `final-verify@actionnow.ai`.
- Rotation, expiry, audit logging — all required.

---

## Existing surface area (the bones of the implementation are partly there)

The 2026-05-03 phase-out left the token surface unmounted but mostly
intact. We're not building from zero.

| Surface | Location | State |
|---|---|---|
| Token CRUD endpoints | `workers/routes/tokens.ts` | Source intact, **router unmounted** in `workers/app.ts:919-922` |
| `agent_tokens` D1 table | migration 000? | In place; columns: id, cf_service_token_id, cf_client_id, secret_hash, mailbox_id, issued_to_user, label, max_instances, created_at, last_seen_at, revoked_at |
| `RevocationCache` DO | `workers/types.ts` binding | Bound, mounted, drives revoke order: cache → CF DELETE → DB |
| `AgentTokenLimiter` DO | `workers/types.ts` binding | Bound; rate-limits per-token instance count |
| CF Access service tokens | `workers/lib/cloudflare-access-service-tokens.ts` | Real impl + dev mock; needs `CF_ACCOUNT_ID` + `CF_ACCESS_API_TOKEN` env in prod |
| CF Access cookie session | `workers/middleware/authz-context.ts` | The browser-session path (current) |
| MCP server | `workers/mcp/index.ts` | 13 tools, protocolVersion `2025-06-18` |
| `TOKEN_PEPPER` | env binding | HMAC-SHA256 pepper for `secret_hash` storage |

**Critical observation:** the user explicitly said in 2026-05-03 to phase
out tokens. Now they're explicitly saying ship them. The earlier phase-out
was about the *UI surface* and the *unmounted-router state*; the underlying
schema + DOs were preserved precisely because this moment was anticipated.
We re-mount with intent now, and we re-design the UI around a proper
flow rather than the prior raw-CRUD list.

---

## What's missing (the actual gap)

What the existing implementation does NOT have:

1. **OAuth 2.1 endpoints.** No `/authorize`, `/token`, `/register`, no PKCE
   handling, no DCR (Dynamic Client Registration). The existing token API
   is a custom "POST to issue, return secret once" flow — not OAuth.
2. **Discovery metadata.** No `/.well-known/oauth-protected-resource`, no
   `/.well-known/oauth-authorization-server`. Without these, MCP clients
   can't discover the auth requirements.
3. **`WWW-Authenticate` responses on the MCP endpoint.** The `/mcp` route
   needs to respond `401 WWW-Authenticate: Bearer resource_metadata="..."`
   on unauthenticated calls so clients know where to start.
4. **In-browser token issuance UI.** The MCPPanel component currently has
   a curl placeholder; it must become a "Generate token → display once →
   copy ready-to-use `claude mcp add` command" flow with an actual
   button-driven API call.
5. **Bridge to CF Access.** The OAuth provider's identity layer should
   delegate to CF Access (which already authenticates the human) rather
   than re-implementing identity. This is the integration the system
   prompt's "Future Considerations" section labelled
   `@cloudflare/workers-oauth-provider`.

---

## Phase 0 — Research Plan (the next context starts here)

When the next context boots into `/research-deep` (via the `/forward`
following this doc), it will execute the following 4-phase pipeline. The
plan IS the deliverable of this directive — Phase 1 fires the first deep
call against this scaffold, not against a blank slate.

### Sub-questions to answer (decomposition for Phase 0 → Phase 1 seed)

1. **MCP Authorization Spec.** What does the MCP authorization spec
   (latest, ~2025-06-18 protocolVersion) require? OAuth 2.1 + PKCE +
   RFC 9728 (Protected Resource Metadata) + RFC 8707 (Resource
   Indicators) + DCR (Dynamic Client Registration, RFC 7591). Exact
   endpoints, exact `WWW-Authenticate` header format, exact metadata
   document fields. Cite the spec doc URL.

2. **`@cloudflare/workers-oauth-provider`.** API surface, capabilities,
   integration patterns. Where in the request pipeline does it sit?
   Does it expose `/oauth/*` endpoints automatically? How does it
   integrate with an upstream IdP? Cite the package README + a working
   example repo.

3. **CF Access as upstream IdP.** Can `@cloudflare/workers-oauth-provider`
   delegate sign-in to CF Access (cookie-based) so the user doesn't get
   a second login screen? If yes, the architecture: incoming MCP client
   → OAuth provider → CF Access cookie check → consent screen → token
   mint. If no, what's the fallback (better-auth OTP, magic link)?

4. **Production MCP server examples.** Linear, Sentry, Asana, GitHub,
   Anthropic's own examples — how do they implement MCP auth? Source
   repos. What did they get right? Where are the rough edges (e.g. token
   refresh, client registration churn)?

5. **MCP client OAuth UX.** How do `claude mcp add`, Cursor, Codex CLI,
   ChatGPT desktop actually behave when they hit an OAuth-protected MCP
   endpoint? Do they all support DCR? What URL conventions do they
   expect? What goes wrong if metadata is missing or malformed?

6. **Bearer token issuance for headless.** For agents that can't open a
   browser, the supported flow today is typically "user generates token
   from web UI → copies to agent config". What's the recommended token
   format (JWT vs opaque), the recommended TTL, and how does the OAuth
   provider treat manually-issued tokens vs. flow-issued ones? Are they
   interchangeable on the wire?

7. **Token storage / revocation / rotation.** Production patterns for
   storing bearer tokens (HMAC-pepper hash, like our existing
   `secret_hash`?), maintaining a revocation cache (we have
   `RevocationCache` DO), supporting revocation even when the token is
   in flight. RFC 7009 Token Revocation conformance.

8. **Per-resource scoping (per-mailbox).** RFC 8707 Resource Indicators
   was added to OAuth 2.1 specifically so a token can be scoped to one
   resource (here, one mailbox). How do production servers map resource
   indicators to scopes? Should each mailbox be a separate "resource" in
   the OAuth metadata?

### Phase 1 — single seed deep call

Fire ONE `perplexity_research` call. Suggested query (the next context
should refine and execute):

> How should a production MCP (Model Context Protocol) server implement
> authorization in 2026? Cover the MCP authorization specification
> (protocolVersion 2025-06-18+: OAuth 2.1 with PKCE, RFC 9728 Protected
> Resource Metadata, RFC 8707 Resource Indicators, RFC 7591 Dynamic
> Client Registration), implementation on Cloudflare Workers using
> `@cloudflare/workers-oauth-provider`, bridging an upstream identity
> provider like Cloudflare Access for sign-in, supporting both
> interactive OAuth flows (Claude Code, Cursor, Codex) and programmatic
> bearer tokens for headless agents, and production reference
> implementations (Linear, Sentry, Asana, Anthropic's own examples).
> Cite specification documents and example repositories.

This is a single deep call. Do NOT fire follow-ups in parallel — the
research-mcp deep cap is 1 and parallelism wastes wall-clock without
adding signal.

### Phase 2 — citation extraction (light, parallel allowed)

From the seed result, extract every cited URL. Use `tavily_extract` and
`context7` on the documentation pages — particularly:
- The MCP authorization spec page (modelcontextprotocol.io / spec)
- The `@cloudflare/workers-oauth-provider` package docs
- One or two production reference implementations
- The relevant RFCs (9728, 8707, 7591, 7009)

Use `context7` for `@cloudflare/workers-oauth-provider` and `agents/mcp`
package docs (these libraries are in our package.json already; check
versions). Up to 4 light calls in parallel is fine.

### Phase 3 — targeted follow-up deep calls (sequential, ≤ 3)

Based on Phase 2 findings, fire targeted follow-ups for any gaps:
- "Show me a production-quality `@cloudflare/workers-oauth-provider`
  setup that delegates to Cloudflare Access for sign-in." (deep)
- "What's the recommended pattern for issuing programmatic bearer
  tokens alongside an OAuth flow on the same MCP endpoint?" (deep)
- "What are the failure modes / common bugs in MCP OAuth flows that
  break Claude Code / Cursor compatibility?" (deep)

Each is sequential. Read the prior result before firing the next.

### Phase 4 — structured report

Write `.research/mcp-auth-flow.md` with:
- **Recommendation:** the single chosen architecture (OAuth provider +
  CF Access bridge + token-issue API), one-paragraph summary.
- **Architecture diagram** (ASCII): MCP client → /mcp endpoint →
  401 WWW-Authenticate → /.well-known discovery → /authorize → CF Access
  cookie check → consent → /token → bearer token → /mcp call.
- **Endpoints to add** (exhaustive list with method, path, request,
  response, error cases).
- **D1 schema changes** (if any — likely augment `agent_tokens` for
  refresh tokens, OAuth client registrations).
- **DO bindings to add** (if any — likely an `OAuthStateStore` for
  PKCE challenge persistence + client registrations).
- **MCPPanel UX** — the actual button-driven token-issue flow that
  replaces the current curl notice.
- **Migration path** — re-mount the existing `tokens` router but adapt
  it to OAuth conventions; preserve the existing `agent_tokens` rows
  (no data loss).
- **Test plan** — cover both interactive (browser-launched) and headless
  (paste-token) paths, plus revocation, rotation, expiry.
- **Cited sources** — every claim has a URL, no inferences from training
  data.

Then `/forward` into `/session-plan` with the report as input.

---

## Constraints / non-goals (carry forward)

- **No silent re-mount of the prior router.** The existing
  `workers/routes/tokens.ts` was unmounted by user directive 2026-05-03.
  We re-mount only after the design is agreed and only with the OAuth-
  shaped wrapper in front of it.
- **No CLI-only token issuance ever again.** The user rejected
  curl-with-cookie placeholders. Every token must be issuable from the
  browser UI on `mail.actionnow.ai`.
- **No header-only solutions.** Don't put auth UI in the global Header;
  it lives in the MCPPanel (per the round-3 batch-4 mailbox-scoping rule).
- **No leak of `client_secret` in audit logs, DOMs, or query strings.**
  HMAC-pepper hash on storage; one-time display on issuance; clipboard
  copy with a "secret only shown once" warning.
- **CF Access service token integration is preserved.** The current code
  path (real in prod, mock in dev via `CF_ACCESS_DEV_MODE`) stays.

---

## Round-3 UI batches close-out (what landed before this pivot)

For the next context's awareness — round-3 UAT iteration on agentic-inbox
shipped 5 batches between 2026-05-04 morning and evening. Commits on
`feature/autonomous-local-testing`:

- `38e0f4e9` (pre-round-3) — Cloudflare deploy skill canonicalisation
- `9f96927` — round-3 batch-1: robots / logo / search / compose / MCP / modal
- `d142b42` — batch-2: split-view robots, MCP rewrite, panel chrome
- `5632f0a` — batch-3: single robot, observability scroll, search pin, flush
- `2dddd10` — batch-4: relocate mailbox controls, divider always-on, magnifier
- `b70bca0` — batch-5: robot smaller, count subtitle, hover-only divider

UI is in a stable state on production (mail.actionnow.ai). User said
"I'll check the UI later, mobile too" — there will be a mobile UAT pass
after the auth backend lands. Treat as deferred, not blocked.

---

## Handoff

Next context's first action:
- `/research-deep` on this directive's Phase 1 seed query
- Read this doc first; it IS Phase 0
- Output target: `.research/mcp-auth-flow.md` (Phase 4 report)
- Then `/forward` into `/session-plan` with the report as input
