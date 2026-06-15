#!/usr/bin/env bash
# Baku — wire live BlendStrategy(XLM) onto the existing vault-xlm.
#
# Why this exists separately from deploy-testnet.sh:
#   The main deploy script does a clean from-scratch deploy and rewrites
#   every address. After PR 3 we have a working vault-xlm (currently
#   running MockStrategy) and a live vault-usdc (Blend). Replacing the
#   XLM track with Blend should be additive — don't disturb USDC, don't
#   churn the vault-xlm address that's already pinned in
#   api/src/addresses.ts.
#
# What this script does:
#   1. Sanity: stellar CLI present, $IDENTITY exists, scripts/deployed.testnet.env
#      already has VAULT_XLM + MOCK_STRATEGY_XLM (i.e. main script ran once).
#   2. Verify MockStrategy(XLM).current_value() == 0 (vault invariant for
#      set_active_strategy — see VaultError::StrategyHasBalance).
#   3. Deploy BlendStrategy(XLM) using the existing Blend V2 testnet pool
#      and BLND token addresses (single pool, multiple reserves).
#   4. BlendStrategy(XLM).set_vault(admin, VAULT_XLM) — rewire to the real
#      vault (constructor took a placeholder, same dance as USDC track).
#   5. Vault(XLM).register_strategy(admin, BLEND_STRATEGY_XLM) — append to
#      the registry. Mock stays registered (vault has no remove_strategy);
#      the multi-strategy registry path is now exercised live.
#   6. Vault(XLM).set_active_strategy(admin, BLEND_STRATEGY_XLM) — switch.
#   7. Smoke reads: active_strategy + total_assets.
#   8. Append BLEND_STRATEGY_XLM=... to scripts/deployed.testnet.env.
#
# Re-runnability:
#   register_strategy reverts with StrategyAlreadyRegistered if rerun, and
#   set_active_strategy is a no-op semantically (still requires drained
#   current). If you need to re-run from scratch, deploy a fresh
#   BlendStrategy and pass --force-redeploy (TODO if it becomes a thing).
#   For now, expect this to be a one-shot.
#
# Usage:
#   ./scripts/wire-blend-xlm.sh [IDENTITY]   # default IDENTITY=admin

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
: "${VAULT_XLM:?VAULT_XLM not set in $ENV_FILE — main deploy must run first}"
: "${MOCK_STRATEGY_XLM:?MOCK_STRATEGY_XLM not set in $ENV_FILE}"
: "${XLM_SAC:?XLM_SAC not set in $ENV_FILE}"
: "${ADMIN_ADDR:?ADMIN_ADDR not set in $ENV_FILE}"

# Blend V2 testnet — single pool serves both XLM and USDC reserves.
# Source: crates/addresses/src/lib.rs TESTNET + scripts/deploy-testnet.sh.
BLEND_POOL_TESTNET="${BLEND_POOL:-CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF}"
BLND_TOKEN_TESTNET="${BLND_TOKEN:-CB22KRA3YZVCNCQI64JQ5WE7UY2VAV7WFLK6A2JN3HEX56T2EDAFO7QF}"

cli_version="$("$STELLAR_CLI" -V | head -1 | awk '{print $2}')"
maj="${cli_version%%.*}"
min_full="${cli_version#*.}"
min="${min_full%%.*}"
if (( maj < 25 )) || (( maj == 25 && min < 2 )); then
  echo "stellar CLI $cli_version too old (need >= 25.2.0)." >&2
  exit 1
fi

echo "→ stellar $cli_version, identity=$IDENTITY, network=$NETWORK"
echo "→ admin       : $ADMIN_ADDR"
echo "→ vault-xlm   : $VAULT_XLM"
echo "→ mock(XLM)   : $MOCK_STRATEGY_XLM"
echo "→ Blend pool  : $BLEND_POOL_TESTNET"

# ── Pre-flight: mock must be drained before set_active_strategy ─────────
echo ""
echo "── Pre-flight: MockStrategy(XLM).current_value() ────────────────"
MOCK_CV="$("$STELLAR_CLI" contract invoke \
  --id "$MOCK_STRATEGY_XLM" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- \
  current_value 2>/dev/null | tr -d '"')"
echo "  current_value = $MOCK_CV"
if [[ "$MOCK_CV" != "0" ]]; then
  echo "Mock is not drained (current_value=$MOCK_CV). Withdraw all assets from" >&2
  echo "the vault before switching strategies." >&2
  exit 1
