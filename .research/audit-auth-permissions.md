# Audit Report — auth + lib + db (Teammate A)

**created:** 2026-05-04
**branch:** feature/autonomous-local-testing @ c8b319a
**partition:** auth/lib/db (per Phase 2 partition)
**deliverable for:** action-plan-agentic-inbox-audit.md → TASK-2.A

---

## Summary

| Severity | Count | Top items |
|---|---|---|
| critical | 1 | S-1: oauth_refresh_token.token missing UNIQUE (token-substitution attack) |
| high | 3 | CC-1: forGroup discipline violated in mailbox-tree.ts + authz-context.ts; A-1: bootstrap-owner dual-path divergence; V-1: 5-tier visibility missing contacts-of-contacts + explicit-allow tiers |
| medium | 8 | C-1: no clock-skew tolerance in consent sig; C-2: ConsentForwardError leaks plugin detail; C-3: scope intersection not enforced in lib; V-2: enforceContactsAndNobody defaults false; DB-1: emails missing thread_id/message_id indexes; S-2: contacts missing contact_user_id index; S-3: group_invitations missing invitee_user_id index; S-6: account table missing UNIQUE on (provider_id, account_id) |
| low | 14 | A-2: localhost origins hardcoded; A-3: OTP rate-limit not at transport; C-4: logoUri sanitization delegated; C-5: submitConsentDecision forwards all cookies; B-1: bootstrapOwner lookup case-sensitivity; MP-1: canShare ignores admin ACL; V-3: Phase-3 dead co-member branch; DB-2: threads.tip_message_id logical FK; S-4: groups/mailboxes.owner_user_id no cascade; S-5: contacts.initiated_by no cascade; S-7: oauth_client.clientSecret plaintext; S-8: groups.name no UNIQUE; S-9: verification.identifier no UNIQUE; F-1: forGroup() structural-only |

(Total actionable findings: 26. Total surfaces audited: 8.)

---

## Cross-cutting findings

### CC-1 — forGroup() discipline violated in lib and middleware layers
**Tags:** `severity:high` `category:security`
**Location:** `workers/lib/mailbox-tree.ts:48`, `workers/middleware/authz-context.ts:71`
**Scenario:** `coverage:none recommend:S-GROUP-FORGROUPDISCIPLINE-1`
**Evidence:**
Both `workers/lib/mailbox-tree.ts` and `workers/middleware/authz-context.ts` call `drizzle(db, { schema })` directly to query `group_members`, then query `groups`, `mailboxes`, `mailbox_groups` — without going through `forGroup()`. `forGroup.ts` is documented as "the chokepoint" and the CI grep-lint is supposed to forbid `drizzle()` outside of it. The actual `forGroup()` function returns a plain drizzle wrapper with no query enforcement, so bypassing it is invisible at runtime — but violates **D-V2F-3** and removes the single chokepoint the CI guard is meant to defend.

```ts
// workers/lib/mailbox-tree.ts:48
const orm = drizzle(db, { schema });
// ... then at line 109:
.from(schema.group_members)
.where(eq(schema.group_members.user_id, ctx.user_id))
```

```ts
// workers/middleware/authz-context.ts:71
const orm = drizzle(c.env.DB, { schema });
// ... then at line 33-35:
.select({ group_id: schema.group_members.group_id })
.from(schema.group_members)
.where(eq(schema.group_members.user_id, user.id))
```

**Risk:** The CI grep-lint rule (`rg 'from\(.*group_members' workers/`) WILL flag these lines as violations if the lint is ever enforced, breaking CI. More importantly, any future developer who reads the architecture documentation will believe group_members access is centralized — it is not. If `forGroup()` ever gains real enforcement logic (row-level security, audit-log on read, etc.), these two callers would silently bypass it.
**Recommendation:** Wrap the `group_members` queries in `buildHumanAuthzContext` (authz-context.ts) and in `buildMailboxTree` (mailbox-tree.ts) so they receive their drizzle handle via `forGroup(db, ctx)`. For the authz middleware's bootstrap path, the ctx is not yet available, so either: (a) add a dedicated `buildGroupIds(db, userId)` helper inside `forGroup.ts` that is explicitly exempt from the rule, OR (b) amend the CI rule to exempt the two infrastructure callers by file-path. Document the exemption in `forGroup.ts`.

**Note for Teammate B:** `workers/routes/groups.ts`, `workers/routes/invitations.ts`, `workers/routes/mailboxes.ts` all query `group_members` directly via `drizzle()` obtained from `forGroup(db, ctx).db`. This is within scope for Teammate B's review — verify each call site passes the ctx-scoped `db` handle, not a fresh direct `drizzle()` call.

---

## File: workers/auth/index.ts

### Finding A-1 — Duplicate bootstrap-owner promotion paths may produce divergent role assignments
**Tags:** `severity:high` `category:correctness`
**Location:** `workers/auth/index.ts:305-326` and `workers/lib/bootstrap-owner.ts:24`
**Scenario:** `scenario:S-AUTH-1`
**Evidence:**
Two independent bootstrap-owner promotion mechanisms exist simultaneously:

1. **better-auth `databaseHooks.user.create.before`** (`index.ts:312–325`): intercepts user creation by the better-auth OTP plugin and injects `role: "global_owner"` into the row before insert. This fires on the better-auth path.

2. **`bootstrapOwner()` helper** (`lib/bootstrap-owner.ts`) called from `authz-context.ts:214`: fires on the CF Access JWT path for users not yet in the `users` table.

