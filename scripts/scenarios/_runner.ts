#!/usr/bin/env -S npx tsx
// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * Autonomous-local-testing scenario runner (T2.1).
 *
 * Orchestrates UI scenarios against a locally-running worker (MOCK_MODE=1
 * on :8788) using browser-mcp (:8810). Each scenario is a self-contained
 * TS module under this directory.
 *
 * Pipeline per scenario:
 *   1. POST /__mock/reset (clears D1 control-plane + R2 outbox + OTP tee).
 *   2. Spin up a browser-mcp session (own Chrome process / user-data-dir).
 *   3. Run the scenario, capturing screenshots + console snapshots into
 *      .scratch/ui/<scenario>/.
 *   4. Close the session, write per-scenario result, append to summary.
 *   5. On failure, write .scratch/findings/<scenario>-<ts>.md (T2.3).
 *
 * CLI:
 *   tsx scripts/scenarios/_runner.ts --smoke       # all smoke=true scenarios
 *   tsx scripts/scenarios/_runner.ts --all          # everything in registry
 *   tsx scripts/scenarios/_runner.ts S-AUTH-1 ...  # explicit ids
 *
 * Exit codes: 0 all green, 1 ≥1 scenario failed, 2 harness/setup error.
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { writeFinding, writeReport } from "./_findings";
import { loadScenarios, type RegistryEntry } from "./_registry";
import type {
  BrowserMcpClient,
  MockControlClient,
  Scenario,
  ScenarioContext,
  ScenarioResult,
} from "./_types";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const ARTIFACTS_ROOT = join(REPO_ROOT, ".scratch", "ui");
const FINDINGS_ROOT = join(REPO_ROOT, ".scratch", "findings");

const WORKER_BASE = process.env.SCENARIO_WORKER_BASE ?? "http://127.0.0.1:8788";
const BROWSER_MCP_URL =
  process.env.SCENARIO_BROWSER_MCP_URL ?? "http://127.0.0.1:8810/mcp";
const STEP_TIMEOUT_MS = 15_000;

// ────────────────────────────────────────────────────────────────────────────
// Browser-mcp Streamable HTTP client (minimal MCP handshake + tool calls).
// ────────────────────────────────────────────────────────────────────────────

class BrowserMcp implements BrowserMcpClient {
  private mcpSessionId: string | null = null;
  private nextRpcId = 0;
  private sessionAlias: string | null = null;
  private initialized = false;

  constructor(private readonly endpoint: string = BROWSER_MCP_URL) {}

