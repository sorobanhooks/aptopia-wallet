#!/usr/bin/env bash
# Baku — Soroswap testnet live spike.
#
# Purpose: validate the Soroswap V0 Router/Pair/Factory contracts respond
# correctly BEFORE wiring SoroswapStrategy into vault-xlm. This is the
# Soroswap analogue of scripts/blend-usdc-spike.sh.
#
# Two phases:
#   --probe (default): read-only. Confirms factory liveness, pair existence
#     for (XLM, Circle-USDC), reads pair reserves / total_supply, simulates a
#     1-XLM swap quote via router_get_amount_out. Zero side effects, zero gas.
#   --swap-test: writes. Admin executes a tiny swap (0.01 XLM → Circle USDC)
#     through the router to verify the auth path (require_auth on caller →
#     SAC transfer sub-invocation) before the strategy attempts the same
#     pattern via its own contract address.
#
# Usage:
#   ./scripts/soroswap-spike.sh                  # read-only probe
#   ./scripts/soroswap-spike.sh --swap-test      # 0.01 XLM live swap
#   ./scripts/soroswap-spike.sh --swap-test admin  # specify identity
#
# Pre-flight:
#   - stellar-cli >= 25.2.0
#   - stellar identity (default: admin) exists, funded on testnet
#   - for --swap-test: admin holds >= 0.05 XLM (1 stroop is enough but we
#     give buffer for ledger fees + the trade itself). XLM comes from
#     friendbot (https://friendbot.stellar.org).

set -euo pipefail

MODE="probe"
IDENTITY="admin"
for arg in "$@"; do
  case "$arg" in
    --swap-test) MODE="swap-test" ;;
    --probe) MODE="probe" ;;
    *) IDENTITY="$arg" ;;
  esac
done

NETWORK="testnet"
STELLAR_CLI="${STELLAR_CLI:-$HOME/.cargo/bin/stellar}"

# Pinned from crates/addresses/src/lib.rs TESTNET and verified live on
# 2026-05-27 via stellar contract info interface.
SOROSWAP_FACTORY="CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY"
SOROSWAP_ROUTER="CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD"
XLM_SAC="CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
# Circle's testnet USDC SAC (issuer GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5).
# NOT the same as Blend's testnet USDC (which is what vault-usdc + the Blend
# pool use). See HANDOFF / 2026-05-27 design notes.
CIRCLE_USDC="CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"

if [[ ! -x "$STELLAR_CLI" ]]; then
  echo "stellar CLI not found at $STELLAR_CLI. Override with STELLAR_CLI=/path/to/stellar." >&2
  exit 1
fi

ADMIN_ADDR="$("$STELLAR_CLI" keys public-key "$IDENTITY")"
echo "→ Identity:        $IDENTITY ($ADMIN_ADDR)"
echo "→ Factory:         $SOROSWAP_FACTORY"
echo "→ Router:          $SOROSWAP_ROUTER"
echo "→ XLM SAC:         $XLM_SAC"
echo "→ Circle USDC SAC: $CIRCLE_USDC"
echo ""

echo "── Step 1: factory.all_pairs_length() ───────────────────────"
# Sanity check: factory is initialized and serving pairs. A 0 here means the
# factory address is wrong or the contract isn't initialized.
PAIRS_COUNT="$("$STELLAR_CLI" contract invoke \
  --id "$SOROSWAP_FACTORY" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  --send=no \
  -- \
  all_pairs_length)"
echo "  total pairs: $PAIRS_COUNT"

echo ""
echo "── Step 2: factory.pair_exists(XLM, Circle-USDC) ────────────"
EXISTS="$("$STELLAR_CLI" contract invoke \
  --id "$SOROSWAP_FACTORY" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  --send=no \
  -- \
  pair_exists \
  --token_a "$XLM_SAC" \
  --token_b "$CIRCLE_USDC")"
echo "  pair_exists: $EXISTS"
if [[ "$EXISTS" != "true" ]]; then
  echo "✗ No XLM/Circle-USDC pair on the Soroswap testnet factory. Aborting." >&2
  exit 1
fi

echo ""
echo "── Step 3: factory.get_pair() → pair address ────────────────"
PAIR="$("$STELLAR_CLI" contract invoke \
  --id "$SOROSWAP_FACTORY" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  --send=no \
  -- \
  get_pair \
  --token_a "$XLM_SAC" \
  --token_b "$CIRCLE_USDC" | tr -d '"')"
echo "  pair: $PAIR"

echo ""
echo "── Step 4: pair state ───────────────────────────────────────"
TOKEN_0="$("$STELLAR_CLI" contract invoke \
  --id "$PAIR" --source "$IDENTITY" --network "$NETWORK" --send=no \
  -- token_0 | tr -d '"')"
TOKEN_1="$("$STELLAR_CLI" contract invoke \
  --id "$PAIR" --source "$IDENTITY" --network "$NETWORK" --send=no \
  -- token_1 | tr -d '"')"
RESERVES="$("$STELLAR_CLI" contract invoke \
  --id "$PAIR" --source "$IDENTITY" --network "$NETWORK" --send=no \
  -- get_reserves)"
SUPPLY="$("$STELLAR_CLI" contract invoke \
  --id "$PAIR" --source "$IDENTITY" --network "$NETWORK" --send=no \
  -- total_supply)"
echo "  token_0:      $TOKEN_0"
echo "  token_1:      $TOKEN_1"
echo "  reserves:     $RESERVES   (in stroops, 7 decimals)"
echo "  total_supply: $SUPPLY"

