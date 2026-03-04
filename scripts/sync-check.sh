#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_SRC="$REPO_ROOT/src"

WORK_DIR="/tmp/acp-seller-sync-check-$$"
AGENT_PULSE_DIR="$WORK_DIR/agent-pulse"
UPSTREAM_SRC="$AGENT_PULSE_DIR/packages/acp-seller/src"

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

mkdir -p "$WORK_DIR"

echo "[sync-check] Cloning consensus-hq/agent-pulse into $AGENT_PULSE_DIR"
git clone --depth 1 https://github.com/consensus-hq/agent-pulse.git "$AGENT_PULSE_DIR" >/dev/null

declare -a FILES=(
  "seller/runtime/seller.ts"
  "seller/runtime/offerings.ts"
  "seller/offerings/canonical-catalog.ts"
  "seller/offerings/x402janus/guardianShared.ts"
  "seller/offerings/x402janus/janusShared.ts"
  "seller/offerings/x402janus/x402janus_scan_quick/offering.json"
  "seller/offerings/x402janus/x402janus_scan_standard/offering.json"
  "seller/offerings/x402janus/x402janus_scan_deep/offering.json"
  "seller/offerings/x402janus/x402janus_approvals/offering.json"
  "seller/offerings/x402janus/x402janus_revoke/offering.json"
  "seller/offerings/x402janus/x402janus_revoke_batch/offering.json"
)

DRIFT_COUNT=0

for rel_path in "${FILES[@]}"; do
  local_file="$LOCAL_SRC/$rel_path"
  upstream_file="$UPSTREAM_SRC/$rel_path"

  echo ""
  echo "[sync-check] Checking $rel_path"

  if [[ ! -f "$local_file" && ! -f "$upstream_file" ]]; then
    echo "  = missing in both repos (no drift)"
    continue
  fi

  if [[ ! -f "$local_file" ]]; then
    echo "  ! missing locally: $local_file"
    DRIFT_COUNT=$((DRIFT_COUNT + 1))
    continue
  fi

  if [[ ! -f "$upstream_file" ]]; then
    echo "  ! missing in agent-pulse: $upstream_file"
    DRIFT_COUNT=$((DRIFT_COUNT + 1))
    continue
  fi

  if diff -u "$local_file" "$upstream_file" >/tmp/acp-seller-sync-check.diff; then
    echo "  ✓ in sync"
  else
    echo "  ✗ drift detected"
    sed 's/^/    /' /tmp/acp-seller-sync-check.diff
    DRIFT_COUNT=$((DRIFT_COUNT + 1))
  fi
done

echo ""
if [[ "$DRIFT_COUNT" -gt 0 ]]; then
  echo "[sync-check] Drift detected in $DRIFT_COUNT file(s)."
  exit 1
fi

echo "[sync-check] ✅ acp-seller and agent-pulse are in sync for all guarded files."
