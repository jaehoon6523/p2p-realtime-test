#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
while IFS= read -r -d '' f; do node --check "$f" >/dev/null; done < <(find "$ROOT/js" -type f -name '*.js' -print0)
node --check "$ROOT/mmo-server/signaling-server.js" >/dev/null
node "$ROOT/tests/layout-check.js"
node "$ROOT/tests/smoke-vm.js"
node "$ROOT/tests/server-qc-vm.js"
node "$ROOT/tests/optimistic-contract.js"
node "$ROOT/tests/bootstrap-ordering.js"
node "$ROOT/tests/bootstrap-rx-ordering.js"
echo 'PSSF all checks: PASS'
node "$(dirname "$0")/auto-mesh-repair.js"
node "$(dirname "$0")/bootstrap-command-backlog.js"

node tests/movement-stale-ref.js
