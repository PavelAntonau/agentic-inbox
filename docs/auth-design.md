# Auth Design — Anti-Enumeration Stance

**Status:** Decided 2026-05-08 (resolves OQ-3 from the mobile-native redesign action plan).
**Owner:** mail.actionnow.ai auth surface.
**Scope:** `/login` email-entry, OTP-send, OTP-verify, signup-gate.

## Decision

The auth surface MUST treat all email submissions identically regardless of whether the address is invited, registered, well-formed, or typo'd. No client-side TLD typo feedback. No server-side TLD allowlist. No status code or response body that distinguishes "valid TLD but not invited" from "invited but wrong OTP" from "shape OK but unparseable domain".

This is the **anti-enumeration** stance, chosen over a typo-feedback UX. Strongest privacy posture; matches Phase G / TASK-1.1 (OQ-PG-1) enumeration-parity regression discipline.

## What "anti-enumeration" means in this codebase

| Layer | Behavior |
|---|---|
| **Client** (`app/routes/login.tsx`) | `EMAIL_SHAPE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/` — accepts loose shape only. No TLD allowlist. No "did you mean gmail.com?" hint. The button gates on shape alone; the server is the source of truth. |
| **Server: rate-limit** (`workers/middleware/auth-rate-limit.ts`) | Per-(email, path) cap (5 / 15 min). Email is SHA-256-hashed before storage so D1 dumps cannot expose enumeration targets. Identical 429 JSON shape to better-auth's per-IP rule. |
| **Server: signup gate** (`workers/auth/index.ts` `evaluateSignupGate`) | All non-bootstrap deny paths return `APIError("UNAUTHORIZED", { message: "Sign-up not permitted." })`. Timing-padded with `signupTimingPad()` so the permit and deny branches take indistinguishable wall-clock time. |
| **Server: OTP send/verify** (`workers/app.ts`) | Returns `200 OK` regardless of whether the address is invited. The OTP is generated and stored, but the email send is `ctx.waitUntil`-deferred and only fires for invited addresses. Attackers cannot infer invite status from the response. |
| **Server: OTP verify failure** | Identical response shape to "wrong OTP for invited email" and "no OTP outstanding". Asserted by `workers/auth/enumeration-parity.test.ts` (post-Phase-2 regression). |

## Rejected alternatives

| Alternative | Rejected because |
|---|---|
| **Client-side TLD typo hint** ("gmial.com → did you mean gmail.com?") for ~6 well-known TLDs | Adds UX value but training users to expect feedback weakens the anti-enumeration mental model and creates pressure to extend feedback to other channels (rate-limit responses, OTP verify, etc.) |
| **Server-side TLD allowlist** (reject submissions whose TLD isn't curated) | Directly leaks information — an attacker learns which TLDs the system considers "real" without a single sent OTP. Antithetical to enumeration parity. |

## Operational notes

- **Telemetry MAY differentiate.** Internal Analytics Engine emits `OTP_SEND_OK` vs `OTP_SEND_FAIL` with the actor email. This is observability, not a user-visible response. Logs are access-controlled.
- **Rate-limit responses are identical across `email` keys.** The 429 carries no email-specific information beyond the standard `Retry-After` header.
- **Bootstrap-owner path** is the one exception: when `BOOTSTRAP_OWNER_EMAIL` is set AND the submitted email matches AND no owner exists yet, the response differs (it's a one-shot signup). This is acceptable because the bootstrap email is operator-known, not attacker-discoverable.

## References

- `workers/auth/enumeration-parity.test.ts` — regression guard that the OTP-verify path stays parity-equivalent across invited / not-invited.
- `workers/middleware/auth-rate-limit.ts` — per-email rate-limit with hashed-key storage.
- `workers/auth/index.ts` `signupTimingPad`, `evaluateSignupGate` — timing-flattened deny path.
- Phase G / TASK-1.1 (OQ-PG-1) — original enumeration-parity flip from FORBIDDEN to UNAUTHORIZED.
- `.research/action-plan-agentic-inbox-mobile-native-redesign.md` — OQ-3 source.
