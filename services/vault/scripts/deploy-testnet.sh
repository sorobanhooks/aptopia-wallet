#!/usr/bin/env bash
# Baku — testnet deploy script.
#
# Deploys the minimum useful surface for the API to be testable end-to-end:
#   XLM track:
#     1. MockStrategy (XLM) — vault dispatches here in V0.
#     2. BakuVault (XLM)    — share token "stXLM".
#     3. Wire strategy → vault via MockStrategy::set_vault.
#   USDC track (skipped unless DEPLOY_USDC=1):
#     4. BlendStrategy (USDC) — supplies into Blend V2 testnet pool.
#     5. BakuVault (USDC)     — share token "stUSDC".
#     6. Wire BlendStrategy → vault via set_vault.
#
# The USDC track is gated behind DEPLOY_USDC=1 because the Blend SDK shape
# must be validated against the live testnet pool first — run
# `scripts/blend-usdc-spike.sh --probe` (and ideally `--supply`) before
# setting the env var.
#
# This script does NOT rewrite crates/addresses/src/lib.rs. Deployed
# addresses go to scripts/deployed.testnet.env so the API + manual
# stellar invoke calls can source them. Promotion into addresses.rs is
# a manual edit (auditable diff).
#
# No --features demo flag is used. Testnet and mainnet build the same
# WASM artifacts; the demo "visible yield" path is provided by the
# always-on inject_yield admin method on crates/mock-strategy (which the
# XLM vault wires to in V0). crates/blend-strategy has no inject_yield —
# Blend interest must come from real pool activity. See README.md
# "Deploy to testnet" section.
#
# Pre-flight:
#   - stellar-cli >= 25.2.0 (verified via $STELLAR_CLI -V)
#   - stellar keys exists for $IDENTITY (default: admin), funded on testnet
#   - cargo + wasm32v1-none target installed
#
# Usage:
#   ./scripts/deploy-testnet.sh [IDENTITY]
# Default IDENTITY is "admin".

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

cli_version="$("$STELLAR_CLI" -V | head -1 | awk '{print $2}')"
# crude semver check: must be 25.2.0+ for spec-shaking-v2
maj="${cli_version%%.*}"
min_full="${cli_version#*.}"
min="${min_full%%.*}"
if (( maj < 25 )) || (( maj == 25 && min < 2 )); then
  echo "stellar CLI $cli_version too old (need >= 25.2.0). Upgrade with 'cargo install --locked stellar-cli'." >&2
  exit 1
fi

echo "→ Using $STELLAR_CLI ($cli_version), identity=$IDENTITY, network=$NETWORK"

ADMIN_ADDR="$("$STELLAR_CLI" keys public-key "$IDENTITY")"
echo "→ Admin address: $ADMIN_ADDR"

XLM_SAC="$("$STELLAR_CLI" contract id asset --asset native --network "$NETWORK")"
echo "→ Native XLM SAC: $XLM_SAC"

# Pinned from crates/addresses/src/lib.rs TESTNET. Only consumed when
# DEPLOY_USDC=1; left as constants so the XLM track has no surprise deps.
BLEND_POOL_TESTNET="CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF"
BLEND_USDC_TESTNET="CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU"
BLND_TOKEN_TESTNET="CB22KRA3YZVCNCQI64JQ5WE7UY2VAV7WFLK6A2JN3HEX56T2EDAFO7QF"
DEPLOY_USDC="${DEPLOY_USDC:-0}"

echo ""
echo "── Step 1: Build contracts ──────────────────────────────────"
(cd "$ROOT" && "$STELLAR_CLI" contract build > /dev/null)
MOCK_WASM="$ROOT/target/wasm32v1-none/release/baku_mock_strategy.wasm"
VAULT_WASM="$ROOT/target/wasm32v1-none/release/baku_vault.wasm"
BLEND_WASM="$ROOT/target/wasm32v1-none/release/baku_blend_strategy.wasm"
for w in "$MOCK_WASM" "$VAULT_WASM"; do
  [[ -f "$w" ]] || { echo "missing $w" >&2; exit 1; }
done
if [[ "$DEPLOY_USDC" == "1" ]]; then
  [[ -f "$BLEND_WASM" ]] || { echo "missing $BLEND_WASM (DEPLOY_USDC=1 requires baku-blend-strategy)" >&2; exit 1; }
fi
echo "  built: $(basename "$MOCK_WASM"), $(basename "$VAULT_WASM")$([[ "$DEPLOY_USDC" == "1" ]] && echo ", $(basename "$BLEND_WASM")")"

echo ""
echo "── Step 2: Deploy MockStrategy (XLM) ────────────────────────"
# Use a temporary placeholder vault address; we'll rewrite after vault deploys.
PLACEHOLDER_VAULT="$ADMIN_ADDR"
MOCK_STRATEGY_XLM="$("$STELLAR_CLI" contract deploy \
  --wasm "$MOCK_WASM" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- \
  --admin "$ADMIN_ADDR" \
  --vault "$PLACEHOLDER_VAULT" \
  --asset "$XLM_SAC" \
  --initial_apy_bps 500 \
  2>&1 | tee /dev/stderr | grep -oE 'C[A-Z0-9]{55}' | tail -1)"
