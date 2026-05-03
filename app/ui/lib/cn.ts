// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// cn — class name helper (clsx + tailwind-merge).
// Mirrors kumo's internal cn utility which merges Tailwind classes without
// conflicts. Both clsx and tailwind-merge are already in node_modules as
// transitive dependencies of kumo; no new packages are added.

import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