The two paths are not coordinated. If `BOOTSTRAP_OWNER_EMAIL` is misconfigured (e.g., wrong case, trailing space), the better-auth hook may silently promote the wrong user as `global_owner` since it does `user.email.toLowerCase() === bootstrapEmail.toLowerCase()` but first reads `BOOTSTRAP_OWNER_EMAIL` with `.trim()` only in `bootstrap-owner.ts` — the hook at `index.ts:314` does NOT call `.trim()` before the comparison. A BOOTSTRAP_OWNER_EMAIL value with leading/trailing whitespace will work in `bootstrapOwner()` (which trims it, line 30) but fail the hook comparison.

Additionally, if a new user creates an account via the better-auth OTP path, then that same session triggers the authz-context middleware (which calls `bootstrapOwner` as a fallback), there is a double-promotion attempt — harmless in the normal case (second call returns the existing row), but creates confusion in error scenarios.

**Risk:** In production, if BOOTSTRAP_OWNER_EMAIL has a space character, the better-auth path creates a regular-role user while the CF Access path correctly promotes to global_owner. This divergence can create orphan admin-less deployments if CF Access is then disabled.
**Recommendation:**
1. Add `.trim()` to the `BOOTSTRAP_OWNER_EMAIL` read in the better-auth hook (line 314–315), matching the `bootstrapOwner()` helper.
2. Document in a comment that both paths must stay in sync; consider extracting the common "is this the bootstrap email?" predicate into a single function shared by both.
3. Add an S-AUTH-1 assertion that verifies `role === 'global_owner'` after first-login.

### Finding A-2 — trustedOrigins hardcodes localhost dev origins
**Tags:** `severity:low` `category:security`
**Location:** `workers/auth/index.ts:124-128`
**Scenario:** `scenario:S-AUTH-1`
**Evidence:**
```ts
trustedOrigins: [
  "https://mail.actionnow.ai",
  "http://localhost:5173",
  "http://localhost:8787",
],
```
`http://localhost:5173` and `http://localhost:8787` are hardcoded in the production Workers bundle. The `better-auth` `trustedOrigins` list controls which origins can send cookie-authenticated requests. If the Worker is ever deployed to a non-actionnow.ai domain (staging, preview), the localhost entries are harmless. However, they constitute an information leak (exposes dev ports) and could be used in same-machine cross-origin attacks if a local service binds to one of those ports.
**Risk:** Low — localhost origins are only reachable from the server's own machine, which in a Workers context is only the developer's machine. Not exploitable in production.
**Recommendation:** Gate the localhost entries on `MOCK_MODE=1` or `CF_ACCESS_DEV_MODE=mock` so they are absent from the production bundle, or confirm this is acceptable for the threat model.

### Finding A-3 — OTP email error not rate-limited at the transport level
**Tags:** `severity:low` `category:security`
**Location:** `workers/auth/index.ts:246-254`
**Scenario:** `scenario:S-AUTH-1`
**Evidence:**
The `sendOtpEmail` function at line 343 re-throws send errors to better-auth which surfaces them to the caller. The better-auth `rateLimit` config uses `storage: "database"` and `modelName: "rateLimit"`. However, the email SEND itself (line 370) is not separately rate-limited at the application layer — rate limiting only applies to the OTP request endpoint. If the email binding silently accepts but drops messages, users would get a 200 response but no email, with no fallback.
**Risk:** Low — better-auth's built-in rate limiting applies to the `/api/auth/email-otp/send-otp` endpoint. The risk is primarily operational (silent delivery failure) rather than security.
**Recommendation:** Add a test scenario S-AUTH-OTP-RATELIMIT that verifies the `429` response after N attempts.

---

## File: workers/auth/consent.ts

This is the **orphan surface** with zero scenario coverage. Every finding is tagged `coverage:none`.

### Finding C-1 — No clock skew tolerance in exp verification
**Tags:** `severity:medium` `category:security`
**Location:** `workers/auth/consent.ts:80`
**Scenario:** `coverage:none recommend:S-AUTH-OAUTH-CONSENT-1`
**Evidence:**
```ts
if (exp * 1000 < Date.now()) return { ok: false, reason: "expired" };
```
The expiry check uses `Date.now()` with no clock-skew tolerance. The `exp` value is set by the OAuth provider plugin at `/api/auth/oauth2/authorize` time. If the Worker isolate clock and the user's browser clock are skewed, or if the redirect takes longer than expected (network latency, mobile browser background/foreground cycle), the consent page rejects a valid `exp` and shows an "invalid consent request" error with no retry path. The OAuth provider signs the `exp` into the payload, so the user cannot regenerate it without restarting the flow.
**Risk:** Real-world failure scenario: a mobile user backgrounding their browser for > a few seconds between clicking "Authorize" and landing on `/consent` could see a spurious "expired" error, especially in poor-network conditions. The `@better-auth/oauth-provider` plugin likely sets `exp` to a short window (tens of seconds). No tolerance is present.
**Recommendation:** Allow ±30 seconds of clock skew:
```ts
const CLOCK_SKEW_MS = 30_000;
if (exp * 1000 < Date.now() - CLOCK_SKEW_MS) return { ok: false, reason: "expired" };
```
Add scenario `S-AUTH-OAUTH-CONSENT-1` that tests: (a) valid sig+exp → 200 consent page; (b) expired exp → error page; (c) tampered sig → error page.

### Finding C-2 — ConsentForwardError status re-exposed to the client
**Tags:** `severity:medium` `category:security`
**Location:** `workers/auth/consent.ts:295-298` and `app/routes/consent.tsx`
**Scenario:** `coverage:none recommend:S-AUTH-OAUTH-CONSENT-2`
**Evidence:**
`submitConsentDecision` throws a `ConsentForwardError` with the HTTP status from the plugin's response (`res.status`). The `ConsentForwardError.status` field carries values like 400, 422, 500 from the plugin. The catch site in `app/routes/consent.tsx` (the route `action`) must handle this error and decide what to show the user.