echo "  → MockStrategy (XLM): $MOCK_STRATEGY_XLM"

echo ""
echo "── Step 3: Deploy BakuVault (XLM) ───────────────────────────"
VAULT_XLM="$("$STELLAR_CLI" contract deploy \
  --wasm "$VAULT_WASM" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- \
  --admin "$ADMIN_ADDR" \
  --asset "$XLM_SAC" \
  --initial_strategy "$MOCK_STRATEGY_XLM" \
  --name "Baku Staked XLM" \
  --symbol "stXLM" \
  2>&1 | tee /dev/stderr | grep -oE 'C[A-Z0-9]{55}' | tail -1)"
echo "  → BakuVault (XLM): $VAULT_XLM"

echo ""
echo "── Step 4: Wire strategy → vault (MockStrategy.set_vault) ───"
"$STELLAR_CLI" contract invoke \
  --id "$MOCK_STRATEGY_XLM" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- \
  set_vault \
  --admin "$ADMIN_ADDR" \
  --new_vault "$VAULT_XLM"
echo "  ✓ MockStrategy(XLM).vault → $VAULT_XLM"

echo ""
echo "── Step 5: Smoke read (vault.total_assets) ──────────────────"
"$STELLAR_CLI" contract invoke \
  --id "$VAULT_XLM" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- \
  total_assets

if [[ "$DEPLOY_USDC" == "1" ]]; then
  echo ""
  echo "── Step 6: Deploy BlendStrategy (USDC) ──────────────────────"
  PLACEHOLDER_VAULT_USDC="$ADMIN_ADDR"
  BLEND_STRATEGY_USDC="$("$STELLAR_CLI" contract deploy \
    --wasm "$BLEND_WASM" \
    --source "$IDENTITY" \
    --network "$NETWORK" \
    -- \
    --admin "$ADMIN_ADDR" \
    --vault "$PLACEHOLDER_VAULT_USDC" \
    --asset "$BLEND_USDC_TESTNET" \
    --blend_pool "$BLEND_POOL_TESTNET" \
    --blnd_token "$BLND_TOKEN_TESTNET" \
    --initial_apy_bps 500 \
    2>&1 | tee /dev/stderr | grep -oE 'C[A-Z0-9]{55}' | tail -1)"
  echo "  → BlendStrategy (USDC): $BLEND_STRATEGY_USDC"

  echo ""
  echo "── Step 7: Deploy BakuVault (USDC) ──────────────────────────"
  VAULT_USDC="$("$STELLAR_CLI" contract deploy \
    --wasm "$VAULT_WASM" \
    --source "$IDENTITY" \
    --network "$NETWORK" \
    -- \
    --admin "$ADMIN_ADDR" \
    --asset "$BLEND_USDC_TESTNET" \
    --initial_strategy "$BLEND_STRATEGY_USDC" \
    --name "Baku Staked USDC" \
    --symbol "stUSDC" \
    2>&1 | tee /dev/stderr | grep -oE 'C[A-Z0-9]{55}' | tail -1)"
  echo "  → BakuVault (USDC): $VAULT_USDC"

  echo ""
  echo "── Step 8: Wire BlendStrategy → vault-usdc ──────────────────"
  "$STELLAR_CLI" contract invoke \
    --id "$BLEND_STRATEGY_USDC" \
    --source "$IDENTITY" \
    --network "$NETWORK" \
    -- \
    set_vault \
    --admin "$ADMIN_ADDR" \
    --new_vault "$VAULT_USDC"
  echo "  ✓ BlendStrategy(USDC).vault → $VAULT_USDC"

  echo ""
  echo "── Step 9: Smoke read (vault-usdc.total_assets) ─────────────"
  "$STELLAR_CLI" contract invoke \
    --id "$VAULT_USDC" \
    --source "$IDENTITY" \
    --network "$NETWORK" \
    -- \
    total_assets
fi

echo ""
echo "── Done. Writing $ENV_FILE ──────────────────────────────────"
cat > "$ENV_FILE" <<EOF
# Auto-written by scripts/deploy-testnet.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
# Source from the API: \`source scripts/deployed.testnet.env\`
NETWORK=$NETWORK
ADMIN_ADDR=$ADMIN_ADDR
XLM_SAC=$XLM_SAC
MOCK_STRATEGY_XLM=$MOCK_STRATEGY_XLM
VAULT_XLM=$VAULT_XLM
EOF

if [[ "$DEPLOY_USDC" == "1" ]]; then
  cat >> "$ENV_FILE" <<EOF
USDC_SAC=$BLEND_USDC_TESTNET
BLEND_POOL=$BLEND_POOL_TESTNET
BLND_TOKEN=$BLND_TOKEN_TESTNET
BLEND_STRATEGY_USDC=$BLEND_STRATEGY_USDC
VAULT_USDC=$VAULT_USDC
EOF
fi

cat "$ENV_FILE"
echo ""
echo "✓ Deploy complete. Next: copy these into api/src/addresses.ts and start the API."
