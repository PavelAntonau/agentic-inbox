// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

// Invite landing route. Email invitations contain an opaque link of the form
//   https://<host>/i/<invitation_id>?t=<HMAC>
// We verify the HMAC against env.INVITATION_HMAC_KEY here and route the user
// either to the group home (logged in + accepted) or to /login with a `next`
// param so they land back here after auth. The actual accept happens via the
// in-app NotificationBell once the user lands on the app.

import { useEffect, useState } from "react";
import {
  type LoaderFunctionArgs,
  redirect,
  useLoaderData,
  useNavigate,
} from "react-router";
import { Button, Loader } from "~/ui";

interface LandingData {
  status: "ok" | "invalid" | "expired" | "not-logged-in";
  invitation_id: string;
  redirect_to?: string;
  group_name?: string;
}

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const id = params.id ?? "";
  const url = new URL(request.url);
  const token = url.searchParams.get("t") ?? "";

  if (!id || !token) {
    return { status: "invalid", invitation_id: id } satisfies LandingData;
  }

  // Server-side HMAC verify against env.INVITATION_HMAC_KEY. Reuse the worker
  // env via the React Router cloudflare context.
  const env = (context as { cloudflare?: { env?: Record<string, string> } })
    ?.cloudflare?.env;
  const key = env?.INVITATION_HMAC_KEY;
  if (!key) {
    // No key configured → treat as invalid rather than throwing 500
    return { status: "invalid", invitation_id: id } satisfies LandingData;
  }

  let valid = false;
  try {
    const enc = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      enc.encode(key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    // Token is hex of HMAC(invitation_id)
    const tokenBytes = hexToBytes(token);
    if (tokenBytes) {
      valid = await crypto.subtle.verify(
        "HMAC",
        cryptoKey,
        tokenBytes.buffer.slice(
          tokenBytes.byteOffset,
          tokenBytes.byteOffset + tokenBytes.byteLength,
        ) as ArrayBuffer,
        enc.encode(id).buffer.slice(0) as ArrayBuffer,
      );
    }
  } catch {
    valid = false;
  }

  if (!valid) {
    return { status: "invalid", invitation_id: id } satisfies LandingData;
  }

  // If logged in (mock-Access cookie OR real Access JWT), bounce them straight
  // to the group home — the bell will surface the pending invitation.
  const cookie = request.headers.get("cookie") ?? "";
  const loggedIn =
    cookie.includes("X-Mock-User-Email=") ||
    cookie.includes("CF_Authorization=");
  if (!loggedIn) {
    return {
      status: "not-logged-in",
      invitation_id: id,
      redirect_to: `/login?next=${encodeURIComponent(`/i/${id}?t=${token}`)}`,
    } satisfies LandingData;
  }

  // Best-effort: look up the invitation's group_id so we can deep-link.
  // Failure here is harmless — we fall back to /groups.
  let groupId: string | null = null;
  let groupName: string | null = null;
  try {
    const res = await fetch(
      new URL(`/api/invitations/${id}/preview`, request.url),
      { headers: { cookie } },
    );
    if (res.ok) {
      const data = (await res.json()) as {
        group_id?: string;
        group_name?: string;
      };
      groupId = data.group_id ?? null;
      groupName = data.group_name ?? null;
    }
  } catch {
    // ignore — fall back below
  }

  throw redirect(groupId ? `/groups/${groupId}` : "/groups");
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export default function InviteLanding() {
  const data = useLoaderData() as LandingData;
  const navigate = useNavigate();
  const [redirected, setRedirected] = useState(false);

  useEffect(() => {
    if (data.status === "not-logged-in" && data.redirect_to && !redirected) {
      setRedirected(true);
      navigate(data.redirect_to, { replace: true });
    }
  }, [data, navigate, redirected]);

  if (data.status === "invalid") {
    return (
      <div className="mx-auto max-w-md px-6 py-20 text-center">
        <h1 className="mb-2 text-xl font-semibold text-text-bright">
          Invitation link invalid
        </h1>
        <p className="mb-6 text-sm text-text-muted">
          This link is malformed or has expired. Ask the inviter to resend it.
        </p>
        <Button variant="secondary" onClick={() => navigate("/")}>
          Go home
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-6 py-20 text-center">
      <Loader size="lg" />
      <p className="mt-4 text-sm text-text-muted">
        Verifying invitation{data.group_name ? ` to ${data.group_name}` : ""}…
      </p>
    </div>
  );
}
