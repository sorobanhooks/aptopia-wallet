#!/usr/bin/env bash
# M1 Auth-Digest Tracer (P2/P4) — deploy ONE OpenZeppelin stellar-accounts Smart
# Account on Stellar testnet with TWO POLICY-LESS, CallContract-scoped context
# rules (one for VAULT_XLM, one for the nested XLM_SAC transfer), BOTH bound to
# the SAME External-Ed25519 agent signer, and write its identifiers to the
# gitignored scripts/.sa-tracer.env.
#
# WHY TWO RULES (no Master/Default rule — that would break the scoped-agent
# thesis): a real `vault.deposit(SA, assets)` makes the SA authorize TWO nested
# auth contexts, not one. vault.deposit does `depositor.require_auth()`
# (context = deposit@VAULT_XLM) and then `token.transfer(depositor -> strategy)`,
# whose SAC does `from.require_auth()` on the SA (nested context =
# transfer@XLM_SAC). OZ do_check_auth validates EVERY context against an
# installed rule before any signature is checked; with only the VAULT_XLM rule
# the nested SAC transfer context is unmatched and validation reverts
# UnvalidatedContext(3002). A second rule scoped to CallContract(XLM_SAC) covers
# that nested transfer context.
#
# WHAT THIS DEPLOYS (no Master/multi-signer, no policies — TWO scoped rules):
#   1. sa-ed25519-verifier  — a thin deployable wrapper exposing OZ's audited
#        stellar_accounts::verifiers::ed25519 building blocks (verify /
#        canonicalize_key / batch_canonicalize_key). NOT custom crypto. One
#        verifier serves any number of (verifier, pubkey) external signers, so
#        if ED25519_VERIFIER is already set in the env we REUSE it.
#   2. sa-account           — the deployable OZ Smart Account wrapper. Its
#        __check_auth delegates verbatim to OZ do_check_auth (the rule-bound
#        auth_digest = sha256(raw32(payload) || context_rule_ids.to_xdr())).
#        Its __constructor installs TWO rules with the SAME signer:
#           rule 0 (agent_xlm_vault): CallContract(VAULT_XLM), 0 policies
#           rule 1 (agent_xlm_sac)  : CallContract(XLM_SAC),   0 policies
#           signer (both)           : External(ed25519_verifier, agent_pubkey)
#
# AGENT KEY: a Stellar G/S keypair IS a raw Ed25519 keypair. The G-address
# strkey decodes to the 32 raw pubkey bytes (the External signer key_data); the
# S-secret seed is what the off-chain agent (P4) uses to Ed25519-sign the
# auth_digest. (Verified: seed→pubkey derivation matches the G-address.)
#
# TOOLCHAIN: soroban-sdk 25.3.1 contracts need stellar CLI >= 25.2. The repo's
# legacy default ($HOME/.cargo/bin/stellar) is 23.1.4 and is TOO OLD; this
# script defaults STELLAR_CLI to whatever `stellar` resolves to on PATH (the
# Homebrew build, 26.1.0) and hard-fails if it is < 25.2.
#
# Usage:
#   ./scripts/deploy-smart-account-tracer.sh [IDENTITY]   # default IDENTITY=admin

set -euo pipefail

IDENTITY="${1:-admin}"
NETWORK="testnet"
# Default to PATH `stellar` (Homebrew 26.1.0). DO NOT default to
# $HOME/.cargo/bin/stellar — that is the stale 23.1.4 build.
STELLAR_CLI="${STELLAR_CLI:-stellar}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_ENV="$ROOT/scripts/deployed.testnet.env"
OUT_ENV="$ROOT/scripts/.sa-tracer.env"

SA_CRATE="$ROOT/crates/sa-account"
VERIFIER_CRATE="$ROOT/crates/sa-account/verifier"
SA_WASM="$SA_CRATE/target/wasm32v1-none/release/sa_account.wasm"
VERIFIER_WASM="$VERIFIER_CRATE/target/wasm32v1-none/release/sa_ed25519_verifier.wasm"

# ── Preflight: CLI presence + version gate (>= 25.2) ────────────────────────
if ! command -v "$STELLAR_CLI" >/dev/null 2>&1; then
  echo "stellar CLI not found ($STELLAR_CLI). Install via 'brew install stellar-cli' (>= 25.2)." >&2
  exit 1
fi
CLI_VERSION="$("$STELLAR_CLI" -V | head -1 | awk '{print $2}')"
maj="${CLI_VERSION%%.*}"
min_full="${CLI_VERSION#*.}"
min="${min_full%%.*}"
if (( maj < 25 )) || (( maj == 25 && min < 2 )); then
  echo "stellar CLI $CLI_VERSION too old (need >= 25.2.0 for soroban-sdk 25.3.1)." >&2
  echo "  Fix: brew upgrade stellar-cli   (or cargo install --locked stellar-cli@25.x)" >&2
  exit 1