A malicious client-controlled `oauth_query` body field could cause the plugin to return a 400 error with an informative error body — and `submitConsentDecision` currently captures up to 200 chars of that body in the error message (`detail.slice(0, 200)`). If the consent route action forwards that detail to the UI (even partially), it could leak internal OAuth plugin error messages.
**Risk:** Information disclosure — varies by how `app/routes/consent.tsx` renders `ConsentForwardError`. Cannot be fully assessed without reading that file (which is out of scope for this partition), but the risk exists in the helper itself.
**Recommendation:** Strip the plugin's error detail before surfacing to the user. The `ConsentForwardError` message should contain only the status code for logging; the user-facing error should be a fixed generic string ("Consent request could not be completed"). Add recommended scenario `S-AUTH-OAUTH-CONSENT-2` to verify that plugin error bodies are not reflected to the browser.

### Finding C-3 — loadConsentClient DB fallback does not validate scope intersection
**Tags:** `severity:medium` `category:security`
**Location:** `workers/auth/consent.ts:129-170`
**Scenario:** `coverage:none recommend:S-AUTH-OAUTH-CONSENT-3`
**Evidence:**
When `loadConsentClient` falls back to the `oauth_client` D1 row for dynamically-registered clients, it returns `allowedScopes: parseScopeArray(row.scopes)` — the client's registered scope set. The consent UI then displays these scopes. However, there is no intersection check in `loadConsentClient` against the scopes that were actually requested in the authorization request (which are passed separately via the signed `oauth_query` string).

The only place that performs scope clamping is `app/routes/consent.tsx:144` ("suspenders" comment). This means the lib-layer helper returns a potentially over-broad scope list that the UI must defensively filter. If any future consumer of `loadConsentClient` omits the intersection step, it could authorize more scopes than the user intended.
**Risk:** Privilege escalation — a dynamically-registered client with a broad registered scope set could receive consent for scopes it didn't request in the current flow, if the UI intersection check is ever skipped.
**Recommendation:** Perform the intersection inside `loadConsentClient` by accepting the requested scopes as a parameter:
```ts
export async function loadConsentClient(
  env: Env,
  clientId: string,
  requestedScopes: string[],
): Promise<ConsentClientView | null>
```
Return `allowedScopes` as `intersection(registeredScopes, requestedScopes)` so the consumer never needs to filter. Add scenario `S-AUTH-OAUTH-CONSENT-3`.

### Finding C-4 — logoUri sanitization is delegated but not enforced at the lib layer
**Tags:** `severity:low` `category:security`
**Location:** `workers/auth/consent.ts:107-108`
**Scenario:** `coverage:none recommend:S-AUTH-OAUTH-CONSENT-1`
**Evidence:**
```ts
/** Logo URL — caller MUST pass through `safeHttpsHref` before rendering. */
logoUri: string | null;
```
The JSDoc comment says "caller MUST pass through `safeHttpsHref`" — but this is a documentation contract, not a type contract. `app/routes/consent.tsx:159` does call `safeHttpsHref(client.logoUri)`, so the currently-deployed route is safe. However, any future consumer of `loadConsentClient` that renders `logoUri` directly (e.g., a notifications panel, a Connected Agents card) would introduce an XSS vector.
**Risk:** XSS if a new consumer is added without reading the JSDoc warning.
**Recommendation:** Return a branded `SafeHref` type instead of `string | null`, or apply `safeHttpsHref` inside `loadConsentClient` / `trustedClientToView`. This makes safety structural rather than convention-only.

### Finding C-5 — submitConsentDecision forwards all cookies including non-session cookies
**Tags:** `severity:low` `category:security`
**Location:** `workers/auth/consent.ts:268-270`
**Scenario:** `coverage:none recommend:S-AUTH-OAUTH-CONSENT-1`
**Evidence:**
```ts
const cookie = request.headers.get("cookie");
if (cookie) headers.set("cookie", cookie);
```
All cookies from the browser request are forwarded to the internal sub-request. This includes the session token (required) but also any other cookies present (e.g., `anai.pkce_state`, analytics cookies, CF Access cookies). Forwarding all cookies to an internal same-origin sub-request is generally safe in Workers, but it is broader than necessary.
**Risk:** Low — within the same origin, extra cookies are harmless. The concern is forward-compatibility: if future middleware on the same origin inspects other cookies and takes action, the sub-request would trigger unexpected behavior.
**Recommendation:** Forward only the `__Host-anai.session_token` cookie:
```ts
const sessionCookieName = "__Host-anai.session_token";
const sessionToken = request.headers.get("cookie")
  ?.split(";")
  .find((c) => c.trim().startsWith(sessionCookieName + "="))
  ?.trim();
if (sessionToken) headers.set("cookie", sessionToken);
```

---

## File: workers/lib/bootstrap-owner.ts

### Finding B-1 — Race condition on email case-folding between lookup and insert
**Tags:** `severity:low` `category:correctness`
**Location:** `workers/lib/bootstrap-owner.ts:34-40`
**Scenario:** `scenario:S-AUTH-1`
**Evidence:**
```ts
const existing = await orm
  .select()
  .from(schema.users)
  .where(eq(schema.users.email, loginEmail))
  .get();
if (existing) return existing.id;
```
The lookup uses `eq(schema.users.email, loginEmail)` — a case-sensitive comparison in SQLite. The unique index is `lower(email)` (schema.ts:55). If `loginEmail` is `"Pavel@actionnow.ai"` but the row was inserted as `"pavel@actionnow.ai"`, the `eq` check will miss the row and proceed to the `INSERT ... ON CONFLICT DO NOTHING`. The `ON CONFLICT DO NOTHING` at line 55 will silently suppress the insert. The subsequent re-read at line 59 will return the existing lowercase row — so the function is ultimately correct.

