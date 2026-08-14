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
node "$ROOT/tests/auto-mesh-repair.js"
node "$ROOT/tests/direct-channel-repair.js"
node "$ROOT/tests/incoming-offer-repair.js"
node "$ROOT/tests/bootstrap-ordered-transport.js"
node "$ROOT/tests/movement-stale-ref.js"
node "$ROOT/tests/movement-single-source.js"
node "$ROOT/tests/movement-retarget-live.js"
node "$ROOT/tests/movement-velocity-continuity.js"
node "$ROOT/tests/combat-move-concurrency.js"
node "$ROOT/tests/asset-version-pin.js"
echo 'PSSF all checks: PASS'
