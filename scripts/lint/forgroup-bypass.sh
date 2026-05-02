#!/usr/bin/env bash
# Block PRs whose route handlers query D1 without going through forGroup().
# Allowlist: workers/lib/bootstrap-owner.ts (intentional unsafe insert during
# first-login), workers/middleware/authz-context.ts (it IS the authz layer),
# workers/db/control-plane/forGroup.ts (the helper itself).

set -euo pipefail

cd "$(dirname "$0")/../.."

ALLOWLIST=(
  "workers/lib/bootstrap-owner.ts"
  "workers/middleware/authz-context.ts"
  "workers/db/control-plane/forGroup.ts"
)

# Find handlers that import drizzle/d1 directly — anything under workers/routes
# or workers/index.ts is a handler and must use forGroup().
VIOLATIONS=()
while IFS= read -r file; do
  is_allowed=false
  for allow in "${ALLOWLIST[@]}"; do
    if [[ "$file" == "$allow" ]]; then
      is_allowed=true
      break
    fi
  done
  if [[ "$is_allowed" == "false" ]]; then
    VIOLATIONS+=("$file")
  fi
done < <(grep -rl --include="*.ts" -E "from ['\"]drizzle-orm/d1['\"]|from ['\"]\\.\\./db/control-plane/schema['\"]" workers/ | grep -v -E "node_modules|/__test__/" || true)

if [[ ${#VIOLATIONS[@]} -gt 0 ]]; then
  echo "[FAIL] forGroup bypass detected — handlers must import from workers/db/control-plane/forGroup.ts, not drizzle directly:"
  printf '  - %s\n' "${VIOLATIONS[@]}"
  echo ""
  echo "Allowlist (intentional bypass):"
  printf '  - %s\n' "${ALLOWLIST[@]}"
  exit 1
fi

echo "[OK] No forGroup bypass detected (${#ALLOWLIST[@]} allowlisted entries)"
