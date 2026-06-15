#!/usr/bin/env bash
# Baku — deploy DefindexStrategy(USDC) and register it on vault-usdc as a
# second (non-active) registered strategy.
#
# Why this exists:
#   vault-usdc currently has only BlendStrategy USDC registered. The Direction
#   C plan (B3) calls for a second protocol registered alongside Blend so the
#   multi-strategy registry path is exercised on the USDC track too — matching
#   what vault-xlm already proves with [Mock, Blend, Soroswap].
#
#   DeFindex (paltalabs) ships a Blend-USDC strategy contract at testnet
#   address CALLOM5I7XLQPPOPQMYAHUWW4N7O3JKT42KQ4ASEEVBXDJQNJOALFSUY whose
#   asset() returns the same Blend testnet USDC SAC we use. Our adapter
#   relays through that contract instead of redeploying our own DeFindex
#   reference instance (safer + cheaper for a hackathon demo). The adapter
#   pre-authorizes the SAC.transfer sub-invocation that DeFindex's deposit
#   triggers internally — same auth-fix pattern as BlendStrategy V2.
#
# What this script does, in order:
#   1. Sanity: stellar CLI present, $IDENTITY exists, scripts/deployed.testnet.env
#      already has VAULT_USDC + USDC_SAC + ADMIN_ADDR (main deploy must have run).
#   2. Build all contracts (idempotent).
#   3. Deploy DefindexStrategy(USDC) using DEFINDEX_REF_BLEND_USDC as the
#      inner strategy. The constructor takes a placeholder vault and is
#      rewired to VAULT_USDC in step 4.
#   4. DefindexStrategy.set_vault(admin, VAULT_USDC).
#   5. Vault(USDC).register_strategy(admin, DEFINDEX_STRATEGY_USDC) — append.
#      Active strategy stays BlendStrategy USDC; rotation is a follow-up
#      admin op (vault.rebalance) and an operator decision.
#   6. Smoke reads: registry, active_strategy, strategy.current_value (0 until
#      vault deposits into it), pool_apy.
#   7. Append DEFINDEX_STRATEGY_USDC=... to scripts/deployed.testnet.env.
#
# Re-runnability:
#   register_strategy reverts with StrategyAlreadyRegistered. For a clean
#   re-wire, deploy a fresh DefindexStrategy and re-run — the old contract is
#   orphaned in the registry (the vault has no remove_strategy).
#
# Usage:
#   ./scripts/deploy-defindex-strategy.sh [IDENTITY]   # default IDENTITY=admin

set -euo pipefail

IDENTITY="${1:-admin}"
NETWORK="testnet"
STELLAR_CLI="${STELLAR_CLI:-$HOME/.cargo/bin/stellar}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/scripts/deployed.testnet.env"

# DeFindex's testnet Blend-USDC strategy contract.
# Source: paltalabs/defindex public/testnet.contracts.json.
# Verified live 2026-05-28 via:
#   stellar contract invoke --id <addr> -- asset
#   → returns CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU (Blend USDC SAC)
# Interface matches DeFindexStrategyTrait:
#   deposit(amount, from), withdraw(amount, from, to), balance(from),
#   harvest(from, data), asset()
DEFINDEX_REF_BLEND_USDC="${DEFINDEX_REF_BLEND_USDC:-CALLOM5I7XLQPPOPQMYAHUWW4N7O3JKT42KQ4ASEEVBXDJQNJOALFSUY}"

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
: "${VAULT_USDC:?VAULT_USDC not set in $ENV_FILE — main deploy must run first}"
: "${USDC_SAC:?USDC_SAC not set in $ENV_FILE}"
: "${ADMIN_ADDR:?ADMIN_ADDR not set in $ENV_FILE}"
: "${BLEND_STRATEGY_USDC:?BLEND_STRATEGY_USDC not set in $ENV_FILE}"

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
echo "→ vault-usdc         : $VAULT_USDC"
echo "→ active strategy    : $BLEND_STRATEGY_USDC (BlendStrategy USDC)"
echo "→ DeFindex ref strat : $DEFINDEX_REF_BLEND_USDC"
echo "→ USDC SAC           : $USDC_SAC"

# ── Step 1: Pre-flight — DeFindex strategy asset must match our USDC ──────
echo ""
echo "── Step 1: Verify DeFindex ref strategy asset matches USDC_SAC ──"
DEFINDEX_ASSET="$("$STELLAR_CLI" contract invoke \
  --id "$DEFINDEX_REF_BLEND_USDC" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  --send=no \
  -- \
  asset 2>/dev/null | tr -d '"')"
echo "  defindex.asset() = $DEFINDEX_ASSET"
if [[ "$DEFINDEX_ASSET" != "$USDC_SAC" ]]; then
  echo "ERROR: DeFindex ref strategy asset ($DEFINDEX_ASSET) != USDC_SAC ($USDC_SAC)." >&2
  echo "The adapter only works when both reference the same underlying SAC." >&2
  exit 1
fi
echo "  ✓ asset match"

