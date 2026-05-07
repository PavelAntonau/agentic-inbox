// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license
//
// Phase 6.1 — better-auth client SDK. Mounted with the emailOTP plugin so
// the React-side login flow can call:
//   authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" })
//   authClient.signIn.emailOtp({ email, otp })
//   authClient.getSession()
//   authClient.signOut()
//
// The base URL defaults to the current origin, so this works for both
// production (mail.actionnow.ai) and any preview / dev origin without
// reconfiguration.

import { createAuthClient } from "better-auth/client";
import { emailOTPClient } from "better-auth/client/plugins";

/**
 * Public surface we actually call from the React side. Declared explicitly
 * to sidestep TS2742 — better-auth's full inferred client type pulls in
 * zod's nested private modules and TS rejects them as non-portable under
 * `composite: true`. Runtime shape matches; the interface enumerates the
 * exact methods used by app/routes/login.tsx and any future sessions UI.
 */
export interface AuthClient {
  emailOtp: {
    sendVerificationOtp(args: {
      email: string;
      type: "sign-in" | "email-verification" | "forget-password";
      /**
       * Phase G-2 — pass extra fetch options so the Turnstile token can be
       * forwarded as a header to the OTP-send endpoint:
       *   fetchOptions: { headers: { "X-Turnstile-Token": token } }
       */
      fetchOptions?: { headers?: Record<string, string> };
    }): Promise<{ data: unknown; error: { message?: string } | null }>;
  };
  signIn: {
    emailOtp(args: {
      email: string;
      otp: string;
    }): Promise<{ data: unknown; error: { message?: string } | null }>;
  };
  signOut(): Promise<{ data: unknown; error: { message?: string } | null }>;
  getSession(): Promise<{
    data: { session?: unknown; user?: unknown } | null;
    error: { message?: string } | null;
  }>;
}

export const authClient: AuthClient = createAuthClient({
  plugins: [emailOTPClient()],
}) as unknown as AuthClient;