  async init(): Promise<void> {
    if (this.initialized) return;
    const initRes = await this.rpc(
      {
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "scenario-runner", version: "0.1.0" },
        },
      },
      /*allowSessionHeader*/ true,
    );
    if (initRes.error)
      throw new Error(
        `browser-mcp init failed: ${JSON.stringify(initRes.error)}`,
      );
    // Notify initialized — required by MCP spec before tool calls.
    await this.notify("notifications/initialized", {});
    this.initialized = true;
  }

  /** Open a fresh browser session and make it the active one. */
  async openSession(alias: string): Promise<void> {
    await this.init();
    await this.callTool("session_create", {
      alias,
      viewport_width: 1440,
      viewport_height: 900,
      device_scale_factor: 2,
    });
    this.sessionAlias = alias;
  }

  async closeSession(): Promise<void> {
    if (!this.sessionAlias) return;
    try {
      await this.callTool("session_close", { id_or_alias: this.sessionAlias });
    } catch {
      // Best-effort — server may have already evicted the session.
    } finally {
      this.sessionAlias = null;
    }
  }

  async call(
    tool: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    return this.callTool(tool, args);
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const res = await this.rpc({
      method: "tools/call",
      params: { name, arguments: args },
    });
    if (res.error) {
      throw new Error(
        `browser-mcp ${name}: ${res.error.message ?? JSON.stringify(res.error)}`,
      );
    }
    // FastMCP wraps tool returns inside content[].text (JSON-encoded).
    const result = res.result as
      | {
          content?: Array<{ type: string; text?: string }>;
          structuredContent?: unknown;
          isError?: boolean;
        }
      | undefined;
    if (result?.isError) {
      const txt = result.content?.[0]?.text ?? "(no error text)";
      throw new Error(`browser-mcp ${name} error: ${txt}`);
    }
    let parsed: unknown;
    if (result?.structuredContent !== undefined) {
      parsed = result.structuredContent;
    } else {
      const first = result?.content?.[0];
      if (first?.type === "text" && first.text) {
        try {
          parsed = JSON.parse(first.text);
        } catch {
          parsed = first.text;
        }
      }
    }
    // browser-mcp wraps every tool's return in `{result, url, session_id,
    // session_alias}`. For most tool calls the caller wants the inner
    // `result`; preserve the envelope only if the inner shape is missing.
    if (
      parsed &&
      typeof parsed === "object" &&
      "result" in (parsed as Record<string, unknown>) &&
      "session_id" in (parsed as Record<string, unknown>)
    ) {
      return (parsed as { result: unknown }).result;
    }
    return parsed ?? result;
  }

  private async notify(method: string, params: unknown): Promise<void> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.mcpSessionId) headers["Mcp-Session-Id"] = this.mcpSessionId;
    await fetch(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
    });
  }

  private async rpc(
    body: { method: string; params?: unknown },
    allowSessionHeader = false,
  ): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
    const id = ++this.nextRpcId;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.mcpSessionId) headers["Mcp-Session-Id"] = this.mcpSessionId;

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, ...body }),
    });

    if (allowSessionHeader) {
      const s = res.headers.get("mcp-session-id");
      if (s) this.mcpSessionId = s;
    }

    const ct = res.headers.get("content-type") ?? "";
    const txt = await res.text();
    let payload: {
      result?: unknown;
      error?: { code: number; message: string };
    } | null = null;
    if (ct.includes("text/event-stream")) {
      // Walk SSE events; pick the one with matching id.
      for (const line of txt.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        try {
          const obj = JSON.parse(data);
          if (obj.id === id || (obj.error && obj.id === id)) {
            payload = obj;
            break;
          }
          // Some servers don't echo the id; take the first message-shaped event.
          if (!payload && (obj.result !== undefined || obj.error))
            payload = obj;
        } catch {
          /* ignore non-json events */
        }
      }
    } else {
      payload = txt ? JSON.parse(txt) : null;
    }
    if (!payload) {
      throw new Error(
        `browser-mcp returned no parseable payload (status ${res.status}, ct=${ct}): ${txt.slice(0, 200)}`,
      );
    }
    return payload;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Mock-control client (HTTP against /__mock/*).
// ────────────────────────────────────────────────────────────────────────────

class MockControl implements MockControlClient {
  constructor(private readonly base: string) {}

  async health(): Promise<unknown> {
    const r = await fetch(`${this.base}/__mock/health`);
    if (!r.ok) throw new Error(`mock health ${r.status}`);
    return r.json();
  }

  async reset(): Promise<unknown> {
    const r = await fetch(`${this.base}/__mock/reset`, { method: "POST" });
    if (!r.ok) throw new Error(`mock reset ${r.status}: ${await r.text()}`);
    return r.json();
  }

  async otpLatest(
    email: string,
  ): Promise<{ code: string; email: string; created_iso: string }> {
    const r = await fetch(
      `${this.base}/__mock/otp-latest?email=${encodeURIComponent(email)}`,
    );
    if (!r.ok)
      throw new Error(`mock otp-latest ${r.status}: ${await r.text()}`);
    return r.json() as Promise<{
      code: string;
      email: string;
      created_iso: string;
    }>;
  }

  async outbox(
    limit = 100,
  ): Promise<{ count: number; entries: Array<{ key: string }> }> {
    const r = await fetch(`${this.base}/__mock/outbox?limit=${limit}`);
    if (!r.ok) throw new Error(`mock outbox ${r.status}`);
    return r.json() as Promise<{
      count: number;
      entries: Array<{ key: string }>;
    }>;
  }

  async injectInbound(payload: {
    to: string;
    from: string;
    subject: string;
    body: string;
  }): Promise<unknown> {
    const r = await fetch(`${this.base}/__mock/inbox`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(`mock inbox ${r.status}: ${await r.text()}`);
    return r.json();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Scenario context — exposed to each scenario's `run(ctx)`.
// ────────────────────────────────────────────────────────────────────────────

function buildContext(args: {
  browser: BrowserMcp;
  mock: MockControl;
  scenarioId: string;
  artifactsDir: string;
  log: (m: string) => void;
  consoleErrorTotal: { value: number };
  screenshots: string[];
}): ScenarioContext {
  const { browser, mock, artifactsDir, log, consoleErrorTotal, screenshots } =
    args;

  return {
    baseUrl: WORKER_BASE,
    browser,
    mock,
    artifactsDir,
    log,

    async screenshot(label, fullPage = false) {
      const result = (await browser.call("browser_take_screenshot", {
        full_page: fullPage,
      })) as { path?: string; file?: string } | string;
      // browser-mcp returns the saved path inside the result. Copy/symlink not
      // strictly necessary; record the path in our artifacts manifest.
      const reportedPath =
        typeof result === "string"
          ? result
          : (result.path ?? result.file ?? JSON.stringify(result));
      const stamped = `${label}::${reportedPath}`;
      screenshots.push(stamped);
      // Also stash a small marker file in artifactsDir so the artifact
      // directory is non-empty even if browser-mcp wrote elsewhere.
      writeFileSync(
        join(artifactsDir, `screenshot-${label}.txt`),
        `${reportedPath}\n`,
      );
      return reportedPath;
    },

    async captureConsole(label) {
      const result = (await browser.call("browser_console_messages")) as
        | Array<{ type: string; text: string }>
        | { messages: Array<{ type: string; text: string }> };
      const messages = Array.isArray(result) ? result : (result.messages ?? []);
      const errors = messages.filter(
        (m) => m.type === "error" || m.type === "exception",
      ).length;
      consoleErrorTotal.value += errors;
      const path = join(artifactsDir, `console-${label}.json`);
      writeFileSync(path, JSON.stringify(messages, null, 2));
      return { path, errors };
    },

    async waitFor({ text, selector, timeoutMs = STEP_TIMEOUT_MS }) {
      // browser-mcp's browser_wait_for is selector+state only. Poll via
      // browser_evaluate so we can support text-on-page and CSS selectors
      // uniformly.
      const deadline = Date.now() + timeoutMs;
      let predicate: string;
      if (selector) {
        predicate = `!!document.querySelector(${JSON.stringify(selector)})`;
      } else if (text) {
        predicate = `document.body && document.body.innerText.includes(${JSON.stringify(text)})`;
      } else {
        throw new Error("waitFor requires either selector or text");
      }
      while (Date.now() < deadline) {
        const present = (await browser.call("browser_evaluate", {
          expression: predicate,
        })) as boolean;
        if (present === true) return;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error(`waitFor timeout (${timeoutMs}ms): ${selector ?? text}`);
    },

    async click({ ariaLabel, selector, text }) {
      if (selector) {
        await browser.call("browser_evaluate", {
          expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('no element for ${selector.replace(/'/g, "\\'")}'); el.click(); return true; })()`,
        });
        return;
      }
      if (ariaLabel) {
        await browser.call("browser_evaluate", {
          expression: `(() => { const lbl = ${JSON.stringify(ariaLabel)}; const all = document.querySelectorAll('[aria-label]'); for (const e of all) { if (e.getAttribute('aria-label') === lbl) { e.click(); return true; } } throw new Error('no element with aria-label=' + lbl); })()`,
        });
        return;
      }
      if (text) {
        await browser.call("browser_evaluate", {
          expression: `(() => { const target = ${JSON.stringify(text)}; const all = document.querySelectorAll('button, a, [role="button"], [role="link"], [role="menuitem"]'); for (const el of all) { const t = (el.textContent || '').trim(); if (t === target || t.includes(target)) { el.click(); return true; } } throw new Error('no clickable element with text=' + target); })()`,
        });
        return;
      }
      throw new Error("click requires selector, ariaLabel, or text");
    },

    async fill({ ariaLabel, selector }, value) {
      const target = selector
        ? selector
        : `[aria-label=${JSON.stringify(ariaLabel ?? "")}]`;
      await browser.call("browser_evaluate", {
        expression: `(() => { const el = document.querySelector(${JSON.stringify(target)}); if (!el) throw new Error('no input for ${target.replace(/'/g, "\\'")}'); const proto = Object.getPrototypeOf(el); const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set; if (setter) { setter.call(el, ${JSON.stringify(value)}); } else { el.value = ${JSON.stringify(value)}; } el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
      });
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Runner
// ────────────────────────────────────────────────────────────────────────────

interface RunOptions {
  smoke?: boolean;
  all?: boolean;
  ids?: string[];
}

async function runOne(
  entry: RegistryEntry,
  ctx: { browser: BrowserMcp; mock: MockControl },
): Promise<ScenarioResult> {
  const { browser, mock } = ctx;
  const scenario = entry.scenario;
  const artifactsDir = join(ARTIFACTS_ROOT, scenario.id);
  mkdirSync(artifactsDir, { recursive: true });

  const logLines: string[] = [];
  const log = (m: string) => {
    const stamped = `[${new Date().toISOString()}] ${m}`;
    logLines.push(stamped);
    // eslint-disable-next-line no-console
    console.log(`  ${scenario.id} » ${m}`);
  };

  const consoleErrorTotal = { value: 0 };
  const screenshots: string[] = [];

  // Reset mock state unless scenario opted out.
  if (scenario.fixture !== null) {
    log("POST /__mock/reset");
    await mock.reset();
  }

  // Fresh browser session per scenario.
  const alias = `scenario-${scenario.id.toLowerCase()}-${Date.now() % 1_000_000}`;
  await browser.openSession(alias);
  log(`opened session ${alias}`);

  const start = performance.now();
  let status: "pass" | "fail" = "pass";
  let failure: ScenarioResult["failure"];

  try {
    const sctx = buildContext({
      browser,
      mock,
      scenarioId: scenario.id,
      artifactsDir,
      log,
      consoleErrorTotal,
      screenshots,
    });
    await scenario.run(sctx);
  } catch (err) {
    status = "fail";
    const e = err as Error;
    const findingPath = await writeFinding({
      root: FINDINGS_ROOT,
      scenarioId: scenario.id,
      message: e.message,
      stack: e.stack,
      logLines,
      screenshots,
      consoleErrors: consoleErrorTotal.value,
    });
    failure = { message: e.message, stack: e.stack, findingPath };
    log(`FAIL: ${e.message}`);
  } finally {
    await browser.closeSession();
    writeFileSync(join(artifactsDir, "log.txt"), logLines.join("\n") + "\n");
  }

  const durationMs = Math.round(performance.now() - start);
  return {
    scenarioId: scenario.id,
    status,
    durationMs,
    failure,
    artifacts: {
      dir: artifactsDir,
      screenshots,
      consoleErrors: consoleErrorTotal.value,
    },
  };
}

async function runAll(opts: RunOptions): Promise<ScenarioResult[]> {
  mkdirSync(ARTIFACTS_ROOT, { recursive: true });
  mkdirSync(FINDINGS_ROOT, { recursive: true });

  const registry = await loadScenarios();
  let entries: RegistryEntry[] = [];
  if (opts.smoke) entries = registry.filter((e) => e.scenario.smoke);
  else if (opts.all) entries = registry;
  else if (opts.ids?.length) {
    const idSet = new Set(opts.ids.map((s) => s.toUpperCase()));
    entries = registry.filter((e) => idSet.has(e.scenario.id.toUpperCase()));
    const missing = [...idSet].filter(
      (id) => !registry.find((e) => e.scenario.id.toUpperCase() === id),
    );
    if (missing.length) {
      throw new Error(`Unknown scenario id(s): ${missing.join(", ")}`);
    }
  } else {
    throw new Error("No scenarios selected. Use --smoke, --all, or pass IDs.");
  }

  // eslint-disable-next-line no-console
  console.log(
    `[runner] ${entries.length} scenario(s): ${entries.map((e) => e.scenario.id).join(", ")}`,
  );

  const browser = new BrowserMcp();
  await browser.init();

  const mock = new MockControl(WORKER_BASE);

  // Sanity-check the worker is up before we burn a session.
  try {
    await mock.health();
  } catch (e) {
    throw new HarnessError(
      `Worker not reachable at ${WORKER_BASE}/__mock/health: ${(e as Error).message}\n` +
        `Start it with: npm run mock:up`,
    );
  }

  const results: ScenarioResult[] = [];
  for (const entry of entries) {
    // eslint-disable-next-line no-console
    console.log(
      `\n[runner] ▶ ${entry.scenario.id} — ${entry.scenario.description}`,
    );
    const r = await runOne(entry, { browser, mock });
    results.push(r);
    // eslint-disable-next-line no-console
    console.log(
      `[runner] ${r.status === "pass" ? "PASS" : "FAIL"} ${entry.scenario.id} (${r.durationMs}ms, ${r.artifacts.consoleErrors} console errors)`,
    );
  }

  const reportPath = await writeReport({
    root: ARTIFACTS_ROOT,
    results,
    workerBase: WORKER_BASE,
    browserMcp: BROWSER_MCP_URL,
  });
  // eslint-disable-next-line no-console
  console.log(`\n[runner] report: ${reportPath}`);

  return results;
}

class HarnessError extends Error {
  readonly _harness = true;
}

function parseArgs(argv: string[]): RunOptions {
  const opts: RunOptions = { ids: [] };
  for (const a of argv) {
    if (a === "--smoke") opts.smoke = true;
    else if (a === "--all") opts.all = true;
    else if (!a.startsWith("--")) opts.ids!.push(a);
  }
  if (opts.ids?.length === 0) delete opts.ids;
  return opts;
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  try {
    const results = await runAll(opts);
    const failed = results.filter((r) => r.status === "fail").length;
    return failed > 0 ? 1 : 0;
  } catch (e) {
    const err = e as Error & { _harness?: boolean };
    // eslint-disable-next-line no-console
    console.error(
      `[runner] ${err._harness ? "HARNESS" : "ERROR"}: ${err.message}`,
    );
    if (!err._harness && err.stack) console.error(err.stack);
    return err._harness ? 2 : 2;
  }
}

const isMain = process.argv[1] && process.argv[1].endsWith("_runner.ts");
if (isMain) {
  main().then((code) => process.exit(code));
}

export { BrowserMcp, MockControl, runAll, runOne, HarnessError };