However, the initial lookup silently misses an existing row, causing an unnecessary INSERT attempt (wasted D1 write) and, in the unlikely case of extremely tight concurrent timing, could momentarily appear as a failed insert before the re-read.
**Risk:** Negligible — the `onConflictDoNothing()` + re-read pattern is correct. The only overhead is an extra failed D1 write on case mismatch.
**Recommendation:** Use `sql\`lower(${schema.users.email}) = lower(${loginEmail})\`` in the initial lookup to match the index, OR document the intentional "let conflict handler sort it" design.

### Finding B-2 — bootstrap-owner.ts design is sound; idempotency verified
**Tags:** `severity:low` `category:correctness` (no finding — design verified)
**Location:** `workers/lib/bootstrap-owner.ts:24-65`
**Scenario:** `scenario:S-AUTH-1`
**Evidence:** The function is idempotent by construction: if the user exists, it returns early (line 40). The `INSERT ... ON CONFLICT DO NOTHING` collapses concurrent first-logins to a single insert. The re-read after insert (lines 59-64) ensures the returned id is always the committed row.

No finding. Design verified against D-V2U-1 first-login contract.

---

## File: workers/lib/mailbox-permissions.ts

### Finding MP-1 — canShare does not check mailbox_acls; relies on owner_user_id only
**Tags:** `severity:medium` `category:correctness`
**Location:** `workers/lib/mailbox-permissions.ts:41-56`
**Scenario:** `scenario:S-MAILBOX-2`
**Evidence:**
```ts
export function canShare(
  actor: AuthzContext,
  mailbox: MailboxRow,
  group: GroupRow,
): PermResult {
  if (isGlobal(actor.role)) return { ok: true };
  if (mailbox.owner_user_id !== actor.user_id) {
    return { ok: false, reason: "Only the mailbox owner can share it." };
  }
  // ...
```
After a mailbox ownership transfer (via `canTransfer` → `POST /:id/transfer`), the new owner's ACL row is an `admin` row in `mailbox_acls`. The `MailboxRow` type (lines 17-24) includes `owner_user_id` — which IS updated on transfer. So `canShare` correctly gates on `owner_user_id`. However, `MailboxRow` does NOT include ACL-level fields. A user with an `admin` ACL grant (but not `owner_user_id`) cannot share the mailbox even though D-V2U-1 and **D-aim-5** imply admin-grant holders should have write access.

Per **D-aim-5**, per-mailbox token scoping is application-layer — the `mailbox_acls` table defines per-user access levels (`read/write/admin`). `canShare` does not consult `mailbox_acls.level` at all: it only checks owner identity. An `admin`-level ACL grantee is silently denied share permission.
**Risk:** Correctness — users granted `admin` ACL cannot share mailboxes they administer. This is a spec divergence from D-aim-5 which says the application layer enforces per-mailbox scoping. The current implementation conflates "owner" with "admin ACL".
**Recommendation:** Extend `canShare` (and potentially `canUnshare`) to accept the caller's `mailbox_acls.level` and treat `admin` level as equivalent to owner for sharing purposes. Add a test in S-MAILBOX-2 variants.

### Finding MP-2 — D-aim-5 per-mailbox token scoping: correctly enforced at authz-context layer
**Tags:** `severity:low` `category:correctness` (no finding — verified)
**Location:** `workers/middleware/authz-context.ts:188-194`
**Scenario:** `scenario:S-CLI-2`
**Evidence:**
Service tokens are restricted to `authorized_mailbox_ids: [token.mailbox_id]` at line 193. The `authorized_mailbox_ids` field on `AuthzContext` is the application-layer enforcement vehicle. Per **D-aim-5**, per-mailbox token scoping is application-layer — the DB `mailbox_acls` table is the authority but the enforcement is in the authz middleware. Verified: service tokens receive a single-element `authorized_mailbox_ids` list, and all route handlers that gate on `authzContext.authorized_mailbox_ids` respect this constraint.

No finding. D-aim-5 verified.

### Finding MP-3 — canDelete, canTransfer: clean; no issues found
**Tags:** N/A (no finding)
**Location:** `workers/lib/mailbox-permissions.ts:87-113`
**Scenario:** `scenario:S-MAILBOX-1, S-INBOX-2`
**Evidence:** Both predicates correctly check `owner_user_id` and global role; no privilege escalation path found. Design verified against D-V2U-1.

---

## File: workers/lib/visibility-filter.ts

### Finding V-1 — 5-tier hierarchy missing: contacts-of-contacts and explicit-allow tiers not implemented
**Tags:** `severity:high` `category:correctness`
**Location:** `workers/lib/visibility-filter.ts:19`, `workers/lib/visibility-filter.ts:83-139`
**Scenario:** `coverage:none recommend:S-CONTACTS-VIS-COC-1, S-CONTACTS-VIS-EXPLICIT-1`
**Evidence:**
The audit directive specifies a **5-tier hierarchy**: `everyone / contacts-only / contacts-of-contacts / nobody / explicit allow`.

The current implementation supports only **3 tiers**:
```ts
export type VisibilityValue = "everyone" | "contacts" | "nobody";
```
The schema `users.visibility` column also only has these 3 values.

Tier 3 (`contacts-of-contacts`) — "visible to users who share a contact with the actor" — is absent. There is no `VisibilityValue` for it, no logic in `filterVisibleUsers`, and no scenario testing it.

