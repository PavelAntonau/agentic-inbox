#!/usr/bin/env -S npx tsx
// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * verify-mock-mode.ts — autonomous-local-testing smoke verifier (T1.5).
 *
 * Boots `wrangler dev` with MOCK_MODE=1, runs a 5-step smoke against the
 * worker (health → login OTP request → OTP fetch → home → outbox), kills
 * the server, exits 0 on green / non-zero on any failure.
 *
 * Run with:
 *     npx tsx scripts/verify-mock-mode.ts
 *
 * The script is purposely standalone (no vitest, no playwright) so it works
 * as the inner-loop sanity check before any UI scenario runs. It writes a
 * report to `.scratch/mock-smoke-<ts>.md` so the autonomous loop has an
 * artifact to consult on the next cycle.
 *
 * Exit codes:
 *   0 → all 5 smoke steps green
 *   1 → smoke step failed (details in stderr + report)
 *   2 → harness failure (server didn't start, port collision, .dev.vars
 *       missing, etc.) — distinct from a real product regression
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.MOCK_VERIFY_PORT ?? "8788");
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_EMAIL = process.env.MOCK_VERIFY_EMAIL ?? "alice@actionnow.ai";
const STARTUP_TIMEOUT_MS = 60_000;
const STEP_TIMEOUT_MS = 15_000;

type StepResult = {
  name: string;
  ok: boolean;
  duration_ms: number;
  detail?: string;
};

