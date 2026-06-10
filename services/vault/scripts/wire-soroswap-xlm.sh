#!/usr/bin/env bash
# Baku — wire live SoroswapStrategy onto the existing vault-xlm.
#
# What this script does:
#   1. Sanity: stellar CLI present, $IDENTITY exists, scripts/deployed.testnet.env
#      already has VAULT_XLM (i.e. deploy-testnet.sh + wire-blend-xlm.sh ran).
#   2. Build contracts (idempotent).
#   3. Deploy SoroswapStrategy with:
#        - asset        = XLM (vault-xlm's underlying)
#        - paired_asset = Circle's testnet USDC (not Blend's)
#        - soroswap_pool = the XLM/Circle-USDC pair (verified by soroswap-spike.sh)
#        - soroswap_router = the Soroswap V0 testnet router
#   4. SoroswapStrategy.set_vault(admin, VAULT_XLM) — rewire to the real vault.
#   5. Vault(XLM).register_strategy(admin, SOROSWAP_STRATEGY_XLM) — append to
#      the registry. Active stays BlendStrategy(XLM); rotation is a follow-up
#      admin op via vault.rebalance.
#   6. Smoke reads: registry, active_strategy, soroswap strategy current_value
#      (0 until vault deposits into it).
#   7. Append SOROSWAP_STRATEGY_XLM=... to scripts/deployed.testnet.env.
#
# Idempotency: register_strategy reverts with StrategyAlreadyRegistered if rerun.
# For a clean re-wire, deploy a fresh SoroswapStrategy (re-running this script
# produces a new contract address each time — the old one is orphaned in the
# registry; the vault has no remove_strategy).
#
# Usage:
#   ./scripts/wire-soroswap-xlm.sh [IDENTITY]   # default IDENTITY=admin
#
# Pre-flight:
#   - scripts/soroswap-spike.sh --probe is green (pair exists, depth healthy)
#   - VAULT_XLM in scripts/deployed.testnet.env is on the NEW vault build that
#     has vault.rebalance — otherwise SoroswapStrategy will be unrotatable
#     without a full drain via redeem.

set -euo pipefail

IDENTITY="${1:-admin}"
NETWORK="testnet"
STELLAR_CLI="${STELLAR_CLI:-$HOME/.cargo/bin/stellar}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/scripts/deployed.testnet.env"

if [[ ! -x "$STELLAR_CLI" ]]; then
  echo "stellar CLI not found at $STELLAR_CLI. Override with STELLAR_CLI=/path/to/stellar." >&2
  exit 1
fi
if [[ ! -f "$ENV_FILE" ]]; then
  echo "$ENV_FILE missing. Run scripts/deploy-testnet.sh first." >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$ENV_FILE"
: "${VAULT_XLM:?VAULT_XLM not set in $ENV_FILE}"
: "${XLM_SAC:?XLM_SAC not set in $ENV_FILE}"
: "${ADMIN_ADDR:?ADMIN_ADDR not set in $ENV_FILE}"

# Pinned to verified-live testnet addresses (smoke test 2026-05-27):
# scripts/soroswap-spike.sh --probe walks through these and confirms each
# is responding before any deploy. If any of these change, update them
# atomically in: this file, scripts/soroswap-spike.sh, and the addresses
# modules (crates/addresses/src/lib.rs + api/src/addresses.ts).
SOROSWAP_ROUTER="CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD"
SOROSWAP_POOL_XLM_CIRCLE_USDC="CCBX3NZTCQLQFSPG7HBOKL4P2RVPOPVFHDNRTOSCCJWBTPL2GHEH7RQS"
CIRCLE_USDC_SAC="CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"

cli_version="$("$STELLAR_CLI" -V | head -1 | awk '{print $2}')"
maj="${cli_version%%.*}"
min_full="${cli_version#*.}"
min="${min_full%%.*}"
if (( maj < 25 )) || (( maj == 25 && min < 2 )); then
  echo "stellar CLI $cli_version too old (need >= 25.2.0)." >&2
  exit 1
fi

echo "→ stellar $cli_version, identity=$IDENTITY, network=$NETWORK"
echo "→ admin              : $ADMIN_ADDR"
echo "→ vault-xlm          : $VAULT_XLM"
echo "→ XLM SAC            : $XLM_SAC"
echo "→ Circle USDC SAC    : $CIRCLE_USDC_SAC"
echo "→ Soroswap router    : $SOROSWAP_ROUTER"
echo "→ Soroswap pair      : $SOROSWAP_POOL_XLM_CIRCLE_USDC"

# ── Step 1: Build (idempotent) ──────────────────────────────────────────
echo ""
echo "── Step 1: Build contracts ─────────────────────────────────────"
(cd "$ROOT" && "$STELLAR_CLI" contract build > /dev/null)
SOROSWAP_WASM="$ROOT/target/wasm32v1-none/release/baku_soroswap_strategy.wasm"
[[ -f "$SOROSWAP_WASM" ]] || { echo "missing $SOROSWAP_WASM" >&2; exit 1; }
echo "  built: $(basename "$SOROSWAP_WASM")"