Tier 5 (`explicit allow`) — granular per-user visibility grants — is absent. There is no `user_visibility_acls` table or similar mechanism.

The code comment at line 10 references only "everyone + self + co-members" (Phase 3) and "contacts and nobody" (Phase 6), with no mention of a contacts-of-contacts tier.
**Risk:** Correctness against documented spec (USR-directive-5 / USR-good-practice-2). Users with `contacts-only` visibility ARE correctly hidden from non-contacts in Phase 6 mode. But the `contacts-of-contacts` tier is architecturally absent — it is not stubbed, not deferred, and the schema does not support it. Any feature that relies on this tier will silently treat affected users as `nobody`.
**Recommendation:**
1. Confirm with the user whether `contacts-of-contacts` is a documented requirement or was included in the audit spec by mistake. If it IS required, it needs both a schema extension and new query logic (second-order contact lookup).
2. Add `S-CONTACTS-VIS-COC-1` to track the gap. Until implemented, document the limitation in `visibility-filter.ts`.

### Finding V-2 — enforceContactsAndNobody flag defaults to false — production callers must opt in
**Tags:** `severity:medium` `category:correctness`
**Location:** `workers/lib/visibility-filter.ts:64`, `workers/routes/invitations.ts:548`, `workers/routes/mailboxes.ts:662`
**Scenario:** `scenario:S-CONTACTS-1`
**Evidence:**
```ts
enforceContactsAndNobody?: boolean; // defaults to false
```
Both production callers (`invitations.ts:548`, `mailboxes.ts:662`) correctly pass `enforceContactsAndNobody: true`. However, the default value of `false` means any future caller that omits the flag will silently enter "Phase 3 mode" — which includes ALL active users in autocomplete results, ignoring `contacts` and `nobody` visibility settings. This is a latent privacy regression waiting for a careless new call site.
**Risk:** Privacy regression — a new autocomplete endpoint added without `enforceContactsAndNobody: true` would expose `visibility='nobody'` users to all actors.
**Recommendation:** Change the default to `true` and add an explicit `enforceContactsAndNobody: false` override to any caller that intentionally needs Phase 3 semantics (e.g., admin panel user listing). This makes the safe behavior the default.

### Finding V-3 — Phase 3 mode includes disabled users in co-member path
**Tags:** `severity:low` `category:correctness`
**Location:** `workers/lib/visibility-filter.ts:103-138`
**Scenario:** `scenario:S-CONTACTS-1`
**Evidence:**
In Phase 3 mode (`enforceContactsAndNobody = false`), the filter checks `u.status !== "active"` at line 105 (correctly rejects disabled users) but then includes all remaining users. In Phase 6 mode, co-member inclusion (`coMemberIds.has(u.id)`) fires before the status check. The status check is first, so disabled co-members ARE excluded. This is correct.

However, in Phase 3 mode's `else` branch (lines 133-138):
```ts
} else {
  // Phase 3: include all active users (enforcement deferred)
  if (coMemberIds.has(u.id)) return true;
  return true;  // ← This is always true anyway
}
```
The `if (coMemberIds.has(u.id)) return true;` is dead code — the unconditional `return true` below it means all active users are included. This is harmless but misleading.
**Risk:** None at runtime. The dead code creates confusion about the Phase 3 intent.
**Recommendation:** Remove the dead co-member check from the Phase 3 branch, or add a comment explaining its presence as a historical marker.

---

## File: workers/db/schema.ts

### Finding DB-1 — emails table missing indexes on thread_id and message_id
**Tags:** `severity:medium` `category:schema`
**Location:** `workers/db/schema.ts:13-39`
**Scenario:** `scenario:S-MSG-2`
**Evidence:**
The `emails` table has no indexes defined in the Drizzle schema (no `(t) => ({...})` block):
```ts
export const emails = sqliteTable("emails", {
  ...
  thread_id: text("thread_id"),
  message_id: text("message_id"),
  ...
});
```
`thread_id` is used in every threading query (fetching messages in a thread). `message_id` is used for duplicate detection and in-reply-to resolution. Both are queried frequently in the hot path of `appendToThread` and email fetch. Without an index, these are full-table scans in the Durable Object SQLite.
**Risk:** Performance — mailboxes with many emails will see linear-time thread fetches. In a Durable Object context where SQLite is per-mailbox, the impact is bounded but real for active mailboxes.
**Recommendation:** Add indexes:
```ts
(t) => ({
  threadIdx: index("emails_thread_id_idx").on(t.thread_id),
  messageIdIdx: index("emails_message_id_idx").on(t.message_id),
  folderIdx: index("emails_folder_id_idx").on(t.folder_id), // also missing
})
```

### Finding DB-2 — threads.tip_message_id is a documented "logical FK" but lacks enforcement
**Tags:** `severity:low` `category:schema`
**Location:** `workers/db/schema.ts:66-77`
**Scenario:** `coverage:none recommend:S-MSG-THREAD-1`
**Evidence:**
```ts
/** Logical FK → emails.id — the most-recently appended message. */
tip_message_id: text("tip_message_id"),
```
The comment acknowledges this is intentionally unenforced. Acceptable in the Durable Object context (SQLite foreign_keys pragma is off). Documented and understood — no action required beyond noting the design choice.

No finding beyond documentation. Design is intentional per the code comment.

---

## File: workers/db/control-plane/schema.ts