let wranglerProc: ChildProcess | null = null;
const wranglerLog: string[] = [];

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[verify-mock-mode] ${msg}`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = STEP_TIMEOUT_MS,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetchWithTimeout(`${BASE}/__mock/health`, {}, 1500);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await sleep(500);
  }
  throw new Error(
    `wrangler dev did not become ready in ${STARTUP_TIMEOUT_MS}ms`,
  );
}

function startWrangler(): void {
  log(`spawning wrangler dev on port ${PORT} with MOCK_MODE=1`);
  wranglerProc = spawn(
    "npx",
    ["wrangler", "dev", "--port", String(PORT), "--var", "MOCK_MODE:1"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, MOCK_MODE: "1" },
    },
  );
  wranglerProc.stdout?.on("data", (b) => {
    const s = b.toString();
    wranglerLog.push(s);
    if (process.env.MOCK_VERIFY_VERBOSE) process.stdout.write(s);
  });
  wranglerProc.stderr?.on("data", (b) => {
    const s = b.toString();
    wranglerLog.push(s);
    if (process.env.MOCK_VERIFY_VERBOSE) process.stderr.write(s);
  });
  wranglerProc.on("exit", (code, signal) => {
    log(`wrangler dev exited code=${code} signal=${signal}`);
  });
}

function stopWrangler(): void {
  if (!wranglerProc) return;
  try {
    wranglerProc.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  wranglerProc = null;
}

async function runStep(
  name: string,
  fn: () => Promise<string | undefined>,
): Promise<StepResult> {
  const t0 = Date.now();
  try {
    const detail = await fn();
    const r: StepResult = {
      name,
      ok: true,
      duration_ms: Date.now() - t0,
      detail,
    };
    log(`[OK] ${name}${detail ? ` — ${detail}` : ""}`);
    return r;
  } catch (e) {
    const r: StepResult = {
      name,
      ok: false,
      duration_ms: Date.now() - t0,
      detail: (e as Error).message,
    };
    log(`[FAIL] ${name} — ${r.detail}`);
    return r;
  }
}

async function smokeHealth(): Promise<string> {
  const res = await fetchWithTimeout(`${BASE}/__mock/health`);
  if (!res.ok) throw new Error(`health returned ${res.status}`);
  const body = (await res.json()) as { mock_mode?: boolean };
  if (body.mock_mode !== true) {
    throw new Error(
      `health body did not confirm mock_mode: ${JSON.stringify(body)}`,
    );
  }
  return "mock_mode confirmed";
}

async function smokeRequestOtp(): Promise<string> {
  const res = await fetchWithTimeout(
    `${BASE}/api/auth/email-otp/send-verification-otp`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: TEST_EMAIL, type: "sign-in" }),
    },
  );
  if (!res.ok && res.status !== 200 && res.status !== 201) {
    const txt = await res.text();
    throw new Error(
      `OTP request failed status=${res.status} body=${txt.slice(0, 120)}`,
    );
  }
  return `OTP requested for ${TEST_EMAIL}`;
}

async function smokeFetchOtp(): Promise<string> {
  // Allow a tiny delay so the outbox writer flushes the OTP into R2.
  await sleep(500);
  const res = await fetchWithTimeout(
    `${BASE}/__mock/otp-latest?email=${encodeURIComponent(TEST_EMAIL)}`,
  );
  if (!res.ok) throw new Error(`otp-latest returned ${res.status}`);
  const body = (await res.json()) as { code?: string };
  if (!body.code || !/^\d{6}$/.test(body.code)) {
    throw new Error(
      `otp-latest body missing 6-digit code: ${JSON.stringify(body)}`,
    );
  }
  return `OTP code retrieved (${body.code})`;
}

async function smokeOutbox(): Promise<string> {
  const res = await fetchWithTimeout(`${BASE}/__mock/outbox?limit=10`);
  if (!res.ok) throw new Error(`outbox returned ${res.status}`);
  const body = (await res.json()) as { count?: number };
  if (typeof body.count !== "number") {
    throw new Error(`outbox body missing count: ${JSON.stringify(body)}`);
  }
  return `outbox has ${body.count} entr${body.count === 1 ? "y" : "ies"}`;
}

async function smokeLoginPage(): Promise<string> {
  const res = await fetchWithTimeout(`${BASE}/login`);
  // Either the dev login picker (200 + HTML) or a 302 to /login is acceptable.
  if (res.status !== 200 && res.status !== 302) {
    throw new Error(`/login returned ${res.status}`);
  }
  return `/login responded ${res.status}`;
}

async function main(): Promise<void> {
  startWrangler();
  try {
    await waitForReady();
  } catch (e) {
    log(`harness failure: ${(e as Error).message}`);
    log("--- last 40 lines of wrangler log ---");
    log(wranglerLog.slice(-40).join("").trim());
    stopWrangler();
    process.exit(2);
  }

  const results: StepResult[] = [];
  results.push(await runStep("health", smokeHealth));
  results.push(await runStep("login-page", smokeLoginPage));
  results.push(await runStep("request-otp", smokeRequestOtp));
  results.push(await runStep("fetch-otp", smokeFetchOtp));
  results.push(await runStep("outbox", smokeOutbox));

  stopWrangler();

  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;

  // Persist a report so the autonomous loop has something to read on the
  // next cycle.
  try {
    mkdirSync(".scratch", { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const reportPath = join(".scratch", `mock-smoke-${ts}.md`);
    const lines = [
      "# Mock-mode smoke verification",
      "",
      `- timestamp: ${new Date().toISOString()}`,
      `- pass: ${pass}/${results.length}`,
      `- fail: ${fail}`,
      `- port: ${PORT}`,
      `- email: ${TEST_EMAIL}`,
      "",
      "| Step | Status | Duration | Detail |",
      "|---|---|---|---|",
      ...results.map(
        (r) =>
          `| ${r.name} | ${r.ok ? "OK" : "FAIL"} | ${r.duration_ms}ms | ${(r.detail ?? "").replace(/\|/g, "\\|")} |`,
      ),
    ];
    writeFileSync(reportPath, lines.join("\n") + "\n");
    log(`report written to ${reportPath}`);
  } catch (e) {
    log(`report write failed (non-fatal): ${(e as Error).message}`);
  }

  if (fail > 0) {
    log(`smoke FAILED: ${fail}/${results.length} step(s) red`);
    process.exit(1);
  }
  log(`smoke GREEN: ${pass}/${results.length} steps`);
  process.exit(0);
}

process.on("SIGINT", () => {
  stopWrangler();
  process.exit(130);
});
process.on("SIGTERM", () => {
  stopWrangler();
  process.exit(143);
});

main().catch((e) => {
  log(`unexpected error: ${(e as Error).message}`);
  stopWrangler();
  process.exit(2);
});