# Identify which side is XLM so the quote step below uses the right reserve.
if [[ "$TOKEN_0" == "$XLM_SAC" ]]; then
  XLM_INDEX=0
elif [[ "$TOKEN_1" == "$XLM_SAC" ]]; then
  XLM_INDEX=1
else
  echo "✗ Neither token_0 nor token_1 is XLM. Pair config drift?" >&2
  exit 1
fi
echo "  (XLM is token_$XLM_INDEX in this pair)"

echo ""
echo "── Step 5: router.router_get_amount_out — quote 1 XLM → USDC ─"
# Use the actual reserves to ask the router what 1 XLM (10_000_000 stroops)
# would yield, with the 0.30% fee already applied. Matches what our
# strategy's quote_amount_out helper computes locally.
RESERVE_IN=$(echo "$RESERVES" | sed 's/\[//; s/\]//;' | awk -F',' "{print \$($XLM_INDEX + 1)}" | tr -d '"')
OTHER_INDEX=$((1 - XLM_INDEX))
RESERVE_OUT=$(echo "$RESERVES" | sed 's/\[//; s/\]//;' | awk -F',' "{print \$($OTHER_INDEX + 1)}" | tr -d '"')
QUOTE_OUT="$("$STELLAR_CLI" contract invoke \
  --id "$SOROSWAP_ROUTER" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  --send=no \
  -- \
  router_get_amount_out \
  --amount_in 10000000 \
  --reserve_in "$RESERVE_IN" \
  --reserve_out "$RESERVE_OUT")"
echo "  1 XLM → $QUOTE_OUT stroops of the paired token (post-0.30%-fee)"

echo ""
echo "── Step 6: router.get_factory() — sanity cross-check ────────"
# Router's bound factory MUST equal SOROSWAP_FACTORY. If it doesn't, the
# router and factory are misconfigured against each other and our strategy
# would silently route through a different factory.
ROUTER_FACTORY="$("$STELLAR_CLI" contract invoke \
  --id "$SOROSWAP_ROUTER" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  --send=no \
  -- \
  get_factory | tr -d '"')"
echo "  router.get_factory(): $ROUTER_FACTORY"
if [[ "$ROUTER_FACTORY" != "$SOROSWAP_FACTORY" ]]; then
  echo "✗ Router/factory mismatch. Refusing to proceed." >&2
  exit 1
fi

if [[ "$MODE" == "probe" ]]; then
  echo ""
  echo "✓ Probe complete. Pair is live, router resolves to the expected factory."
  echo "  Next: run with --swap-test (admin holds >= 0.05 XLM) to verify the"
  echo "  router auth path with a live 0.01 XLM swap."
  exit 0
fi

# ───────────────────────────────────────────────────────────────────────────
# --swap-test: do a tiny live swap to verify the auth flow.
# ───────────────────────────────────────────────────────────────────────────
echo ""
echo "── Step 7: live swap 0.01 XLM → Circle-USDC (admin signed) ──"
echo "  This swap runs against the real testnet pool. Slippage at this"
echo "  amount is essentially zero (way below the 0.30% protocol fee floor),"
echo "  so we accept anything > 0 as success."

AMOUNT_IN=100000   # 0.01 XLM
MIN_OUT=1          # floor: any non-zero output

# Deadline: current ledger timestamp + 600s. The stellar CLI doesn't have a
# helper for this so we compute it from the system clock (close enough for a
# spike; for production scripts we'd query env.ledger().timestamp()).
DEADLINE=$(( $(date +%s) + 600 ))

# The router's `swap_exact_tokens_for_tokens(amount_in, amount_out_min, path,
# to, deadline)` needs `path` as a Vec<Address>. The stellar CLI accepts JSON
# array syntax for vector args.
PATH_JSON="[\"$XLM_SAC\",\"$CIRCLE_USDC\"]"

# Pre-balance. The SAC's balance() returns a quoted i128 JSON string;
# strip quotes so we can do arithmetic on it.
USDC_BAL_PRE="$("$STELLAR_CLI" contract invoke \
  --id "$CIRCLE_USDC" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  --send=no \
  -- \
  balance \
  --id "$ADMIN_ADDR" | tr -d '"')"
echo "  Circle USDC balance (pre):  $USDC_BAL_PRE"

# Execute the swap. Router will pull 0.01 XLM from admin (via SAC transfer)
# and deliver Circle USDC.
"$STELLAR_CLI" contract invoke \
  --id "$SOROSWAP_ROUTER" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- \
  swap_exact_tokens_for_tokens \
  --amount_in "$AMOUNT_IN" \
  --amount_out_min "$MIN_OUT" \
  --path "$PATH_JSON" \
  --to "$ADMIN_ADDR" \
  --deadline "$DEADLINE"

echo ""
echo "── Step 8: post-swap balances ───────────────────────────────"
USDC_BAL_POST="$("$STELLAR_CLI" contract invoke \
  --id "$CIRCLE_USDC" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  --send=no \
  -- \
  balance \
  --id "$ADMIN_ADDR" | tr -d '"')"
echo "  Circle USDC balance (post): $USDC_BAL_POST"
DELTA=$((USDC_BAL_POST - USDC_BAL_PRE))
echo "  Δ Circle USDC: +$DELTA stroops"

if (( DELTA <= 0 )); then
  echo "✗ Swap completed without an error but no Circle USDC was received." >&2
  exit 1
fi

echo ""
echo "✓ Swap-test complete. Router auth path works for this identity."
echo "  Strategy can now invoke the router the same way (deposit/withdraw legs)."