### Finding S-1 — oauth_refresh_token.token is NOT UNIQUE — allows token replay attacks
**Tags:** `severity:critical` `category:security`
**Location:** `workers/db/control-plane/schema.ts:563`
**Scenario:** `coverage:none recommend:S-AUTH-OAUTH-TOKEN-1`
**Evidence:**
```ts
export const oauth_refresh_token = sqliteTable(
  "oauth_refresh_token",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull(),   // ← NO .unique() !!
    ...
  },
  (t) => ({
    tokenIdx: index("oauth_refresh_token_token_idx").on(t.token),  // index only, not UNIQUE
    ...
  }),
);
```
The `token` column has only a non-unique index. Compare to `session.token` (line 292: `.notNull().unique()`) and `oauth_personal_access_token.tokenHash` (line 633: `.notNull().unique()`). For a refresh token, uniqueness is a security invariant: if two rows can have the same token value, a race in the token rotation endpoint could accept both, issuing two access tokens for one refresh. Worse, a corrupt row insert (bug or migration error) producing a duplicate token would silently succeed.

The `oauth_access_token.token` column at line 594 has `.unique()`, confirming this was intentional for access tokens but was missed for refresh tokens.
**Risk:** Critical — token replay if duplicate refresh token rows are ever created (unlikely under normal operation but possible under a race or migration error). Any lookup of `oauth_refresh_token` by `token` value would return an arbitrary one of the duplicates.
**Recommendation:** Add `.unique()` to the token column:
```ts
token: text("token").notNull().unique(),
```
And add a migration to add the unique constraint to the existing table.

### Finding S-2 — contacts table missing index on contact_user_id
**Tags:** `severity:medium` `category:schema`
**Location:** `workers/db/control-plane/schema.ts:60-86`
**Scenario:** `scenario:S-CONTACTS-2`
**Evidence:**
The `contacts` table has a composite primary key on `(owner_user_id, contact_user_id)`. This creates an implicit index on `owner_user_id` as the leading key, which serves `SELECT ... WHERE owner_user_id = ?` queries efficiently. However, `contact_user_id` has no separate index, so reverse lookups (`SELECT ... WHERE contact_user_id = ?`) — needed to check "who has X in their contacts", used in block-cascade cleanup (S-CONTACTS-4) and in `enforceContactsAndNobody` block-set construction — are full-table scans.
**Risk:** Performance degradation as the contacts table grows. The block-cascade path (`S-CONTACTS-4`) traverses all contact rows to remove mirror entries.
**Recommendation:**
```ts
(t) => ({
  pk: primaryKey({ columns: [t.owner_user_id, t.contact_user_id] }),
  contactUserIdx: index("contacts_contact_user_id_idx").on(t.contact_user_id),
})
```

### Finding S-3 — group_invitations missing index on invitee_user_id
**Tags:** `severity:medium` `category:schema`
**Location:** `workers/db/control-plane/schema.ts:121-149`
**Scenario:** `scenario:S-NOTIFICATIONS-1`
**Evidence:**
`workers/routes/notifications.ts:63` queries `group_invitations WHERE invitee_user_id = ctx.user_id` — this is the notification bell's unseen-count query. The only index on `group_invitations` is the partial unique index on `(group_id, invitee_email) WHERE status='pending'`. The `invitee_user_id` column has no index. Every `GET /api/notifications/unseen` call (polled from the frontend) is a full-table scan on `group_invitations`.
**Risk:** Performance — the notification poll fires on every page load. As invitation volume grows, this becomes increasingly expensive.
**Recommendation:**
```ts
(t) => ({
  pendingIdx: uniqueIndex("group_invitations_pending")
    .on(t.group_id, t.invitee_email)
    .where(sql`${t.status} = 'pending'`),
  inviteeUserIdx: index("group_invitations_invitee_user_idx").on(t.invitee_user_id),
})
```

