#!/usr/bin/env bash
# Baku — redeploy a BlendStrategy in place to ship the auth-fix from
# crates/blend-strategy/src/lib.rs.
#
# Why this exists:
#   The first-shipped BlendStrategy::deposit invokes Blend's `pool.submit`
#   without calling `env.authorize_as_current_contract(...)`, so when Blend's
#   pool tries to `token.transfer(strategy, pool, amount)` on the SAC the
#   call traps with Error(Auth, InvalidAction). This was invisible to unit
#   tests (which use `mock_all_auths`) and only surfaces on live networks.
#   Fix landed in lib.rs; this script swaps the deployed strategy.
#
# What this script does (per track):
#   1. Pre-flight: existing BLEND_STRATEGY_<TRACK>.current_value() == 0
#      (set_active_strategy reverts with VaultError::StrategyHasBalance
#      otherwise — withdraw before redeploying).
#   2. Build contracts.
#   3. Deploy a fresh BlendStrategy with admin as placeholder vault.
#   4. set_vault(admin, VAULT_<TRACK>) on the new strategy.
#   5. Vault.register_strategy(new) — new address, so no
#      StrategyAlreadyRegistered conflict.
#   6. Vault.set_active_strategy(new) — switch over.
#   7. Smoke reads (active_strategy, total_assets, strategy_registry).
#   8. Rewrite BLEND_STRATEGY_<TRACK>=... in scripts/deployed.testnet.env.
#
# Note: the old strategy stays in the vault's strategy_registry forever
# (vault has no remove_strategy). That's fine — only `active_strategy`
# receives new deposits.
#
# Usage:
#   ./scripts/redeploy-blend-strategy.sh xlm  [IDENTITY]   # default IDENTITY=admin
#   ./scripts/redeploy-blend-strategy.sh usdc [IDENTITY]

set -euo pipefail

TRACK="${1:-}"
IDENTITY="${2:-admin}"
NETWORK="testnet"
STELLAR_CLI="${STELLAR_CLI:-$HOME/.cargo/bin/stellar}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/scripts/deployed.testnet.env"

case "$TRACK" in
  xlm|XLM)
    TRACK_UPPER="XLM"
    VAULT_VAR="VAULT_XLM"
    SAC_VAR="XLM_SAC"
    STRAT_VAR="BLEND_STRATEGY_XLM"
    ;;
  usdc|USDC)
    TRACK_UPPER="USDC"
    VAULT_VAR="VAULT_USDC"
    SAC_VAR="USDC_SAC"
    STRAT_VAR="BLEND_STRATEGY_USDC"
    ;;
  *)
    echo "usage: $0 {xlm|usdc} [IDENTITY]" >&2
    exit 1
    ;;
esac

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

VAULT_ADDR="${!VAULT_VAR:-}"
SAC_ADDR="${!SAC_VAR:-}"
OLD_STRATEGY="${!STRAT_VAR:-}"
: "${VAULT_ADDR:?$VAULT_VAR not set in $ENV_FILE}"
: "${SAC_ADDR:?$SAC_VAR not set in $ENV_FILE}"
: "${OLD_STRATEGY:?$STRAT_VAR not set in $ENV_FILE — nothing to redeploy onto}"
: "${ADMIN_ADDR:?ADMIN_ADDR not set in $ENV_FILE}"
: "${BLEND_POOL:?BLEND_POOL not set in $ENV_FILE}"
: "${BLND_TOKEN:?BLND_TOKEN not set in $ENV_FILE}"

cli_version="$("$STELLAR_CLI" -V | head -1 | awk '{print $2}')"
maj="${cli_version%%.*}"
min_full="${cli_version#*.}"
min="${min_full%%.*}"
if (( maj < 25 )) || (( maj == 25 && min < 2 )); then
  echo "stellar CLI $cli_version too old (need >= 25.2.0)." >&2
  exit 1
fi

echo "→ stellar $cli_version, identity=$IDENTITY, network=$NETWORK, track=$TRACK_UPPER"
echo "→ admin            : $ADMIN_ADDR"
echo "→ vault            : $VAULT_ADDR"
echo "→ asset (SAC)      : $SAC_ADDR"
echo "→ Blend pool       : $BLEND_POOL"
echo "→ old strategy     : $OLD_STRATEGY (will be replaced as active)"

# ── Pre-flight: existing strategy must be drained ───────────────────────
echo ""
echo "── Pre-flight: $STRAT_VAR.current_value() ──────────────────────"
OLD_CV="$("$STELLAR_CLI" contract invoke \
  --id "$OLD_STRATEGY" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- \
  current_value 2>/dev/null | tr -d '"')"
echo "  current_value = $OLD_CV"
if [[ "$OLD_CV" != "0" ]]; then
  echo "Old strategy holds a position (current_value=$OLD_CV). Withdraw all" >&2
  echo "via the vault before redeploying — set_active_strategy reverts with" >&2
  echo "VaultError::StrategyHasBalance otherwise." >&2
  exit 1
