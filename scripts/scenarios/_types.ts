// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * Shared types for the autonomous-local-testing scenario harness.
 *
 * The harness drives the worker (running locally on :8788 with MOCK_MODE=1)
 * through browser-mcp on :8810. Each scenario is a self-contained TS module
 * that exports a default `Scenario` and uses the `ScenarioContext` API to
 * navigate, interact, and capture state.
 */

export type ScenarioStatus = "pass" | "fail" | "skip";

export interface ScenarioContext {
  /** http://127.0.0.1:8788 */
  readonly baseUrl: string;
  /** Browser-mcp JSON-RPC client. */
  readonly browser: BrowserMcpClient;
  /** Worker mock-control client (POST /__mock/* helpers). */
  readonly mock: MockControlClient;
  /** Where this scenario writes its artifacts (.scratch/ui/<scenario>/). */
  readonly artifactsDir: string;
  /** Capture a screenshot stamped with `label`; returns the saved path. */
  screenshot(label: string, fullPage?: boolean): Promise<string>;
  /** Save the current console messages as artifacts/console-<label>.json. */
  captureConsole(label: string): Promise<{ path: string; errors: number }>;
  /** Append a structured log line; surfaces in the report. */
  log(msg: string): void;
  /**
   * Wait for an aria-label / text / selector to appear in the DOM.
   * Throws on timeout. Default 5s.
   */
  waitFor(opts: {
    text?: string;
    selector?: string;
    timeoutMs?: number;
  }): Promise<void>;
  /** Click an element by aria-label (preferred) or CSS selector. */
  click(opts: {
    ariaLabel?: string;
    selector?: string;
    text?: string;
  }): Promise<void>;
  /** Fill an input by aria-label or selector with `value`. */
  fill(
    opts: { ariaLabel?: string; selector?: string },
    value: string,
  ): Promise<void>;
}

export interface Scenario {
  /** Unique scenario id, e.g. "S-AUTH-1". */
  readonly id: string;
  /** Short one-line description of what the scenario covers. */
  readonly description: string;
  /** Branches / acceptance criteria covered by this scenario. */
  readonly covers: string;
  /** True if this scenario is part of the always-green smoke set. */
  readonly smoke: boolean;
  /**
   * Pre-flight reset request. The runner POSTs this to /__mock/reset before
   * the scenario runs. Defaults to `{}` (full reset). Set `null` to skip.
   */
  readonly fixture?: Record<string, unknown> | null;
  /** Run the scenario. Throw to fail. */
  run(ctx: ScenarioContext): Promise<void>;
}

export interface ScenarioResult {
  scenarioId: string;
  status: ScenarioStatus;
  durationMs: number;
  failure?: {
    message: string;
    stack?: string;
    findingPath?: string;
  };
  artifacts: {
    dir: string;
    screenshots: string[];
    consoleErrors: number;
  };
}

/** Thin JSON-RPC client for browser-mcp (Streamable HTTP at :8810/mcp). */
export interface BrowserMcpClient {
  /** Call any MCP tool; returns the raw `result.content`. */
  call(tool: string, args?: Record<string, unknown>): Promise<unknown>;
  /** Close the underlying browser session created via session_create. */
  closeSession(): Promise<void>;
}

export interface MockControlClient {
  /** POST /__mock/reset — wipes outbox, OTP tee, D1 control-plane tables. */
  reset(): Promise<unknown>;
  /** GET /__mock/health — readiness probe. */
  health(): Promise<unknown>;
  /** GET /__mock/otp-latest?email= — fetch most-recent OTP for `email`. */
  otpLatest(
    email: string,
  ): Promise<{ code: string; email: string; created_iso: string }>;
  /** GET /__mock/outbox?limit= — list mock outbox entries. */
  outbox(
    limit?: number,
  ): Promise<{ count: number; entries: Array<{ key: string }> }>;
  /** POST /__mock/inbox — synthesize an inbound email. */
  injectInbound(payload: {
    to: string;
    from: string;
    subject: string;
    body: string;
  }): Promise<unknown>;
}