# ── Step 2: Deploy SoroswapStrategy ─────────────────────────────────────
echo ""
echo "── Step 2: Deploy SoroswapStrategy(XLM↔CircleUSDC) ─────────────"
PLACEHOLDER_VAULT="$ADMIN_ADDR" # rewired in step 3
# initial_apy_bps = 500 (5%) is an informational placeholder surfaced to
# the API. Soroswap LP APY isn't computable on-chain — it tracks pool
# volume / fee rate, both off-chain signals. Admin can refine via
# set_pool_apy_bps once we have a real estimate.
SOROSWAP_STRATEGY_XLM="$("$STELLAR_CLI" contract deploy \
  --wasm "$SOROSWAP_WASM" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- \
  --admin "$ADMIN_ADDR" \
  --vault "$PLACEHOLDER_VAULT" \
  --asset "$XLM_SAC" \
  --soroswap_pool "$SOROSWAP_POOL_XLM_CIRCLE_USDC" \
  --soroswap_router "$SOROSWAP_ROUTER" \
  --paired_asset "$CIRCLE_USDC_SAC" \
  --initial_apy_bps 500 \
  2>&1 | tee /dev/stderr | grep -oE 'C[A-Z0-9]{55}' | tail -1)"
echo "  → SoroswapStrategy(XLM): $SOROSWAP_STRATEGY_XLM"

# ── Step 3: Rewire strategy.vault → VAULT_XLM ───────────────────────────
echo ""
echo "── Step 3: SoroswapStrategy.set_vault(VAULT_XLM) ───────────────"
"$STELLAR_CLI" contract invoke \
  --id "$SOROSWAP_STRATEGY_XLM" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- \
  set_vault \
  --admin "$ADMIN_ADDR" \
  --new_vault "$VAULT_XLM"
echo "  ✓ SoroswapStrategy.vault → $VAULT_XLM"

# ── Step 4: Register on vault ───────────────────────────────────────────
echo ""
echo "── Step 4: Vault(XLM).register_strategy ────────────────────────"
"$STELLAR_CLI" contract invoke \
  --id "$VAULT_XLM" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- \
  register_strategy \
  --admin "$ADMIN_ADDR" \
  --strategy "$SOROSWAP_STRATEGY_XLM"
echo "  ✓ registered $SOROSWAP_STRATEGY_XLM"

# ── Step 5: Smoke reads ─────────────────────────────────────────────────
echo ""
echo "── Step 5: Smoke reads ─────────────────────────────────────────"
echo -n "  vault.active_strategy()    = "
"$STELLAR_CLI" contract invoke --id "$VAULT_XLM" --source "$IDENTITY" --network "$NETWORK" -- active_strategy
echo -n "  vault.strategy_registry()  = "
"$STELLAR_CLI" contract invoke --id "$VAULT_XLM" --source "$IDENTITY" --network "$NETWORK" -- strategy_registry
echo -n "  soroswap.current_value()   = "
"$STELLAR_CLI" contract invoke --id "$SOROSWAP_STRATEGY_XLM" --source "$IDENTITY" --network "$NETWORK" -- current_value
echo -n "  soroswap.pool_apy()        = "
"$STELLAR_CLI" contract invoke --id "$SOROSWAP_STRATEGY_XLM" --source "$IDENTITY" --network "$NETWORK" -- pool_apy
echo -n "  soroswap.max_slippage_bps  = "
"$STELLAR_CLI" contract invoke --id "$SOROSWAP_STRATEGY_XLM" --source "$IDENTITY" --network "$NETWORK" -- max_slippage_bps

# ── Step 6: Append to env file ──────────────────────────────────────────
if grep -q '^SOROSWAP_STRATEGY_XLM=' "$ENV_FILE"; then
  sed -i '' -e "s|^SOROSWAP_STRATEGY_XLM=.*|SOROSWAP_STRATEGY_XLM=$SOROSWAP_STRATEGY_XLM|" "$ENV_FILE"
else
  printf '\n# Appended by wire-soroswap-xlm.sh on %s\nSOROSWAP_STRATEGY_XLM=%s\nSOROSWAP_ROUTER=%s\nSOROSWAP_POOL_XLM_CIRCLE_USDC=%s\nCIRCLE_USDC_SAC=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$SOROSWAP_STRATEGY_XLM" \
    "$SOROSWAP_ROUTER" \
    "$SOROSWAP_POOL_XLM_CIRCLE_USDC" \
    "$CIRCLE_USDC_SAC" >> "$ENV_FILE"
fi

echo ""
echo "── Done. $ENV_FILE updated. ────────────────────────────────────"
echo "SOROSWAP_STRATEGY_XLM=$SOROSWAP_STRATEGY_XLM"
echo ""
echo "Next:"
echo "  - promote this address + Soroswap router + Circle USDC SAC into"
echo "    api/src/addresses.ts (TESTNET.soroswapStrategyXlm, etc.) and"
echo "    crates/addresses/src/lib.rs"
echo "  - to rotate funds from Blend → Soroswap:"
echo "      stellar contract invoke --id $VAULT_XLM --source admin --network testnet \\"
echo "        -- rebalance --admin $ADMIN_ADDR --to_strategy $SOROSWAP_STRATEGY_XLM"