fi

# ── Source on-chain address book (for VAULT_XLM, ADMIN_ADDR) ────────────────
if [[ ! -f "$SRC_ENV" ]]; then
  echo "$SRC_ENV missing." >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$SRC_ENV"
# Canonical VAULT_XLM v2 — the scope rule 0 authorizes calls to.
VAULT_XLM="${VAULT_XLM:?VAULT_XLM not set in $SRC_ENV}"
# XLM Stellar Asset Contract — the scope rule 1 authorizes calls to (the nested
# transfer context from vault.deposit's token.transfer(SA -> strategy)).
XLM_SAC="${XLM_SAC:?XLM_SAC not set in $SRC_ENV}"
ADMIN_ADDR="${ADMIN_ADDR:?ADMIN_ADDR not set in $SRC_ENV}"

# Reuse an existing verifier if one is already recorded (idempotent / shared).
EXISTING_VERIFIER=""
if [[ -f "$OUT_ENV" ]]; then
  # shellcheck disable=SC1090
  EXISTING_VERIFIER="$(grep -E '^ED25519_VERIFIER=' "$OUT_ENV" 2>/dev/null | tail -1 | cut -d= -f2 || true)"
fi

echo "→ stellar CLI        : $CLI_VERSION  ($STELLAR_CLI)"
echo "→ identity / network : $IDENTITY / $NETWORK"
echo "→ admin (deployer)   : $ADMIN_ADDR"
echo "→ VAULT_XLM (rule 0) : $VAULT_XLM"
echo "→ XLM_SAC   (rule 1) : $XLM_SAC"

# Extract a C... contract id from a deploy invocation's combined output.
extract_cid() { grep -oE 'C[A-Z2-7]{55}' | tail -1; }
# Extract the CONTRACT-CREATION tx hash from the CLI logs. A `contract deploy`
# emits two txs: (1) WASM upload, (2) create-contract WITH the __constructor
# (this is the tx that installs BOTH rules). The CLI prints
# `Signing transaction: <hash>` for each; the LAST one is the create tx, so we
# take the final signing-transaction hash. Fall back to the last bare 64-hex.
extract_txhash() {
  local out; out="$(cat)"
  local h
  h="$(printf '%s' "$out" | grep -iE 'Signing transaction:' | grep -oiE '[0-9a-f]{64}' | tail -1)"
  [[ -n "$h" ]] || h="$(printf '%s' "$out" | grep -oiE '[0-9a-f]{64}' | tail -1)"
  printf '%s' "$h"
}

# ── Step 1: Build both contract crates (self-contained, own target dirs) ────
echo ""
echo "── Step 1: Build SA + verifier WASM ────────────────────────────"
( cd "$VERIFIER_CRATE" && "$STELLAR_CLI" contract build >/dev/null )
( cd "$SA_CRATE"       && "$STELLAR_CLI" contract build >/dev/null )
[[ -f "$VERIFIER_WASM" ]] || { echo "missing $VERIFIER_WASM" >&2; exit 1; }
[[ -f "$SA_WASM" ]]       || { echo "missing $SA_WASM" >&2; exit 1; }
echo "  built: sa_ed25519_verifier.wasm, sa_account.wasm"

# ── Step 2: Ed25519 verifier (reuse or deploy one instance) ─────────────────
echo ""
echo "── Step 2: Ed25519 verifier ────────────────────────────────────"
if [[ -n "$EXISTING_VERIFIER" ]]; then
  ED25519_VERIFIER="$EXISTING_VERIFIER"
  echo "  reusing existing verifier: $ED25519_VERIFIER"
else
  VERIFIER_OUT="$("$STELLAR_CLI" contract deploy \
    --wasm "$VERIFIER_WASM" \
    --source "$IDENTITY" \
    --network "$NETWORK" 2>&1 | tee /dev/stderr)"
  ED25519_VERIFIER="$(printf '%s' "$VERIFIER_OUT" | extract_cid)"
  [[ -n "$ED25519_VERIFIER" ]] || { echo "failed to parse verifier contract id" >&2; exit 1; }
  echo "  → ED25519_VERIFIER: $ED25519_VERIFIER"
fi

# ── Step 3: Throwaway agent Ed25519 keypair ─────────────────────────────────
echo ""
echo "── Step 3: Generate throwaway agent Ed25519 keypair ────────────"
AGENT_ALIAS="sa_tracer_agent_$$"
"$STELLAR_CLI" keys generate "$AGENT_ALIAS" --network "$NETWORK" >/dev/null 2>&1
AGENT_PUBKEY_G="$("$STELLAR_CLI" keys public-key "$AGENT_ALIAS")"
AGENT_SECRET="$("$STELLAR_CLI" keys secret "$AGENT_ALIAS")"
# Remove the local identity alias — the secret lives only in .sa-tracer.env.
rm -f "$HOME/.config/stellar/identity/$AGENT_ALIAS.toml" 2>/dev/null || true