fi

# ── Step 1: Build (idempotent) ──────────────────────────────────────────
echo ""
echo "── Step 1: Build contracts ─────────────────────────────────────"
(cd "$ROOT" && "$STELLAR_CLI" contract build > /dev/null)
BLEND_WASM="$ROOT/target/wasm32v1-none/release/baku_blend_strategy.wasm"
[[ -f "$BLEND_WASM" ]] || { echo "missing $BLEND_WASM" >&2; exit 1; }
echo "  built: $(basename "$BLEND_WASM")"

# ── Step 2: Deploy BlendStrategy(XLM) ───────────────────────────────────
echo ""
echo "── Step 2: Deploy BlendStrategy(XLM) ───────────────────────────"
PLACEHOLDER_VAULT="$ADMIN_ADDR" # rewired in step 3
BLEND_STRATEGY_XLM="$("$STELLAR_CLI" contract deploy \
  --wasm "$BLEND_WASM" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- \
  --admin "$ADMIN_ADDR" \
  --vault "$PLACEHOLDER_VAULT" \
  --asset "$XLM_SAC" \
  --blend_pool "$BLEND_POOL_TESTNET" \
  --blnd_token "$BLND_TOKEN_TESTNET" \
  --initial_apy_bps 500 \
  2>&1 | tee /dev/stderr | grep -oE 'C[A-Z0-9]{55}' | tail -1)"
echo "  → BlendStrategy(XLM): $BLEND_STRATEGY_XLM"

# ── Step 3: Rewire strategy.vault → VAULT_XLM ───────────────────────────
echo ""
echo "── Step 3: BlendStrategy(XLM).set_vault(VAULT_XLM) ─────────────"
"$STELLAR_CLI" contract invoke \
  --id "$BLEND_STRATEGY_XLM" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- \
  set_vault \
  --admin "$ADMIN_ADDR" \
  --new_vault "$VAULT_XLM"
echo "  ✓ BlendStrategy(XLM).vault → $VAULT_XLM"

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
  --strategy "$BLEND_STRATEGY_XLM"
echo "  ✓ registered $BLEND_STRATEGY_XLM"

# ── Step 5: Switch active ───────────────────────────────────────────────
echo ""
echo "── Step 5: Vault(XLM).set_active_strategy ──────────────────────"
"$STELLAR_CLI" contract invoke \
  --id "$VAULT_XLM" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- \
  set_active_strategy \
  --admin "$ADMIN_ADDR" \
  --new_strategy "$BLEND_STRATEGY_XLM"
echo "  ✓ active_strategy → $BLEND_STRATEGY_XLM"

# ── Step 6: Smoke reads ─────────────────────────────────────────────────
echo ""
echo "── Step 6: Smoke reads ─────────────────────────────────────────"
echo -n "  vault.active_strategy() = "
"$STELLAR_CLI" contract invoke --id "$VAULT_XLM" --source "$IDENTITY" --network "$NETWORK" -- active_strategy
echo -n "  vault.total_assets()    = "
"$STELLAR_CLI" contract invoke --id "$VAULT_XLM" --source "$IDENTITY" --network "$NETWORK" -- total_assets
echo -n "  vault.strategy_registry() = "
"$STELLAR_CLI" contract invoke --id "$VAULT_XLM" --source "$IDENTITY" --network "$NETWORK" -- strategy_registry

# ── Step 7: Append to env file ──────────────────────────────────────────
if grep -q '^BLEND_STRATEGY_XLM=' "$ENV_FILE"; then
  # Replace existing line (BSD sed quirk: -i needs an empty backup arg).
  sed -i '' -e "s|^BLEND_STRATEGY_XLM=.*|BLEND_STRATEGY_XLM=$BLEND_STRATEGY_XLM|" "$ENV_FILE"
else
  printf '\n# Appended by wire-blend-xlm.sh on %s\nBLEND_STRATEGY_XLM=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$BLEND_STRATEGY_XLM" >> "$ENV_FILE"
fi

echo ""
echo "── Done. $ENV_FILE updated. ────────────────────────────────────"
echo "BLEND_STRATEGY_XLM=$BLEND_STRATEGY_XLM"
echo ""
echo "Next: promote this address into api/src/addresses.ts (TESTNET.blendStrategyXlm)"
echo "and crates/addresses/src/lib.rs."
