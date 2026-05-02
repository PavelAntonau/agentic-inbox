// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env extends Cloudflare.Env {
  POLICY_AUD: string;
  TEAM_DOMAIN: string;

  /** Pinned global owner email. First login of this address is promoted
   *  to role='global_owner' (Phase 2). Redeploy-to-change. */
  BOOTSTRAP_OWNER_EMAIL: string;

  /** Default mock identity in dev when CF_ACCESS_DEV_MODE='mock' and
   *  no X-Mock-User-Email header is provided. */
  BOOTSTRAP_DEV_EMAIL?: string;

  /** When 'mock', the auth middleware synthesizes a JWT shape from
   *  X-Mock-User-Email instead of bypassing auth entirely. */
  CF_ACCESS_DEV_MODE?: "mock";
}