fi

# ── Step 1: Build ───────────────────────────────────────────────────────
echo ""
echo "── Step 1: Build contracts ─────────────────────────────────────"
(cd "$ROOT" && "$STELLAR_CLI" contract build > /dev/null)
BLEND_WASM="$ROOT/target/wasm32v1-none/release/baku_blend_strategy.wasm"
[[ -f "$BLEND_WASM" ]] || { echo "missing $BLEND_WASM" >&2; exit 1; }
echo "  built: $(basename "$BLEND_WASM") ($(wc -c <"$BLEND_WASM" | tr -d ' ') bytes)"

# ── Step 2: Deploy fresh strategy ───────────────────────────────────────
echo ""
echo "── Step 2: Deploy BlendStrategy($TRACK_UPPER) ──────────────────"
PLACEHOLDER_VAULT="$ADMIN_ADDR" # rewired in step 3
NEW_STRATEGY="$("$STELLAR_CLI" contract deploy \
  --wasm "$BLEND_WASM" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- \
  --admin "$ADMIN_ADDR" \
  --vault "$PLACEHOLDER_VAULT" \
  --asset "$SAC_ADDR" \
  --blend_pool "$BLEND_POOL" \
  --blnd_token "$BLND_TOKEN" \
  --initial_apy_bps 500 \
  2>&1 | tee /dev/stderr | grep -oE 'C[A-Z0-9]{55}' | tail -1)"
echo "  → new $STRAT_VAR: $NEW_STRATEGY"

if [[ "$NEW_STRATEGY" == "$OLD_STRATEGY" ]]; then
  echo "Deploy returned the SAME address ($NEW_STRATEGY). Expected a fresh" >&2
  echo "contract id. Aborting before we touch the vault." >&2
  exit 1
fi

# ── Step 3: Rewire strategy.vault → real vault ──────────────────────────
echo ""
echo "── Step 3: BlendStrategy($TRACK_UPPER).set_vault($VAULT_VAR) ───"
"$STELLAR_CLI" contract invoke \
  --id "$NEW_STRATEGY" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- \
  set_vault \
  --admin "$ADMIN_ADDR" \
  --new_vault "$VAULT_ADDR"
echo "  ✓ strategy.vault → $VAULT_ADDR"

# ── Step 4: Register new strategy on vault ──────────────────────────────
echo ""
echo "── Step 4: Vault.register_strategy(new) ────────────────────────"
"$STELLAR_CLI" contract invoke \
  --id "$VAULT_ADDR" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- \
  register_strategy \
  --admin "$ADMIN_ADDR" \
  --strategy "$NEW_STRATEGY"
echo "  ✓ registered $NEW_STRATEGY"

# ── Step 5: Switch active ───────────────────────────────────────────────
echo ""
echo "── Step 5: Vault.set_active_strategy(new) ──────────────────────"
"$STELLAR_CLI" contract invoke \
  --id "$VAULT_ADDR" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- \
  set_active_strategy \
  --admin "$ADMIN_ADDR" \
  --new_strategy "$NEW_STRATEGY"
echo "  ✓ active_strategy → $NEW_STRATEGY"

# ── Step 6: Smoke reads ─────────────────────────────────────────────────
echo ""
echo "── Step 6: Smoke reads ─────────────────────────────────────────"
echo -n "  vault.active_strategy()   = "
"$STELLAR_CLI" contract invoke --id "$VAULT_ADDR" --source "$IDENTITY" --network "$NETWORK" -- active_strategy
echo -n "  vault.total_assets()      = "
"$STELLAR_CLI" contract invoke --id "$VAULT_ADDR" --source "$IDENTITY" --network "$NETWORK" -- total_assets
echo -n "  vault.strategy_registry() = "
"$STELLAR_CLI" contract invoke --id "$VAULT_ADDR" --source "$IDENTITY" --network "$NETWORK" -- strategy_registry

# ── Step 7: Persist new address ─────────────────────────────────────────
if grep -q "^$STRAT_VAR=" "$ENV_FILE"; then
  sed -i '' -e "s|^$STRAT_VAR=.*|$STRAT_VAR=$NEW_STRATEGY|" "$ENV_FILE"
else
  printf '\n# Appended by redeploy-blend-strategy.sh on %s\n%s=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$STRAT_VAR" "$NEW_STRATEGY" >> "$ENV_FILE"
fi

echo ""
echo "── Done. $ENV_FILE updated. ────────────────────────────────────"
echo "$STRAT_VAR=$NEW_STRATEGY (old: $OLD_STRATEGY)"
echo ""
echo "Next:"
echo "  - Promote $NEW_STRATEGY into api/src/addresses.ts and"
echo "    crates/addresses/src/lib.rs."
echo "  - Re-test deposit through the UI; the Auth/InvalidAction trap should be gone."
