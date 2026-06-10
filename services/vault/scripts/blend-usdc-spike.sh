#!/usr/bin/env bash
# Baku — Blend USDC live spike (T12 from eng-review tasks).
#
# Purpose: validate the Blend V2 testnet SDK shape against the actual deployed
# pool BEFORE wiring BlendStrategy into vault-usdc. Failure here means our
# contract assumptions (reserve_token_id encoding, b_rate scalar, submit
# request shape) are wrong and the strategy must be patched.
#
# Two phases:
#   --probe (default): read-only. Calls pool.get_reserve(USDC) and
#     pool.get_positions(admin). Validates contract responds, returns expected
#     shape (b_rate, config.index). Zero side effects, zero gas.
#   --supply: writes. Calls pool.submit(Supply, 1 stroop USDC) on behalf of
#     admin. Requires admin to hold >= 1 stroop USDC and to have given USDC
#     SAC an allowance for the pool to pull from (the SAC's underlying
#     transfer auth is done via require_auth so allowance is implicit on
#     classic SACs).
#
# Usage:
#   ./scripts/blend-usdc-spike.sh                 # read-only probe
#   ./scripts/blend-usdc-spike.sh --supply        # write 1 stroop
#   ./scripts/blend-usdc-spike.sh --supply admin  # specify identity
#
# Pre-flight:
#   - stellar-cli >= 25.2.0
#   - stellar identity (default: admin) exists and is funded on testnet
#   - for --supply: admin holds >= 1 stroop Blend USDC
#       (Blend's testnet USDC, not Circle's. Mint via the token's admin or
#       contact #blend on Stellar Discord for a testnet faucet drip.)

set -euo pipefail

MODE="probe"
IDENTITY="admin"
for arg in "$@"; do
  case "$arg" in
    --supply) MODE="supply" ;;
    --probe) MODE="probe" ;;
    *) IDENTITY="$arg" ;;
  esac
done

NETWORK="testnet"
STELLAR_CLI="${STELLAR_CLI:-$HOME/.cargo/bin/stellar}"

# Pinned from crates/addresses/src/lib.rs TESTNET (Blend V2).
# Source: github.com/blend-capital/blend-utils testnet.contracts.json
BLEND_POOL="CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF"
BLEND_USDC="CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU"

if [[ ! -x "$STELLAR_CLI" ]]; then
  echo "stellar CLI not found at $STELLAR_CLI. Override with STELLAR_CLI=/path/to/stellar." >&2
  exit 1
fi

ADMIN_ADDR="$("$STELLAR_CLI" keys public-key "$IDENTITY")"
echo "→ Identity: $IDENTITY ($ADMIN_ADDR)"
echo "→ Pool:     $BLEND_POOL"
echo "→ USDC:     $BLEND_USDC"
echo ""

echo "── Step 1: pool.get_reserve(USDC) ───────────────────────────"
# Expected response shape: { config: { index: u32, ... }, data: { b_rate: i128, ... }, ... }
# Failure here means the pool either doesn't recognize USDC as a reserve OR
# the SDK's Reserve struct has drifted from what's deployed.
"$STELLAR_CLI" contract invoke \
  --id "$BLEND_POOL" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  --send=no \
  -- \
  get_reserve \
  --asset "$BLEND_USDC"

echo ""
echo "── Step 2: pool.get_positions(admin) ────────────────────────"
# Expected: Positions { liabilities: Map<u32,i128>, collateral: Map<u32,i128>, supply: Map<u32,i128> }
# A new admin returns three empty maps. supply.get(index_for_USDC) is what
# BlendStrategy::current_value() reads after a deposit.
"$STELLAR_CLI" contract invoke \
  --id "$BLEND_POOL" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  --send=no \
  -- \
  get_positions \
  --address "$ADMIN_ADDR"

echo ""
echo "── Step 3: USDC balance for admin ───────────────────────────"
USDC_BAL="$("$STELLAR_CLI" contract invoke \
  --id "$BLEND_USDC" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  --send=no \
  -- \
  balance \
  --id "$ADMIN_ADDR" 2>/dev/null | tr -d '"' || echo 0)"
echo "  admin USDC balance: $USDC_BAL stroops"

if [[ "$MODE" == "probe" ]]; then
  echo ""
  echo "✓ Probe complete. Re-run with --supply to actually call pool.submit(Supply, 1)."
  exit 0
fi

# ----- Supply path ----------------------------------------------------------

if [[ -z "$USDC_BAL" ]] || [[ "$USDC_BAL" -lt 1 ]]; then
  echo ""
  echo "✗ Admin USDC balance ($USDC_BAL) is insufficient. Mint or fund 1+ stroops" >&2
  echo "  of Blend's testnet USDC ($BLEND_USDC) before --supply." >&2
  exit 1
fi

echo ""
echo "── Step 4: pool.submit(Supply, 1 stroop USDC) ───────────────"
# Request shape from blend-contract-sdk pool::Request:
#   { address: Address, amount: i128, request_type: u32 }
# REQUEST_SUPPLY = 0 (matches BlendStrategy const).
# from/spender/to all = admin for a direct self-supply.
"$STELLAR_CLI" contract invoke \
  --id "$BLEND_POOL" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- \
  submit \
  --from "$ADMIN_ADDR" \
  --spender "$ADMIN_ADDR" \
  --to "$ADMIN_ADDR" \
  --requests "[{\"address\":\"$BLEND_USDC\",\"amount\":\"1\",\"request_type\":0}]"

echo ""
echo "── Step 5: re-read positions to confirm supply landed ───────"
"$STELLAR_CLI" contract invoke \
  --id "$BLEND_POOL" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  --send=no \
  -- \
  get_positions \
  --address "$ADMIN_ADDR"

echo ""
echo "✓ Spike complete. supply.get(<usdc_index>) should now be > 0."
echo "  This validates: (a) submit shape, (b) reserve discovery via asset address,"
echo "  (c) supply position keyed by reserve index. Safe to wire BlendStrategy."