### Finding S-4 — groups.owner_user_id has no cascade or set-null on user delete
**Tags:** `severity:medium` `category:schema`
**Location:** `workers/db/control-plane/schema.ts:93-95`
**Scenario:** `coverage:none recommend:S-ADMIN-USER-DELETE-1`
**Evidence:**
```ts
owner_user_id: text("owner_user_id")
  .notNull()
  .references(() => users.id),  // no onDelete clause
```
No `onDelete` clause means the default behavior (SQLite: `RESTRICT`) applies — attempting to delete a user who owns a group will fail with a FK constraint violation. This is not necessarily wrong (the system should require group ownership transfer before user deletion), but it is undocumented and the admin user-delete handler (`workers/routes/admin/users.ts` — Teammate B's scope) needs to handle this constraint gracefully.

Similarly, `mailboxes.owner_user_id` at line 158-160 has the same pattern.
**Risk:** User delete will silently fail with a FK constraint error unless the handler explicitly transfers ownership or reassigns rows. No meaningful data loss risk, but the UX is broken.
**Recommendation:** Either: (a) add `onDelete: "restrict"` explicitly and document it, requiring handlers to transfer before deleting, OR (b) change to `onDelete: "set null"` (requires making `owner_user_id` nullable) and handle orphan groups via a cleanup job. Document the chosen policy in `DECISIONS.md`.

**Note for Teammate B:** The admin user-delete handler at `workers/routes/admin/users.ts:363` must check whether the target user owns any groups or mailboxes before attempting deletion, or the FK constraint will surface as an unhandled 500.

### Finding S-5 — contacts.initiated_by has no cascade on user delete
**Tags:** `severity:low` `category:schema`
**Location:** `workers/db/control-plane/schema.ts:72-74`
**Scenario:** `coverage:none recommend:S-ADMIN-USER-DELETE-1`
**Evidence:**
```ts
initiated_by: text("initiated_by")
  .notNull()
  .references(() => users.id),  // no onDelete
```
`initiated_by` tracks who sent the original contact request. Deleting the initiator user will be blocked by the FK constraint. The `owner_user_id` and `contact_user_id` columns correctly have `onDelete: "cascade"`, which would delete the row when either party is deleted. But `initiated_by` blocks user deletion even after both contact parties' rows cascade-delete... except in practice, the row is deleted by the cascade on `owner_user_id` before the `initiated_by` FK violation occurs. So the FK constraint on `initiated_by` is unreachable in normal operation (the cascade on `owner_user_id` fires first).
**Risk:** Negligible — the `initiated_by` FK constraint is effectively dead because the row is always cascade-deleted before the `initiated_by` user deletion can be attempted. However, it is a latent correctness issue if the cascade order changes.
**Recommendation:** Add `onDelete: "set null"` to `initiated_by` to make the intent explicit:
```ts
initiated_by: text("initiated_by")
  .notNull()
  .references(() => users.id, { onDelete: "set null" }),
```
But change `notNull()` to optional first. Or simply document that the cascade on `owner_user_id` makes this unreachable.

### Finding S-6 — account table missing UNIQUE constraint on (provider_id, account_id)
**Tags:** `severity:medium` `category:schema`
**Location:** `workers/db/control-plane/schema.ts:324-327`
**Scenario:** `scenario:S-AUTH-1`
**Evidence:**
```ts
(t) => ({
  userIdIdx: index("account_user_id_idx").on(t.userId),
  providerIdx: index("account_provider_idx").on(t.providerId, t.accountId),
  // ↑ Non-unique index only
})
```
The `account` table has a non-unique compound index on `(provider_id, account_id)`. Better-auth looks up accounts by `(providerId, accountId)` to find the user's provider-specific credentials. Without a UNIQUE constraint, a race condition or bug could insert duplicate `(emailotp, alice@actionnow.ai)` rows, causing ambiguous lookups.

The `session.token` column (line 292) has `.unique()` for the same reason — this was missed in `account`.
**Risk:** Correctness — unlikely in normal operation (better-auth manages this table), but a schema-level UNIQUE would catch bugs early and prevent silent duplicates.
**Recommendation:** Change the index to `uniqueIndex`:
```ts
providerIdx: uniqueIndex("account_provider_idx").on(t.providerId, t.accountId),
```

### Finding S-7 — oauth_client.clientSecret stored as plaintext text column
**Tags:** `severity:low` `category:security`
**Location:** `workers/db/control-plane/schema.ts:498`
**Scenario:** `coverage:none recommend:S-AUTH-OAUTH-CONSENT-1`
**Evidence:**
```ts
clientSecret: text("client_secret"),
```
The `client_secret` for dynamically-registered OAuth clients is stored as a plain text column. The `agent_tokens.secret_hash` column (line 221) shows the pattern for hashed storage. For OAuth clients, `client_secret` is typically hashed (bcrypt or HMAC) before storage — presenting the plaintext only once on DCR response.

The comment at line 492 says "Public clients (PKCE-only, e.g. Claude Code desktop) leave `client_secret` NULL." For confidential clients (server-side MCP backends), the secret would be stored here in plaintext.
**Risk:** If the D1 database is ever exposed (dump, misconfigured backup), all confidential OAuth client secrets are compromised. Standard OAuth server practice is to hash client secrets.
**Recommendation:** Hash `client_secret` before storage using the existing `TOKEN_PEPPER` HMAC pattern from `agent_tokens`. Store the hash, not the plaintext. Issue the plaintext only once on registration. Add a `client_secret_prefix` column analogous to `oauth_personal_access_token.tokenPrefix` for display purposes.

### Finding S-8 — groups.name has no UNIQUE constraint (per group scope or global)
**Tags:** `severity:low` `category:schema`
**Location:** `workers/db/control-plane/schema.ts:88-98`
**Scenario:** `scenario:S-GROUP-1`
**Evidence:**
```ts
export const groups = sqliteTable("groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // No unique constraint
```
Duplicate group names are allowed at the schema level. The application may enforce uniqueness at the route layer (Teammate B's scope), but without a DB constraint, concurrent creates or a direct SQL insert could produce duplicate-named groups under the same owner or globally.
**Risk:** Low — duplicate group names confuse users and make it hard to identify the correct group in autocomplete.
**Recommendation:** Add a unique index on `(owner_user_id, name)` to prevent duplicate group names per owner:
```ts
(t) => ({
  ownerNameIdx: uniqueIndex("groups_owner_name_unique").on(t.owner_user_id, t.name),
})
```

### Finding S-9 — verification table missing UNIQUE constraint on identifier
**Tags:** `severity:low` `category:schema`
**Location:** `workers/db/control-plane/schema.ts:330-344`
**Scenario:** `scenario:S-AUTH-1`
**Evidence:**
```ts
export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    // No unique constraint — only a non-unique index
  },
  (t) => ({
    identifierIdx: index("verification_identifier_idx").on(t.identifier),
    ...
  }),
);
```
The `identifier` field (typically the email address for OTP verification) has only a non-unique index. Multiple concurrent OTP sends to the same email could create multiple `verification` rows with the same `identifier`. Better-auth's OTP plugin likely handles this by upsert, but a DB-level UNIQUE would prevent silent duplicates.
**Risk:** Low — better-auth manages this table and likely queries by `(identifier, value)` or updates existing rows.
**Recommendation:** Confirm whether better-auth's emailOTP plugin requires multiple verification rows per identifier (e.g., for different purposes). If not, add `uniqueIndex("verification_identifier_idx").on(t.identifier)` to replace the current non-unique index.

---

## File: workers/db/control-plane/forGroup.ts

### Finding F-1 — forGroup() is a structural wrapper only; no actual group-scoping enforcement
**Tags:** `severity:low` `category:correctness`
**Location:** `workers/db/control-plane/forGroup.ts:29-38`
**Scenario:** `scenario:S-GROUP-1`
**Evidence:**
```ts
export function forGroup(db: D1Database, ctx: AuthzContext) {
  const orm = drizzle(db, { schema });
  return {
    db: orm,
    ctx,
    schema,
  };
}
```
`forGroup()` returns a plain Drizzle ORM handle. It does NOT add any WHERE clause, query interceptor, or proxy that automatically scopes queries to `ctx.group_ids`. The security guarantee is entirely social/architectural: the CI grep-lint is supposed to forbid `drizzle()` calls outside of this file, so all group_members queries go through callers that have `ctx` in scope and are therefore expected to add their own `group_id` filters.

This is architecturally correct as a discipline chokepoint, but it is documentation-only enforcement. A caller that receives `forGroup(...).db` can query ANY table including `group_members` without any filter, and the function will not stop it.
**Risk:** Low at runtime (routes already add their own filters). The risk is architectural: if the CI grep-lint rule is not enforced, or if a new engineer bypasses `forGroup()` with a direct `drizzle()` call (as seen in `mailbox-tree.ts` and `authz-context.ts`), there is no runtime guard.
**Recommendation:** Add a comment to `forGroup.ts` explicitly documenting the enforcement model ("this is a chokepoint by convention; the CI rule in `.github/workflows/` is the actual guard"). Consider whether a Proxy-based row-level security approach would be worth implementing in a future hardening pass.

### Finding F-2 — forGroup.ts design verified against D-V2F-3
**Tags:** N/A (no finding)
**Location:** `workers/db/control-plane/forGroup.ts:1-38`
**Scenario:** `scenario:S-GROUP-1`
**Evidence:** The file correctly exports `AuthzContext` type, `forGroup()` factory, and `ForGroupHandle` type. Every route that was checked (`groups.ts`, `invitations.ts`, `mailboxes.ts`, `notifications.ts`) obtains its drizzle handle via `forGroup(c.env.DB, ctx).db` before querying `group_members`. The two violations (authz-context.ts and mailbox-tree.ts — see CC-1) are in infrastructure layers that need group membership to bootstrap ctx, which is a documented exception to the rule. The rule is consistently applied at the route layer.

---

## Coverage gaps recommended for new scenarios

Based on the orphan-surfaces table and findings above:

| Recommended ID | Surface | Gap |
|---|---|---|
| `S-AUTH-OAUTH-CONSENT-1` | `workers/auth/consent.ts` | Full consent flow: valid sig+exp → 200 consent page |
| `S-AUTH-OAUTH-CONSENT-2` | `workers/auth/consent.ts` | Plugin error body not reflected in HTTP response |
| `S-AUTH-OAUTH-CONSENT-3` | `workers/auth/consent.ts` | Scope intersection enforced at consent page |
| `S-AUTH-OTP-RATELIMIT` | `workers/auth/index.ts` | OTP rate limit triggers 429 after N attempts |
| `S-CONTACTS-VIS-COC-1` | `workers/lib/visibility-filter.ts` | contacts-of-contacts tier (currently missing) |
| `S-CONTACTS-VIS-EXPLICIT-1` | `workers/lib/visibility-filter.ts` | explicit-allow tier (currently missing) |
| `S-AUTH-OAUTH-TOKEN-1` | `workers/db/control-plane/schema.ts` | Refresh token uniqueness — duplicate token rejected |
| `S-ADMIN-USER-DELETE-1` | `workers/db/control-plane/schema.ts` | User delete with owned groups/mailboxes → handled gracefully |
| `S-GROUP-FORGROUPDISCIPLINE-1` | D-V2F-3 | CI lint catches direct group_members access outside forGroup |

---

## Open questions / blockers

1. **5-tier vs 3-tier visibility (Finding V-1):** The audit brief specifies `contacts-of-contacts` and `explicit allow` as tiers 3 and 5. The codebase, schema, and all existing documentation only implement a 3-tier system (`everyone / contacts / nobody`). This may be a spec aspirational goal rather than a current implementation requirement. **Needs user confirmation** before filing as a "missing feature" vs "known deferred tier."

2. **INVITATION_HMAC_KEY not in Env type or wrangler.jsonc:** `workers/routes/invitations.ts:217` reads `INVITATION_HMAC_KEY` via `c.env as unknown as Record<string, string>` with a `"dev-fallback-hmac-key"` default. If this secret is absent in production (`wrangler secret put` was never run), all HMAC tokens for invitations use the hardcoded dev secret. This is a cross-cutting finding that touches both `workers/routes/invitations.ts` (Teammate B) and the secrets management (not in partition). **Flagged here for team awareness; Teammate B should verify the production secret is set.**

3. **forGroup() CI grep-lint existence:** Finding CC-1 references a CI grep-lint rule (`rg 'from\(.*group_members' workers/`). This rule is mentioned in `D-V2F-3` as the enforcement mechanism but no `.github/workflows/` file or `package.json` lint script referencing this grep was observed during the audit. Static reading could not confirm whether the CI rule is actually deployed. **Blocker for full CC-1 risk assessment.**

4. **oauth_client.clientSecret plaintext (Finding S-7):** Whether `@better-auth/oauth-provider` supports pre-hashed client secrets or requires plaintext for PKCE public clients is unclear from static reading alone. If the plugin mandates plaintext for confidential clients, hashing at the application layer before passing to the plugin would break its verification. **Needs library documentation review before implementing.**

---

**End of Audit Report — Teammate A (auth + lib + db)**
