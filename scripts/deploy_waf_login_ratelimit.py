#!/usr/bin/env python3
"""deploy_waf_login_ratelimit.py — TASK-2.3 WAF rule deploy via Rulesets API.

Phase v1.1 G-5 / TASK-2.3 — single Free-zone WAF rate-limit rule on the
OTP-send POST endpoint, defense-in-depth behind the Workers RL binding
(TASK-2.1, already shipped). Targets the http_ratelimit phase entrypoint
ruleset on the actionnow.ai zone.

Idempotent. Detects an existing rule with our description marker and
PATCHes it; otherwise POSTs a new rule. Captures the Cloudflare API
response verbatim so the action-plan ship report can document
OQ Oyr_6J-cEBuMtA73AYBvf (Free-plan expression-field availability).

Token: fetched from the local Key MCP (service=cloudflare, account=api-token).
NEVER embedded, NEVER logged. Same fetch pattern as deploy_cloudflare.py.

Validates TASK-2.4: the upstream_zone exclusion expression uses the
canonical zone-ID-pinned form (NOT the buggy CF-doc tautology). See
`.research/v1.1-g5-upstream-zone-finding.md` in cld-net.

Usage:
    # Dry-run (compose rule, don't POST):
    python3 scripts/deploy_waf_login_ratelimit.py --dry-run

    # Real deploy — tries with method check first, falls back to path-only
    # on Free-plan rejection:
    python3 scripts/deploy_waf_login_ratelimit.py

    # Force path-only (skip the method-check attempt — saves one round-trip
    # if you already know Free rejects http.request.method):
    python3 scripts/deploy_waf_login_ratelimit.py --force-path-only

    # Verbose API I/O:
    python3 scripts/deploy_waf_login_ratelimit.py --verbose

Exit codes:
    0   rule deployed (or matches in --dry-run)
    1   key MCP unreachable / token retrieval failed
    2   zone resolve failed
    3   ruleset/rule API call failed
    4   internal error (composition / parsing)
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ZONE_NAME = "actionnow.ai"
LOGIN_PATH = "/api/auth/email-otp/send-verification-otp"
RULE_DESCRIPTION = "v1.1-g5-login-ratelimit"
PHASE = "http_ratelimit"
KEY_MCP_URL = "http://127.0.0.1:8782/mcp"
KEY_MCP_BEARER_FILE = Path.home() / ".anaid" / "key-mcp.token"
CF_API = "https://api.cloudflare.com/client/v4"

# Threshold per the action plan: 5/10s per IP per colo.
RULE_PERIOD = 10
RULE_REQUESTS_PER_PERIOD = 5
RULE_MITIGATION_TIMEOUT = 10
RULE_CHARACTERISTICS = ["cf.colo.id", "ip.src"]


def log(msg: str) -> None:
    print(f"[waf-deploy] {msg}", flush=True)


def fail(msg: str, code: int) -> int:
    print(f"[waf-deploy] [FAIL] {msg}", file=sys.stderr, flush=True)
    return code


def step(n: int, total: int, msg: str) -> None:
    print(f"[waf-deploy] [STEP {n}/{total}] {msg}", flush=True)


# ─── Key MCP fetch (same pattern as deploy_cloudflare.py) ─────────────


def _parse_mcp_body(body: str) -> dict:
    body = body.lstrip()
    if body.startswith("event:") or body.startswith("data:"):
        for line in body.splitlines():
            if line.startswith("data:"):
                body = line[5:].strip()
                break
    return json.loads(body)


def _mcp_post(
    url: str,
    bearer: str,
    payload: dict,
    session_id: Optional[str] = None,
    timeout: float = 10.0,
) -> tuple[Optional[dict], Optional[str], Optional[str]]:
    headers = {
        "Authorization": f"Bearer {bearer}",
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    if session_id:
        headers["Mcp-Session-Id"] = session_id

    req = Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            new_session = resp.headers.get("Mcp-Session-Id")
    except HTTPError as e:
        try:
            err_body = e.read().decode("utf-8")
        except Exception:  # noqa: BLE001
            err_body = ""
        return None, None, f"HTTP {e.code} {e.reason}: {err_body[:300]}"
    except URLError as e:
        return None, None, f"unreachable: {e.reason}"
    except OSError as e:
        return None, None, f"socket: {e}"

    if not raw.strip():
        return None, new_session, None
    try:
        envelope = _parse_mcp_body(raw)
    except json.JSONDecodeError as e:
        return None, new_session, f"non-JSON body: {e}; first 200: {raw[:200]}"
    return envelope, new_session, None


def fetch_token_from_key_mcp() -> Optional[str]:
    if not KEY_MCP_BEARER_FILE.exists():
        log(f"Key MCP bearer file missing: {KEY_MCP_BEARER_FILE}")
        return None
    try:
        bearer = KEY_MCP_BEARER_FILE.read_text().strip()
    except OSError as e:
        log(f"Cannot read Key MCP bearer: {e}")
        return None

    init_payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {
                "name": "deploy_waf_login_ratelimit.py",
                "version": "1.0.0",
            },
        },
    }
    envelope, session_id, err = _mcp_post(KEY_MCP_URL, bearer, init_payload)
    if err:
        log(f"Key MCP initialize failed: {err}")
        return None
    if envelope and "error" in envelope:
        log(f"Key MCP initialize RPC error: {envelope['error']}")
        return None
    if not session_id:
        log("Key MCP initialize did not return Mcp-Session-Id")
        return None

    notify_payload = {
        "jsonrpc": "2.0",
        "method": "notifications/initialized",
        "params": {},
    }
    _mcp_post(KEY_MCP_URL, bearer, notify_payload, session_id)

    call_payload = {
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": {
            "name": "tool_get_secret",
            "arguments": {"service": "cloudflare", "account": "api-token"},
        },
    }
    envelope, _new, err = _mcp_post(KEY_MCP_URL, bearer, call_payload, session_id)
    if err:
        log(f"Key MCP tools/call failed: {err}")
        return None
    if envelope is None or "error" in (envelope or {}):
        log(f"Key MCP error envelope: {json.dumps(envelope)[:400]}")
        return None

    try:
        return envelope["result"]["structuredContent"]["result"]["value"]
    except (KeyError, TypeError):
        pass
    try:
        text = envelope["result"]["content"][0]["text"]
        parsed = json.loads(text)
        return parsed.get("value") or parsed["result"]["value"]
    except (KeyError, IndexError, TypeError, json.JSONDecodeError) as e:
        log(f"Unexpected Key MCP response shape: {e}")
        return None


# ─── Cloudflare API helpers ────────────────────────────────────────────


class CFError(Exception):
    def __init__(self, status: int, body: str):
        self.status = status
        self.body = body
        super().__init__(f"HTTP {status}: {body[:600]}")


def cf_request(
    token: str,
    method: str,
    path: str,
    payload: Optional[dict] = None,
    verbose: bool = False,
) -> dict:
    url = f"{CF_API}{path}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = Request(url, data=body, headers=headers, method=method)
    if verbose:
        log(f"  CF API: {method} {path}")
        if payload is not None:
            log(f"    payload: {json.dumps(payload)[:400]}")
    try:
        with urlopen(req, timeout=20) as resp:
            raw = resp.read().decode("utf-8")
    except HTTPError as e:
        err_body = ""
        try:
            err_body = e.read().decode("utf-8")
        except Exception:  # noqa: BLE001
            pass
        raise CFError(e.code, err_body) from None
    except (URLError, OSError) as e:
        raise CFError(0, f"transport: {e}") from None

    if not raw.strip():
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        raise CFError(0, f"non-JSON: {e}; first 200: {raw[:200]}") from None


def resolve_zone_id(token: str, verbose: bool = False) -> Optional[str]:
    try:
        resp = cf_request(token, "GET", f"/zones?name={ZONE_NAME}", verbose=verbose)
    except CFError as e:
        log(f"zone resolve failed: {e}")
        return None
    result = resp.get("result", [])
    if not result:
        log(f"zone {ZONE_NAME!r} not found")
        return None
    zone_id = result[0].get("id")
    if not zone_id:
        log(f"zone resolve returned no id: {json.dumps(resp)[:300]}")
        return None
    return zone_id


# ─── Rule composition ──────────────────────────────────────────────────


def compose_expression(
    zone_id: str, with_method: bool, with_upstream_exclusion: bool
) -> str:
    """Build the rate-limit rule expression.

    `cf.worker.upstream_zone` is gated to Advanced Rate Limiting plans
    (Pro+); Free-plan deploys MUST omit the exclusion clause and accept
    that same-zone Worker subrequests count against the visitor IP's
    budget. Verified empirically 2026-05-07 — the API rejects with
    HTTP 400 / `not entitled: the use of field cf.worker.upstream_zone
    is not allowed, an higher Advanced Rate Limiting plan is required`.

    When `with_upstream_exclusion=True` (Pro+ deploys), the exclusion
    uses the canonical zone-ID-pinned form, NOT the published CF doc's
    buggy `(cf.worker.upstream_zone == "" or != "")` tautology. See
    `.research/v1.1-g5-upstream-zone-finding.md` in cld-net for the
    truth-table analysis (TASK-2.4).
    """
    path_clause = f'(http.request.uri.path eq "{LOGIN_PATH}")'
    if with_method:
        match_clause = (
            f'(http.request.uri.path eq "{LOGIN_PATH}" '
            f'and http.request.method eq "POST")'
        )
    else:
        match_clause = path_clause
    if with_upstream_exclusion:
        upstream_clause = (
            f'(cf.worker.upstream_zone eq "" or cf.worker.upstream_zone ne "{zone_id}")'
        )
        return f"{match_clause} and {upstream_clause}"
    return match_clause


def compose_rule(
    zone_id: str, with_method: bool, with_upstream_exclusion: bool
) -> dict:
    return {
        "action": "block",
        "ratelimit": {
            "characteristics": RULE_CHARACTERISTICS,
            "period": RULE_PERIOD,
            "requests_per_period": RULE_REQUESTS_PER_PERIOD,
            "mitigation_timeout": RULE_MITIGATION_TIMEOUT,
        },
        "expression": compose_expression(zone_id, with_method, with_upstream_exclusion),
        "description": RULE_DESCRIPTION,
        "enabled": True,
    }


# ─── Ruleset operations ────────────────────────────────────────────────


def get_phase_entrypoint(token: str, zone_id: str, verbose: bool = False) -> dict:
    """GET the http_ratelimit phase entrypoint ruleset.

    On Free plan a phase entrypoint may not exist yet; CF returns 200 with
    an empty rules array if one was previously created and emptied, OR
    404 if it was never touched. We treat 404 as "needs PUT to create".
    """
    try:
        return cf_request(
            token,
            "GET",
            f"/zones/{zone_id}/rulesets/phases/{PHASE}/entrypoint",
            verbose=verbose,
        )
    except CFError as e:
        if e.status == 404:
            return {"_missing": True, "result": {"id": None, "rules": []}}
        raise


def find_existing_rule(rules: list[dict]) -> Optional[dict]:
    for r in rules or []:
        if r.get("description") == RULE_DESCRIPTION:
            return r
    return None


def deploy_rule(
    token: str,
    zone_id: str,
    *,
    dry_run: bool,
    force_path_only: bool,
    with_upstream_exclusion: bool,
    verbose: bool,
) -> tuple[bool, dict, str]:
    """Returns (ok, response, mode_used) where mode_used is 'with-method' or 'path-only'."""
    entrypoint = get_phase_entrypoint(token, zone_id, verbose=verbose)
    ruleset = entrypoint.get("result", {})
    ruleset_id = ruleset.get("id")
    existing = find_existing_rule(ruleset.get("rules") or [])

    # Try with method first unless overridden.
    candidate_modes = ["with-method"] if not force_path_only else []
    candidate_modes.append("path-only")

    last_err: Optional[CFError] = None
    for mode in candidate_modes:
        rule = compose_rule(
            zone_id,
            with_method=(mode == "with-method"),
            with_upstream_exclusion=with_upstream_exclusion,
        )
        log(f"  attempt: mode={mode}")
        log(f"    expression: {rule['expression']}")
        if dry_run:
            log("    [DRY-RUN] would POST/PATCH this rule")
            return True, {"dry_run": True, "rule": rule, "mode": mode}, mode

        try:
            if existing and ruleset_id:
                log(f"    PATCH existing rule {existing['id']} in ruleset {ruleset_id}")
                resp = cf_request(
                    token,
                    "PATCH",
                    f"/zones/{zone_id}/rulesets/{ruleset_id}/rules/{existing['id']}",
                    rule,
                    verbose=verbose,
                )
            elif ruleset_id:
                log(f"    POST new rule into ruleset {ruleset_id}")
                resp = cf_request(
                    token,
                    "POST",
                    f"/zones/{zone_id}/rulesets/{ruleset_id}/rules",
                    rule,
                    verbose=verbose,
                )
            else:
                # PUT phase entrypoint: name/kind/phase are implicit from the
                # URL path; CF rejects them in the body with HTTP 400
                # `invalid JSON: unknown field "kind"`. Only `rules` and the
                # optional `description` are accepted.
                log("    PUT new phase entrypoint ruleset (none existed)")
                resp = cf_request(
                    token,
                    "PUT",
                    f"/zones/{zone_id}/rulesets/phases/{PHASE}/entrypoint",
                    {
                        "rules": [rule],
                        "description": ("v1.1 G-5 — login rate-limit (OTP-send POST)"),
                    },
                    verbose=verbose,
                )
            return True, resp, mode
        except CFError as e:
            last_err = e
            body_lower = e.body.lower()
            method_keywords = (
                "http.request.method",
                "method is not supported",
                "field is not supported",
                "unsupported field",
                "expression is not supported",
            )
            if mode == "with-method" and any(k in body_lower for k in method_keywords):
                log("    method-eq rejected (resolves OQ Oyr_6J-cEBuMtA73AYBvf)")
                log(f"    rejection text (truncated): {e.body[:300]}")
                log("    falling back to path-only")
                continue
            log(f"    {mode} attempt failed: {e}")
            return False, {"error": str(e), "body": e.body, "mode": mode}, mode

    return (
        False,
        {"error": str(last_err), "body": last_err.body if last_err else ""},
        "path-only",
    )


# ─── Main ──────────────────────────────────────────────────────────────


def main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--dry-run", action="store_true", help="Compose only; do not POST.")
    p.add_argument(
        "--force-path-only",
        action="store_true",
        help="Skip the http.request.method attempt and go straight to path-only.",
    )
    p.add_argument(
        "--with-upstream-exclusion",
        action="store_true",
        help=(
            "Include the cf.worker.upstream_zone exclusion clause. Requires "
            "Pro+ plan (Advanced Rate Limiting). Free-plan deploys MUST omit "
            "(default). Verified empirically 2026-05-07 — Free returns "
            "HTTP 400 'not entitled' on this field."
        ),
    )
    p.add_argument("--verbose", action="store_true", help="Log API I/O.")
    args = p.parse_args(argv)

    total = 4 if args.dry_run else 4
    step(1, total, "fetch CF API token from Key MCP")
    token = fetch_token_from_key_mcp()
    if not token:
        return fail("Key MCP token retrieval failed", 1)
    log(f"  token acquired ({len(token)} chars; never echoed)")

    step(2, total, f"resolve zone_id for {ZONE_NAME}")
    zone_id = resolve_zone_id(token, verbose=args.verbose)
    if not zone_id:
        return fail("zone resolve failed", 2)
    log(f"  zone_id: {zone_id}")

    step(3, total, "deploy rate-limit rule")
    t0 = time.monotonic()
    ok, resp, mode = deploy_rule(
        token,
        zone_id,
        dry_run=args.dry_run,
        force_path_only=args.force_path_only,
        with_upstream_exclusion=args.with_upstream_exclusion,
        verbose=args.verbose,
    )
    elapsed = time.monotonic() - t0

    step(4, total, "summarize")
    log(f"  mode_used: {mode}")
    log(f"  duration: {elapsed:.2f}s")
    if not ok:
        log(f"  result: FAIL — {json.dumps(resp)[:400]}")
        return 3
    if args.dry_run:
        log("  result: dry-run OK (no API mutation)")
        log(f"  rule body: {json.dumps(resp.get('rule'), indent=2)}")
        return 0
    rule_summary = (
        resp.get("result", {}) if isinstance(resp.get("result"), dict) else resp
    )
    log(f"  result: deployed (success={resp.get('success', True)})")
    if isinstance(rule_summary, dict) and rule_summary.get("id"):
        log(f"  rule_id: {rule_summary['id']}")
    if isinstance(rule_summary, dict) and rule_summary.get("ruleset_id"):
        log(f"  ruleset_id: {rule_summary['ruleset_id']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
