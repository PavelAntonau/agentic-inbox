// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// T2.1 (mcp-oauth) — branded OAuth consent screen.
//
// Lifecycle:
//
//   1. User completes the OAuth client's `/oauth2/authorize` request →
//      `@better-auth/oauth-provider` redirects them here with a SIGNED
//      query string carrying `client_id`, `scope`, `redirect_uri`, `state`,
//      `code_challenge`, `code_challenge_method`, `resource`, `exp`, `sig`.
//
//   2. This loader:
//        a. requires a valid better-auth session (else → /login?redirect=...);
//        b. re-verifies the plugin's `sig`+`exp` to detect tampering or
//           replay;
//        c. resolves client metadata (trusted SSOT first, D1 fallback);
//        d. issues a single-use `__Host-CSRF_TOKEN` cookie + form token;
//        e. returns a JSON envelope of sanitized display fields, the
//           original signed query (passed through verbatim), and the
//           CSRF form token.
//
//   3. User clicks Approve or Deny in the rendered UI. The `<Form>` POSTs
//      back to this same route. The action:
//        a. requires the same valid session;
//        b. re-derives the CSRF check (cookie value === form value AND
//           HMAC-binds to user_id);
//        c. re-verifies the sig on `oauth_query` (defense in depth — the
//           plugin's POST endpoint will re-verify too);
//        d. forwards the decision to the plugin's `/api/auth/oauth2/consent`
//           endpoint and reads back the `redirect_uri`;
//        e. issues a 303 redirect to the OAuth client's redirect URI and
//           burns the `__Host-CSRF_TOKEN` cookie unconditionally.
//
// Trusted-client UX note: the plugin's `skip_consent=1` rows bypass this
// screen entirely (per `@better-auth/oauth-provider/dist/index.mjs:3834`).
// This route is therefore primarily for dynamically-registered clients
// AND for deliberate `prompt=consent` re-prompting against trusted ones.

