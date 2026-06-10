#!/usr/bin/env bash
# Baku — deploy the Weighted Meta-Allocator on XLM with fresh Blend + Soroswap
# children, wired to a 30% Blend / 40% Soroswap / 30% native allocation.
#
# Why fresh children? The allocator drives its children as their "vault": it
# calls child.deposit(allocator_addr, slice), so each child must have its
# stored `vault` == the allocator's address. The production Blend/Soroswap
# strategies in deployed.testnet.env are bound to VAULT_XLM, so we deploy new
# instances here bound to the allocator instead.
#
# Auth model end-to-end:
#   depositor (admin) --require_auth--> allocator.deposit
#     allocator --transfer--> child            (allocator is invoker: auto-auth)
#     allocator --call--> child.deposit(allocator)   (child.assert_vault == allocator)
#       child --authorize_as_current_contract--> pool/router sub-transfer  (the auth fix)
#
# DEMO-ONLY CAVEAT: both children are added authoritative=true so the Soroswap
# (LP) child can carry the 40% weight. V0 normally forbids weight on non-
# authoritative children because current_value() is an estimate. Do NOT ship a
# weighted LP child to mainnet without the deferred TWAP/oracle hardening.
#
# Usage:
#   ./scripts/deploy-allocator-xlm.sh [IDENTITY] [--demo [AMOUNT_STROOPS]]
#     IDENTITY    stellar key to sign with + use as admin/depositor (default: admin)
#     --demo      after wiring, fund the allocator and run one weighted deposit
#     AMOUNT      deposit size in stroops for --demo (default 1000000000 = 100 XLM)

set -euo pipefail

IDENTITY="${1:-admin}"
NETWORK="testnet"
DEMO=0
DEMO_AMT="1000000000"   # 100 XLM
shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --demo) DEMO=1; shift; [[ "${1:-}" =~ ^[0-9]+$ ]] && { DEMO_AMT="$1"; shift; } ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/scripts/deployed.testnet.env"
OUT_FILE="$ROOT/scripts/deployed.allocator.testnet.env"
STELLAR="${STELLAR_CLI:-stellar}"

# shellcheck disable=SC1090
source "$ENV_FILE"
: "${XLM_SAC:?}"; : "${BLEND_POOL:?}"; : "${BLND_TOKEN:?}"
: "${SOROSWAP_ROUTER:?}"; : "${SOROSWAP_POOL_XLM_CIRCLE_USDC:?}"; : "${CIRCLE_USDC_SAC:?}"

ADMIN_ADDR="$("$STELLAR" keys address "$IDENTITY")"
WASM_DIR="$ROOT/target/wasm32v1-none/release"
echo "→ identity=$IDENTITY admin=$ADMIN_ADDR network=$NETWORK"

# ── Build ───────────────────────────────────────────────────────────────
echo "── Build ───────────────────────────────────────────────────────"
(cd "$ROOT" && "$STELLAR" contract build > /dev/null)

dep() {  # deploy <wasm> -- <ctor args...>  ->  prints contract id
  local wasm="$1"; shift
  "$STELLAR" contract deploy --wasm "$wasm" --source "$IDENTITY" --network "$NETWORK" -- "$@" \
    2>/dev/null | grep -oE 'C[A-Z0-9]{55}' | tail -1
}
inv() { "$STELLAR" contract invoke --id "$1" --source "$IDENTITY" --network "$NETWORK" -- "${@:2}"; }

# ── 1. Allocator (vault = depositor, no children, native = 100%) ────────
echo "── Deploy allocator ────────────────────────────────────────────"
ALLOC="$(dep "$WASM_DIR/baku_allocator_strategy.wasm" \
  --admin "$ADMIN_ADDR" --vault "$ADMIN_ADDR" --asset "$XLM_SAC" \
  --initial_children '[]' --native_bps 10000)"
echo "  allocator = $ALLOC"

# ── 2. Fresh children bound to the allocator ────────────────────────────
echo "── Deploy Blend child (vault = allocator) ──────────────────────"
BLEND_CHILD="$(dep "$WASM_DIR/baku_blend_strategy.wasm" \
  --admin "$ADMIN_ADDR" --vault "$ALLOC" --asset "$XLM_SAC" \
  --blend_pool "$BLEND_POOL" --blnd_token "$BLND_TOKEN" --initial_apy_bps 500)"
echo "  blend child = $BLEND_CHILD"

echo "── Deploy Soroswap child (vault = allocator) ───────────────────"
SORO_CHILD="$(dep "$WASM_DIR/baku_soroswap_strategy.wasm" \
  --admin "$ADMIN_ADDR" --vault "$ALLOC" --asset "$XLM_SAC" \
  --soroswap_pool "$SOROSWAP_POOL_XLM_CIRCLE_USDC" --soroswap_router "$SOROSWAP_ROUTER" \
  --paired_asset "$CIRCLE_USDC_SAC" --initial_apy_bps 500)"
echo "  soroswap child = $SORO_CHILD"

# ── 3. Register + weight (30 / 40 / 30) ─────────────────────────────────
echo "── add_child + set_target_weights (3000/4000/3000) ─────────────"
inv "$ALLOC" add_child --admin "$ADMIN_ADDR" --strategy "$BLEND_CHILD" --authoritative true >/dev/null
inv "$ALLOC" add_child --admin "$ADMIN_ADDR" --strategy "$SORO_CHILD"  --authoritative true >/dev/null
inv "$ALLOC" set_target_weights --admin "$ADMIN_ADDR" \
  --child_weights "[[\"$BLEND_CHILD\",3000],[\"$SORO_CHILD\",4000]]" --native_bps 3000 >/dev/null
echo "  children = $(inv "$ALLOC" children 2>/dev/null)"

# ── 4. Record ───────────────────────────────────────────────────────────
cat > "$OUT_FILE" <<EOF
# Auto-written by deploy-allocator-xlm.sh
NETWORK=testnet
ADMIN_ADDR=$ADMIN_ADDR
ASSET_XLM_SAC=$XLM_SAC
ALLOCATOR_XLM=$ALLOC
ALLOC_BLEND_CHILD_XLM=$BLEND_CHILD
ALLOC_SOROSWAP_CHILD_XLM=$SORO_CHILD
ALLOC_NATIVE_BPS=3000
EOF
echo "  wrote $OUT_FILE"

# ── 5. Optional demo deposit ────────────────────────────────────────────
if [[ "$DEMO" == "1" ]]; then
  echo "── Demo: fund allocator + deposit $DEMO_AMT stroops ────────────"
  inv "$XLM_SAC" transfer --from "$ADMIN_ADDR" --to "$ALLOC" --amount "$DEMO_AMT" >/dev/null
  inv "$ALLOC" deposit --vault "$ADMIN_ADDR" --amount "$DEMO_AMT" >/dev/null
  echo "  allocator native XLM  = $(inv "$XLM_SAC" balance --id "$ALLOC" 2>/dev/null)"
  echo "  blend  child cur_value = $(inv "$BLEND_CHILD" current_value 2>/dev/null)"
  echo "  soro   child cur_value = $(inv "$SORO_CHILD" current_value 2>/dev/null)"
  echo "  allocator current_value= $(inv "$ALLOC" current_value 2>/dev/null)"
fi

echo "── Done. allocator=$ALLOC ──────────────────────────────────────"
