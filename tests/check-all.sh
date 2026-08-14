#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
while IFS= read -r -d '' f; do node --check "$f" >/dev/null; done < <(find "$ROOT/js" -type f -name '*.js' -print0)
node --check "$ROOT/mmo-server/signaling-server.js" >/dev/null
node "$ROOT/tests/layout-check.js"
node "$ROOT/tests/smoke-vm.js"
node "$ROOT/tests/server-qc-vm.js"
node "$ROOT/tests/optimistic-contract.js"
echo 'PSSF all checks: PASS'