# Decode the G-address strkey to its 32 raw Ed25519 pubkey bytes (hex). This is
# the External signer key_data the SA verifier checks the Ed25519 sig against.
AGENT_PUBKEY_HEX="$(python3 - "$AGENT_PUBKEY_G" <<'PY'
import sys, base64
g = sys.argv[1]
pad = '=' * ((8 - len(g) % 8) % 8)
raw = base64.b32decode(g + pad)
print(raw[1:33].hex())  # [1 version byte][32 key][2 crc]
PY
)"
[[ ${#AGENT_PUBKEY_HEX} -eq 64 ]] || { echo "agent pubkey hex wrong length: $AGENT_PUBKEY_HEX" >&2; exit 1; }
echo "  → AGENT_PUBKEY (G): $AGENT_PUBKEY_G"
echo "  → AGENT_PUBKEY hex: $AGENT_PUBKEY_HEX"

# ── Step 4: Deploy the Smart Account (constructor installs BOTH rules) ──────
echo ""
echo "── Step 4: Deploy Smart Account + install rules 0 & 1 ──────────"
SA_OUT="$("$STELLAR_CLI" contract deploy \
  --wasm "$SA_WASM" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- \
  --ed25519_verifier "$ED25519_VERIFIER" \
  --agent_pubkey "$AGENT_PUBKEY_HEX" \
  --vault_xlm "$VAULT_XLM" \
  --xlm_sac "$XLM_SAC" \
  2>&1 | tee /dev/stderr)"
SA_ADDRESS="$(printf '%s' "$SA_OUT" | extract_cid)"
DEPLOY_TX_HASH="$(printf '%s' "$SA_OUT" | extract_txhash)"
[[ -n "$SA_ADDRESS" ]] || { echo "failed to parse SA contract id" >&2; exit 1; }
echo "  → SA_ADDRESS    : $SA_ADDRESS"
echo "  → DEPLOY_TX_HASH: ${DEPLOY_TX_HASH:-<unparsed>}"

# Constructor installs rules in order: rule 0 = VAULT_XLM, rule 1 = XLM_SAC.
RULE_VAULT_ID=0
RULE_SAC_ID=1
# Back-compat alias (RULE_A_ID == the VAULT_XLM rule == id 0).
RULE_A_ID="$RULE_VAULT_ID"

# ── Step 5: Read-back — print BOTH rules from on-chain state ────────────────
echo ""
echo "── Step 5: Read-back rules 0 & 1 (on-chain) ────────────────────"
RULE_COUNT="$("$STELLAR_CLI" contract invoke \
  --id "$SA_ADDRESS" --source "$IDENTITY" --network "$NETWORK" \
  -- get_context_rules_count 2>/dev/null)"
echo "  context rules count: $RULE_COUNT"

echo "  --- get_context_rule(id=$RULE_VAULT_ID) [VAULT] ---"
RULE_VAULT_JSON="$("$STELLAR_CLI" contract invoke \
  --id "$SA_ADDRESS" --source "$IDENTITY" --network "$NETWORK" \
  -- get_context_rule --context_rule_id "$RULE_VAULT_ID" 2>/dev/null)"
echo "$RULE_VAULT_JSON"

echo "  --- get_context_rule(id=$RULE_SAC_ID) [SAC] ---"
RULE_SAC_JSON="$("$STELLAR_CLI" contract invoke \
  --id "$SA_ADDRESS" --source "$IDENTITY" --network "$NETWORK" \
  -- get_context_rule --context_rule_id "$RULE_SAC_ID" 2>/dev/null)"
echo "$RULE_SAC_JSON"

# Self-verify a single rule's JSON against (scope, signer, key, zero policies).
# Args: <label> <json> <expected_scope_contract_id>
verify_rule() {
  local label="$1" json="$2" scope="$3"
  printf '%s' "$json" | grep -q "$scope"            && echo "  ✓ [$label] scope = CallContract($scope)" || { echo "  ✗ [$label] scope $scope not in rule"; ok=0; }
  printf '%s' "$json" | grep -qi 'External'          && echo "  ✓ [$label] signer = Signer::External (ed25519)" || { echo "  ✗ [$label] External signer not found"; ok=0; }
  printf '%s' "$json" | grep -q "$ED25519_VERIFIER"  && echo "  ✓ [$label] External verifier = $ED25519_VERIFIER" || { echo "  ✗ [$label] verifier address not in rule"; ok=0; }
  printf '%s' "$json" | grep -q "$AGENT_PUBKEY_HEX"  && echo "  ✓ [$label] External key_data = agent pubkey" || { echo "  ✗ [$label] agent pubkey not in rule"; ok=0; }
  if printf '%s' "$json" | tr -d ' \n' | grep -qE '"policies":\[\]'; then
    echo "  ✓ [$label] policies = [] (ZERO policies — policy-less)"
  else
    echo "  ✗ [$label] policies is NOT empty"; ok=0
  fi
}

echo ""
echo "── Self-verification of both rules ─────────────────────────────"
ok=1
verify_rule "rule0/VAULT" "$RULE_VAULT_JSON" "$VAULT_XLM"
verify_rule "rule1/SAC"   "$RULE_SAC_JSON"   "$XLM_SAC"
# Guard against cross-wiring: VAULT rule must NOT reference the SAC and vice
# versa (catches a swapped or duplicated scope).
printf '%s' "$RULE_VAULT_JSON" | grep -q "$XLM_SAC"   && { echo "  ✗ rule0 unexpectedly references XLM_SAC"; ok=0; } || echo "  ✓ rule0 does not reference XLM_SAC"
printf '%s' "$RULE_SAC_JSON"   | grep -q "$VAULT_XLM" && { echo "  ✗ rule1 unexpectedly references VAULT_XLM"; ok=0; } || echo "  ✓ rule1 does not reference VAULT_XLM"
if [[ "$RULE_COUNT" == "2" ]]; then
  echo "  ✓ exactly TWO context rules (no Default/master rule)"
else
  echo "  ✗ expected exactly 2 context rules, got: $RULE_COUNT"; ok=0
fi

# ── Step 6: Write the gitignored env file (holds the agent SECRET) ──────────
echo ""
echo "── Step 6: Write $OUT_ENV (gitignored) ─────────────────────────"
umask 077
cat > "$OUT_ENV" <<EOF
# Auto-written by scripts/deploy-smart-account-tracer.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
# M1 Auth-Digest Tracer (P2/P4) — Stellar testnet ("Test SDF Network ; September 2015").
#
# SECURITY: this file holds AGENT_SECRET (a throwaway Ed25519 secret seed).
# It is gitignored (scripts/.sa-tracer.env). Do NOT commit.
#
# TWO-RULE design (no Default/master rule). A real vault.deposit(SA, assets)
# authorizes both deposit@VAULT_XLM and the nested transfer@XLM_SAC, so the SA
# needs a scoped rule for each context (otherwise OZ do_check_auth reverts
# UnvalidatedContext(3002) on the unmatched SAC transfer context).
#   rule RULE_VAULT_ID (=0, agent_xlm_vault): CallContract(VAULT_XLM), 0 policies
#   rule RULE_SAC_ID   (=1, agent_xlm_sac)  : CallContract(XLM_SAC),   0 policies
#   signer (both)                           : External(ED25519_VERIFIER, AGENT_PUBKEY)
# auth_digest = SHA-256( raw32(signature_payload) || context_rule_ids.to_xdr() ).
NETWORK=testnet
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
STELLAR_CLI_VERSION=$CLI_VERSION

SA_ADDRESS=$SA_ADDRESS
DEPLOY_TX_HASH=${DEPLOY_TX_HASH:-}
ED25519_VERIFIER=$ED25519_VERIFIER
RULE_VAULT_ID=$RULE_VAULT_ID
RULE_SAC_ID=$RULE_SAC_ID
# Back-compat alias: RULE_A_ID == the VAULT_XLM rule == id 0.
RULE_A_ID=$RULE_A_ID
VAULT_XLM=$VAULT_XLM
XLM_SAC=$XLM_SAC

# Throwaway agent Ed25519 keypair. AGENT_PUBKEY_HEX = the 32 raw pubkey bytes
# used as the External signer key_data. AGENT_SECRET (S...) seed signs the
# auth_digest off-chain in P4 (Stellar S-secret seed == Ed25519 secret seed).
AGENT_PUBKEY=$AGENT_PUBKEY_G
AGENT_PUBKEY_HEX=$AGENT_PUBKEY_HEX
AGENT_SECRET=$AGENT_SECRET
EOF
chmod 600 "$OUT_ENV"
echo "  wrote $OUT_ENV (mode 600)"

echo ""
if [[ "$ok" == "1" ]]; then
  echo "✅ DONE — SA deployed; rules 0 (VAULT_XLM) & 1 (XLM_SAC) verified policy-less + scoped with the same External-Ed25519 agent signer; no Default rule."
else
  echo "⚠️  Deployed but read-back self-verification flagged an issue. Inspect rule output above." >&2
  exit 2
fi
