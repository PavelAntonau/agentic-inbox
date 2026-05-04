// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * Findings + report writers for the scenario harness (T2.3).
 *
 * On scenario failure: writes .scratch/findings/<scenario>-<ts>.md so the
 * autonomous loop has a structured artifact to triage. On every run: writes
 * a summary report to .scratch/ui/report-<ts>.md.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScenarioResult } from "./_types";

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function writeFinding(args: {
  root: string;
  scenarioId: string;
  message: string;
  stack?: string;
  logLines: string[];
  screenshots: string[];
  consoleErrors: number;
}): Promise<string> {
  mkdirSync(args.root, { recursive: true });
  const ts = timestamp();
  const path = join(args.root, `${args.scenarioId}-${ts}.md`);

  const severity = inferSeverity(args.message, args.consoleErrors);

  const body = [
    `# Finding — ${args.scenarioId}`,
    "",
    `- **timestamp:** ${new Date().toISOString()}`,
    `- **scenario:** ${args.scenarioId}`,
    `- **severity:** ${severity}`,
    `- **console errors:** ${args.consoleErrors}`,
    "",
    "## Failure",
    "",
    "```",
    args.message,
    "```",
    "",
    args.stack ? "## Stack" : "",
    args.stack ? "" : "",
    args.stack ? "```" : "",
    args.stack ?? "",
    args.stack ? "```" : "",
    "",
    "## Screenshots",
    "",
    args.screenshots.length === 0
      ? "_(none captured)_"
      : args.screenshots.map((s) => `- ${s}`).join("\n"),
    "",
    "## Log",
    "",
    "```",
    args.logLines.join("\n"),
    "```",
    "",
    "## Suspected root cause",
    "",
    "_TODO — fill in during triage._",
    "",
    "## Status",
    "",
    "- [ ] Triaged",
    "- [ ] Fixed (commit hash: )",
    "- [ ] Verified by re-run",
  ]
    .filter((l) => l !== null)
    .join("\n");

  writeFileSync(path, body);
  return path;
}

export async function writeReport(args: {
  root: string;
  results: ScenarioResult[];
  workerBase: string;
  browserMcp: string;
}): Promise<string> {
  mkdirSync(args.root, { recursive: true });
  const ts = timestamp();
  const path = join(args.root, `report-${ts}.md`);

  const totals = {
    pass: args.results.filter((r) => r.status === "pass").length,
    fail: args.results.filter((r) => r.status === "fail").length,
    skip: args.results.filter((r) => r.status === "skip").length,
    duration: args.results.reduce((s, r) => s + r.durationMs, 0),
  };

  const rows = args.results
    .map(
      (r) =>
        `| ${r.scenarioId} | ${r.status.toUpperCase()} | ${r.durationMs}ms | ${r.artifacts.consoleErrors} | ${r.failure?.findingPath ?? ""} |`,
    )
    .join("\n");

  const body = [
    `# Scenario report — ${new Date().toISOString()}`,
    "",
    `- **worker:** ${args.workerBase}`,
    `- **browser-mcp:** ${args.browserMcp}`,
    `- **total:** ${args.results.length}`,
    `- **pass:** ${totals.pass}`,
    `- **fail:** ${totals.fail}`,
    `- **skip:** ${totals.skip}`,
    `- **duration:** ${totals.duration}ms`,
    "",
    "## Results",
    "",
    "| Scenario | Status | Duration | Console errors | Finding |",
    "|---|---|---|---|---|",
    rows,
    "",
    totals.fail > 0
      ? `**${totals.fail} failure(s)** — see findings under \`.scratch/findings/\`.`
      : "**All green.**",
    "",
  ].join("\n");

  writeFileSync(path, body);
  return path;
}

function inferSeverity(message: string, consoleErrors: number): string {
  const m = message.toLowerCase();
  if (m.includes("crash") || m.includes("exception") || consoleErrors > 5)
    return "high";
  if (m.includes("timeout") || m.includes("not found") || consoleErrors > 0)
    return "medium";
  return "low";
}