# ── Step 2: Build (idempotent) ──────────────────────────────────────────
echo ""
echo "── Step 2: Build contracts ─────────────────────────────────────"
(cd "$ROOT" && "$STELLAR_CLI" contract build > /dev/null)
DEFINDEX_WASM="$ROOT/target/wasm32v1-none/release/baku_defindex_strategy.wasm"
[[ -f "$DEFINDEX_WASM" ]] || { echo "missing $DEFINDEX_WASM" >&2; exit 1; }
echo "  built: $(basename "$DEFINDEX_WASM") ($(wc -c < "$DEFINDEX_WASM") bytes)"

# ── Step 3: Deploy DefindexStrategy(USDC) ──────────────────────────────
echo ""
echo "── Step 3: Deploy DefindexStrategy(USDC) ──────────────────────"
PLACEHOLDER_VAULT="$ADMIN_ADDR" # rewired in step 4
DEFINDEX_STRATEGY_USDC="$("$STELLAR_CLI" contract deploy \
  --wasm "$DEFINDEX_WASM" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- \
  --admin "$ADMIN_ADDR" \
  --vault "$PLACEHOLDER_VAULT" \
  --asset "$USDC_SAC" \
  --defindex_strategy "$DEFINDEX_REF_BLEND_USDC" \
  --initial_apy_bps 500 \
  2>&1 | tee /dev/stderr | grep -oE 'C[A-Z0-9]{55}' | tail -1)"
echo "  → DefindexStrategy(USDC): $DEFINDEX_STRATEGY_USDC"
# Fail fast: if the deploy produced no contract ID, abort before set_vault /
# register_strategy run with an empty --id (which would otherwise fail in a
# confusing way mid-sequence or silently mis-target).
[[ -n "$DEFINDEX_STRATEGY_USDC" ]] || { echo "FATAL: empty contract ID after deploy"; exit 1; }

# ── Step 4: Rewire strategy.vault → VAULT_USDC ─────────────────────────
echo ""
echo "── Step 4: DefindexStrategy.set_vault(VAULT_USDC) ──────────────"
"$STELLAR_CLI" contract invoke \
  --id "$DEFINDEX_STRATEGY_USDC" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- \
  set_vault \
  --admin "$ADMIN_ADDR" \
  --new_vault "$VAULT_USDC"
echo "  ✓ DefindexStrategy.vault → $VAULT_USDC"

# ── Step 5: Register on vault-usdc ─────────────────────────────────────
echo ""
echo "── Step 5: Vault(USDC).register_strategy ───────────────────────"
"$STELLAR_CLI" contract invoke \
  --id "$VAULT_USDC" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- \
  register_strategy \
  --admin "$ADMIN_ADDR" \
  --strategy "$DEFINDEX_STRATEGY_USDC"
echo "  ✓ registered $DEFINDEX_STRATEGY_USDC"

# ── Step 6: Smoke reads ────────────────────────────────────────────────
echo ""
echo "── Step 6: Smoke reads ─────────────────────────────────────────"
echo -n "  vault.active_strategy()      = "
"$STELLAR_CLI" contract invoke --id "$VAULT_USDC" --source "$IDENTITY" --network "$NETWORK" --send=no -- active_strategy
echo -n "  vault.strategy_registry()    = "
"$STELLAR_CLI" contract invoke --id "$VAULT_USDC" --source "$IDENTITY" --network "$NETWORK" --send=no -- strategy_registry
echo -n "  defindex.current_value()     = "
"$STELLAR_CLI" contract invoke --id "$DEFINDEX_STRATEGY_USDC" --source "$IDENTITY" --network "$NETWORK" --send=no -- current_value
echo -n "  defindex.pool_apy()          = "
"$STELLAR_CLI" contract invoke --id "$DEFINDEX_STRATEGY_USDC" --source "$IDENTITY" --network "$NETWORK" --send=no -- pool_apy

# ── Step 7: Append to env file ─────────────────────────────────────────
if grep -q '^DEFINDEX_STRATEGY_USDC=' "$ENV_FILE"; then
  sed -i '' -e "s|^DEFINDEX_STRATEGY_USDC=.*|DEFINDEX_STRATEGY_USDC=$DEFINDEX_STRATEGY_USDC|" "$ENV_FILE"
else
  printf '\n# Appended by deploy-defindex-strategy.sh on %s\nDEFINDEX_STRATEGY_USDC=%s\nDEFINDEX_REF_BLEND_USDC=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$DEFINDEX_STRATEGY_USDC" \
    "$DEFINDEX_REF_BLEND_USDC" >> "$ENV_FILE"
fi

echo ""
echo "── Done. $ENV_FILE updated. ────────────────────────────────────"
echo "DEFINDEX_STRATEGY_USDC=$DEFINDEX_STRATEGY_USDC"
echo ""
echo "Next:"
echo "  - promote this address into api/src/addresses.ts (TESTNET.defindexStrategyUsdc)"
echo "    and crates/addresses/src/lib.rs (TESTNET.defindex_strategy_usdc)"
echo "  - to rotate vault-usdc from Blend → DeFindex (operator decision):"
echo "      stellar contract invoke --id $VAULT_USDC --source admin --network testnet \\"
echo "        -- rebalance --admin $ADMIN_ADDR --to_strategy $DEFINDEX_STRATEGY_USDC"