import {
  type ActionFunctionArgs,
  Form,
  type LoaderFunctionArgs,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import { useState } from "react";
import { Button, Loader } from "~/ui";
import {
  burnCsrfCookie,
  CSRF_FORM_FIELD,
  issueCsrfToken,
  verifyCsrfFromRequest,
} from "~/lib/csrf";
import { clampLength, escapeHtmlText, safeHttpsHref } from "~/lib/sanitize";
import {
  ConsentForwardError,
  loadConsentClient,
  submitConsentDecision,
  verifyOAuthQuerySignature,
} from "../../workers/auth/consent";
import { createAuth } from "../../workers/auth";
import type { Env } from "../../workers/types";

interface ConsentLoaderData {
  client: {
    clientId: string;
    clientName: string;
    /** May be undefined when sanitization rejected the input. */
    clientUri?: string;
    /** May be undefined when sanitization rejected the input. */
    logoUri?: string;
    description: string;
    source: "trusted" | "registered";
  };
  /** Scopes the OAuth client is asking for, intersected with what's allowed. */
  requestedScopes: string[];
  /** Verbatim signed query string from the plugin (no leading `?`). */
  oauthQuery: string;
  /** CSRF form token (matches the just-set `__Host-CSRF_TOKEN` cookie). */
  csrfToken: string;
  /** Logged-in user's email — surfaced for the "you are signed in as" line. */
  userEmail: string;
}

interface ConsentActionData {
  error: string;
}

export function meta() {
  return [{ title: "Authorize access | Agentic Inbox" }];
}

/* -------------------------------------------------------------------------- */
/* Loader                                                                     */
/* -------------------------------------------------------------------------- */

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = (context as { cloudflare?: { env?: Env } }).cloudflare?.env;
  if (!env) throw new Response("Server misconfigured", { status: 500 });

  const url = new URL(request.url);
  const queryString = url.search.startsWith("?")
    ? url.search.slice(1)
    : url.search;

  const auth = createAuth(env);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return redirect(
      `/login?redirect=${encodeURIComponent(url.pathname + url.search)}`,
    );
  }

  const sig = await verifyOAuthQuerySignature(
    queryString,
    env.BETTER_AUTH_SECRET,
  );
  if (!sig.ok) {
    throw new Response(`Invalid consent request (${sig.reason})`, {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const clientId = sig.params.get("client_id");
  if (!clientId) {
    throw new Response("Invalid consent request (client_id missing)", {
      status: 400,
    });
  }

  const client = await loadConsentClient(env, clientId);
  if (!client) {
    throw new Response("Unknown OAuth client", { status: 404 });
  }

  const requested = sig.params.get("scope")?.split(/\s+/).filter(Boolean) ?? [];
  // Intersect against the client's allowed list — if the OAuth client tried
  // to ask for a scope outside its permitted subset, the plugin would have
  // rejected at /oauth2/authorize already; intersecting here is belt-and-
  // suspenders so the consent UI never DISPLAYS a scope the client cannot
  // actually receive.
  const allowed = new Set(client.allowedScopes);
  const requestedScopes = requested.filter((s) => allowed.has(s));

  const csrf = await issueCsrfToken(env.BETTER_AUTH_SECRET, session.user.id);

  // Sanitize display fields. React would auto-escape interpolated text, but
  // we run sanitizeText through a length cap and run the URL through the
  // HTTPS-allowlist sanitizer so an attacker-controlled `logo_uri` cannot
  // inject `javascript:` into an `<img>` src OR a `<a>` href.
  const sanitized: ConsentLoaderData["client"] = {
    clientId: client.clientId,
    clientName: clampLength(client.clientName, 80) || client.clientId,
    clientUri: safeHttpsHref(client.clientUri),
    logoUri: safeHttpsHref(client.logoUri),
    description: clampLength(client.description, 240),
    source: client.source,
  };

  const data: ConsentLoaderData = {
    client: sanitized,
    requestedScopes,
    oauthQuery: queryString,
    csrfToken: csrf.token,
    userEmail: session.user.email,
  };

  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": csrf.cookie,
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Action                                                                     */
/* -------------------------------------------------------------------------- */

export async function action({ request, context }: ActionFunctionArgs) {
  const env = (context as { cloudflare?: { env?: Env } }).cloudflare?.env;
  if (!env) throw new Response("Server misconfigured", { status: 500 });

  const auth = createAuth(env);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    throw new Response("Unauthorized", { status: 401 });
  }

  const formData = await request.formData();
  const formToken = formData.get(CSRF_FORM_FIELD);
  const csrfOk = await verifyCsrfFromRequest(
    request,
    typeof formToken === "string" ? formToken : null,
    env.BETTER_AUTH_SECRET,
    session.user.id,
  );
  // Build the burn header up-front — emit it on every code path so the
  // cookie cannot survive the round-trip regardless of outcome.
  const burnHeader = burnCsrfCookie();

  if (!csrfOk) {
    return new Response(
      JSON.stringify({ error: "CSRF check failed. Reload and try again." }),
      {
        status: 403,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Set-Cookie": burnHeader,
          "Cache-Control": "no-store",
        },
      },
    );
  }

  const oauthQuery = (formData.get("oauth_query") ?? "").toString();
  const sig = await verifyOAuthQuerySignature(
    oauthQuery,
    env.BETTER_AUTH_SECRET,
  );
  if (!sig.ok) {
    return new Response(
      JSON.stringify({ error: `Invalid consent request (${sig.reason}).` }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Set-Cookie": burnHeader,
          "Cache-Control": "no-store",
        },
      },
    );
  }

  const decision = (formData.get("decision") ?? "").toString();
  const accept = decision === "approve";
  // The user's selected scope subset arrives as one form field per accepted
  // scope; collect into a space-separated string (plugin's contract).
  const acceptedScopes = formData
    .getAll("scope")
    .map((v) => v.toString())
    .filter(Boolean)
    .join(" ");

  try {
    const { redirectUri } = await submitConsentDecision(request, env, {
      accept,
      scope: acceptedScopes || undefined,
      oauthQuery,
    });
    return new Response(null, {
      status: 303,
      headers: {
        Location: redirectUri,
        "Set-Cookie": burnHeader,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const message =
      err instanceof ConsentForwardError
        ? `Consent submission failed (${err.status}).`
        : `Consent submission failed.`;
    return new Response(JSON.stringify({ error: message }), {
      status: 502,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": burnHeader,
        "Cache-Control": "no-store",
      },
    });
  }
}

/* -------------------------------------------------------------------------- */
/* UI                                                                         */
/* -------------------------------------------------------------------------- */

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  "mcp:mailbox:read": "Read your mail and folders",
  "mcp:mailbox:write": "Send mail and modify your folders",
  "mcp:contacts:read": "Read your contacts",
  "mcp:contacts:write": "Add and update contacts",
  "mcp:profile:read": "Read your profile (display name, email)",
};

function describeScope(scope: string): string {
  return SCOPE_DESCRIPTIONS[scope] ?? scope;
}

export default function ConsentRoute() {
  const data = useLoaderData<typeof loader>() as ConsentLoaderData;
  const action = useActionData<typeof action>() as
    | ConsentActionData
    | undefined;
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";

  // Default: all requested scopes are accepted. Users can untick to grant
  // less. The plugin treats an empty submitted scope set as "accept the
  // originally requested set", but we surface the choice explicitly.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(data.requestedScopes),
  );

  function toggleScope(scope: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg p-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-semibold text-text-bright">
            Authorize access
          </h1>
          <p className="text-sm text-text-muted mt-1">
            Signed in as{" "}
            <span className="text-text-bright">{data.userEmail}</span>
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-6 shadow-lg">
          <header className="flex items-center gap-3 mb-4">
            {data.client.logoUri ? (
              <img
                src={data.client.logoUri}
                alt=""
                aria-hidden="true"
                className="h-10 w-10 rounded-lg border border-border bg-bg object-cover"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div
                aria-hidden="true"
                className="h-10 w-10 rounded-lg border border-border bg-bg flex items-center justify-center text-text-muted text-xs"
              >
                {data.client.clientName.charAt(0).toUpperCase()}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <h2 className="text-base font-medium text-text-bright truncate">
                {data.client.clientName}
              </h2>
              {data.client.clientUri ? (
                <a
                  href={data.client.clientUri}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-text-muted hover:text-text underline-offset-2 hover:underline truncate block"
                >
                  {data.client.clientUri}
                </a>
              ) : null}
              {data.client.source === "trusted" ? (
                <span className="inline-block mt-1 text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-bg text-text-muted border border-border">
                  Trusted client
                </span>
              ) : (
                <span className="inline-block mt-1 text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-bg text-text-muted border border-border">
                  Registered client
                </span>
              )}
            </div>
          </header>

          {data.client.description ? (
            <p className="text-sm text-text-muted leading-relaxed mb-4">
              {data.client.description}
            </p>
          ) : null}

          <p className="text-sm text-text mb-3">
            <span className="font-medium text-text-bright">
              {data.client.clientName}
            </span>{" "}
            is requesting permission to:
          </p>

          <Form method="post" replace>
            <input
              type="hidden"
              name={CSRF_FORM_FIELD}
              value={data.csrfToken}
            />
            <input type="hidden" name="oauth_query" value={data.oauthQuery} />

            <ul className="flex flex-col gap-2 mb-5">
              {data.requestedScopes.map((scope) => (
                <li key={scope}>
                  <label className="flex items-start gap-3 cursor-pointer rounded-lg border border-border p-3 hover:border-accent transition-colors">
                    <input
                      type="checkbox"
                      name="scope"
                      value={scope}
                      checked={selected.has(scope)}
                      onChange={() => toggleScope(scope)}
                      className="mt-0.5 accent-accent"
                      disabled={submitting}
                    />
                    <span className="flex-1">
                      <span className="block text-sm text-text-bright">
                        {describeScope(scope)}
                      </span>
                      <span className="block text-xs text-text-muted font-mono">
                        {scope}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
              {data.requestedScopes.length === 0 ? (
                <li className="text-sm text-text-muted italic">
                  No scopes requested.
                </li>
              ) : null}
            </ul>

            {action?.error ? (
              <p
                role="alert"
                className="mb-3 text-sm text-error bg-error/10 border border-error/30 rounded-md px-3 py-2"
              >
                {action.error}
              </p>
            ) : null}

            <div className="flex gap-3">
              <Button
                type="submit"
                name="decision"
                value="approve"
                variant="primary"
                size="base"
                loading={submitting}
                disabled={submitting || selected.size === 0}
                className="flex-1"
              >
                {submitting ? <Loader size="sm" /> : "Allow"}
              </Button>
              <Button
                type="submit"
                name="decision"
                value="deny"
                variant="ghost"
                size="base"
                disabled={submitting}
                className="flex-1"
              >
                Deny
              </Button>
            </div>
          </Form>
        </div>

        <p className="text-xs text-text-muted text-center mt-6 leading-relaxed">
          Approving lets {data.client.clientName} act in your inbox using the
          permissions you select. You can revoke this access at any time from
          your{" "}
          <a href="/account" className="underline">
            Account
          </a>{" "}
          page.
        </p>
      </div>
    </div>
  );
}

// Belt-and-suspenders: re-export the escapeHtmlText helper at the route
// level so any non-React surface (e.g. a future server-rendered fallback)
// shares the same sanitizer. Tree-shaking drops it from the production
// bundle when nothing imports it from this module.
export { escapeHtmlText };
