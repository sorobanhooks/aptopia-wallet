//! `digest_reference` — GROUND-TRUTH auth-digest generator (P3 / AC3).
//!
//! This integration test is the canonical, on-chain-equivalent reference for the
//! Smart Account auth-digest. It proves AC3: that an off-chain TypeScript
//! computation can be made byte-identical to the on-chain Rust/soroban-sdk
//! computation. It does this by computing the digest for an ADVERSARIAL set of
//! fixed vectors using soroban-sdk's NATIVE `crypto().sha256` + `ToXdr` (the
//! exact primitives `do_check_auth` uses on-chain), and EMITTING each digest as
//! hex into a shared JSON fixture (`tests/fixtures/digest_vectors.json`).
//!
//! The TypeScript side (`api/src/auth-digest.ts` driven by
//! `bun run tracer:digest-parity`) reads the SAME fixture and asserts byte
//! equality against the `reference_digest_hex` values written here. There is a
//! single source of truth for both the inputs AND the ground-truth output: this
//! file generates the fixture; TS only consumes it. They cannot silently drift.
//!
//! ## auth-digest spec (validated by the P1 tracer against stellar-accounts
//! 0.7.1, smart_account/storage.rs:492-495 — GROUND TRUTH):
//!
//!   auth_digest = SHA-256( raw32(signature_payload) || ScValXdr(context_rule_ids) )
//!
//!   - signature_payload contributes its 32 RAW bytes (Hash<32>::to_bytes()),
//!     NOT the XDR of the hash.
//!   - context_rule_ids is a Vec<u32> serialized as the FULL soroban ScVal XDR
//!     of the host vec (SCV_VEC + present-flag + length + per-element SCV_U32),
//!     via soroban_sdk::xdr::ToXdr. A bare XDR int-array is WRONG.
//!
//! ## Adversarial vector set (all REQUIRED, see VECTORS below):
//!   1. empty context_rule_ids `[]`
//!   2. single-element `[0]`
//!   3. multi-element `[0,1,42]`
//!   4. large set (>=15 ids)
//!   5. boundary u32 values: include 0 and u32::MAX (4294967295)
//! signature_payload varies across vectors.
//!
//! This integration test lives in `tests/` (a separate, std-enabled crate) so it
//! can write the JSON fixture; the `sa-tracer` lib itself is `#![no_std]`.

use std::fmt::Write as _;
use std::path::PathBuf;

use soroban_sdk::{xdr::ToXdr, Bytes, Env, Vec};

/// One adversarial test vector: a fixed 32-byte signature_payload and a fixed
/// Vec<u32> of context_rule_ids, with a human label for diagnostics.
struct Vector {
    label: &'static str,
    /// The 32 RAW bytes of the host `signature_payload` (Hash<32>::to_bytes()).
    signature_payload: [u8; 32],
    /// The host Vec<u32> of context_rule_ids.
    context_rule_ids: &'static [u32],
}

/// The ADVERSARIAL vector set. These are the inputs; the digests are computed
/// below by the real soroban-sdk crypto + ToXdr and emitted to the fixture.
/// signature_payload is varied across vectors (NOT all the same).
const VECTORS: &[Vector] = &[
    // 1. empty context_rule_ids.
    Vector {
        label: "empty_ids",
        signature_payload: [0x00; 32],
        context_rule_ids: &[],
    },
    // 2. single-element.
    Vector {
        label: "single_id_zero",
        signature_payload: [0x11; 32],
        context_rule_ids: &[0],
    },
    // 3. multi-element (the [0,1,42] vector the P1 tracer pinned to 36 bytes XDR).
    Vector {
        label: "multi_0_1_42",
        signature_payload: [
            0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d,
            0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b,
            0x1c, 0x1d, 0x1e, 0x1f,
        ],
        context_rule_ids: &[0, 1, 42],
    },
    // 4. large set: 20 ids (>= OZ max-signers order of magnitude).
    Vector {
        label: "large_20_ids",
        signature_payload: [0xAB; 32],
        context_rule_ids: &[
            0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
        ],
    },
    // 5. boundary u32 values: 0 and u32::MAX, plus a midpoint.
    Vector {
        label: "boundary_u32",
        signature_payload: [0xFF; 32],
        context_rule_ids: &[0, 4_294_967_295, 2_147_483_648],
    },
    // 6. (extra) u32::MAX alone — single boundary element, distinct payload.
    Vector {
        label: "u32_max_single",
        signature_payload: [
            0xDE, 0xAD, 0xBE, 0xEF, 0xDE, 0xAD, 0xBE, 0xEF, 0xDE, 0xAD, 0xBE, 0xEF, 0xDE, 0xAD,
            0xBE, 0xEF, 0xDE, 0xAD, 0xBE, 0xEF, 0xDE, 0xAD, 0xBE, 0xEF, 0xDE, 0xAD, 0xBE, 0xEF,
            0xDE, 0xAD, 0xBE, 0xEF,
        ],
        context_rule_ids: &[4_294_967_295],
    },
];

/// Lowercase hex of a byte slice.
fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        write!(&mut s, "{:02x}", b).expect("hex write");
    }
    s
}

/// Compute the auth-digest for one vector using soroban-sdk's NATIVE primitives,
/// exactly mirroring `do_check_auth` (storage.rs:492-495):
///   preimage = signature_payload (32 raw bytes) || context_rule_ids.to_xdr()
///   auth_digest = crypto().sha256(preimage)
/// Returns (digest_bytes, ids_xdr_bytes) for emission + self-checks.
fn compute(e: &Env, v: &Vector) -> ([u8; 32], std::vec::Vec<u8>) {
    // signature_payload contributes its 32 RAW bytes.
    let mut preimage = Bytes::from_array(e, &v.signature_payload);

    // context_rule_ids as the FULL soroban ScVal XDR of the host Vec<u32>.
    let ids: Vec<u32> = {
        let mut vec = Vec::new(e);
        for &id in v.context_rule_ids {
            vec.push_back(id);
        }
        vec
    };
    let ids_xdr: Bytes = ids.to_xdr(e);
    preimage.append(&ids_xdr);

    let digest = e.crypto().sha256(&preimage).to_bytes();

    let mut digest_arr = [0u8; 32];
    let mut i = 0;
    for b in digest.to_array() {
        digest_arr[i] = b;
        i += 1;
    }

    let mut ids_xdr_bytes = std::vec::Vec::with_capacity(ids_xdr.len() as usize);
    for b in ids_xdr.iter() {
        ids_xdr_bytes.push(b);
    }

    (digest_arr, ids_xdr_bytes)
}

/// Build the EXPECTED soroban ScVal XDR framing for a Vec<u32> by hand, purely
/// as a self-check that soroban ToXdr emits the SCV_VEC + per-element SCV_U32
/// structure the spec (and the P1 tracer) pinned. This is NOT used to feed the
/// digest — the digest uses real ToXdr — it only guards that ToXdr hasn't
/// changed shape under us.
fn expected_scval_xdr(ids: &[u32]) -> std::vec::Vec<u8> {
    let mut out = std::vec::Vec::new();
    out.extend_from_slice(&16u32.to_be_bytes()); // SCV_VEC discriminant
    out.extend_from_slice(&1u32.to_be_bytes()); // Option<ScVec> = present
    out.extend_from_slice(&(ids.len() as u32).to_be_bytes()); // ScVec length
    for &v in ids {
        out.extend_from_slice(&3u32.to_be_bytes()); // SCV_U32 discriminant
        out.extend_from_slice(&v.to_be_bytes()); // the u32 value
    }
    out
}

/// Path to the shared fixture consumed by the TS parity script.
fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("digest_vectors.json")
}

/// Emit a JSON document. We avoid a serde dependency (this crate has none) and
/// hand-build a small, strict JSON string; the structure is trivial and fully
/// under our control. All bytes are emitted as lowercase hex strings.
fn build_fixture_json(rows: &[(String, [u8; 32], std::vec::Vec<u8>, &Vector)]) -> String {
    let mut s = String::new();
    s.push_str("{\n");
    s.push_str("  \"_comment\": \"GROUND TRUTH. Generated by `cargo test -p sa-tracer digest_reference`. ");
    s.push_str("Do not edit by hand. auth_digest = SHA-256(raw32(signature_payload) || ScValXdr(context_rule_ids)). ");
    s.push_str("Consumed for parity by api/src/auth-digest.ts via `bun run tracer:digest-parity`.\",\n");
    s.push_str("  \"spec\": \"sha256( signature_payload_32_raw_bytes || soroban_ScVal_XDR(Vec<u32> context_rule_ids) )\",\n");
    s.push_str("  \"source\": \"stellar-accounts 0.7.1 smart_account/storage.rs:492-495\",\n");
    s.push_str("  \"vectors\": [\n");
    for (i, (digest_hex, _digest, ids_xdr, v)) in rows.iter().enumerate() {
        s.push_str("    {\n");
        let _ = write!(s, "      \"label\": \"{}\",\n", v.label);
        let _ = write!(
            s,
            "      \"signature_payload_hex\": \"{}\",\n",
            hex(&v.signature_payload)
        );
        s.push_str("      \"context_rule_ids\": [");
        for (j, id) in v.context_rule_ids.iter().enumerate() {
            if j > 0 {
                s.push_str(", ");
            }
            let _ = write!(s, "{}", id);
        }
        s.push_str("],\n");
        let _ = write!(
            s,
            "      \"context_rule_ids_xdr_hex\": \"{}\",\n",
            hex(ids_xdr)
        );
        let _ = write!(s, "      \"reference_digest_hex\": \"{}\"\n", digest_hex);
        if i + 1 == rows.len() {
            s.push_str("    }\n");
        } else {
            s.push_str("    },\n");
        }
    }
    s.push_str("  ]\n");
    s.push_str("}\n");
    s
}

/// THE reference generator. Computes every adversarial vector's auth-digest with
/// native soroban-sdk primitives, self-checks the ScVal XDR framing, prints each
/// digest as hex, and writes the shared fixture for the TS parity script.
#[test]
fn digest_reference() {
    let e = Env::default();

    // Sanity on the vector set: enforce the adversarial coverage the plan requires.
    assert!(VECTORS.len() >= 5, "need >= 5 adversarial vectors");
    assert!(
        VECTORS.iter().any(|v| v.context_rule_ids.is_empty()),
        "missing the empty context_rule_ids vector"
    );
    assert!(
        VECTORS.iter().any(|v| v.context_rule_ids.len() == 1),
        "missing a single-element vector"
    );
    assert!(
        VECTORS.iter().any(|v| v.context_rule_ids.len() >= 15),
        "missing a large (>=15) vector"
    );
    assert!(
        VECTORS
            .iter()
            .any(|v| v.context_rule_ids.contains(&u32::MAX)),
        "missing a u32::MAX boundary value"
    );
    assert!(
        VECTORS.iter().any(|v| v.context_rule_ids.contains(&0)),
        "missing a 0 boundary value"
    );

    let mut rows: std::vec::Vec<(String, [u8; 32], std::vec::Vec<u8>, &Vector)> =
        std::vec::Vec::new();

    println!("\n=== auth-digest GROUND TRUTH (soroban-sdk crypto().sha256 + ToXdr) ===");
    for v in VECTORS {
        let (digest, ids_xdr) = compute(&e, v);

        // Self-check 1: digest is exactly 32 bytes (sha256).
        assert_eq!(digest.len(), 32, "[{}] digest must be 32 bytes", v.label);

        // Self-check 2: the ids XDR is the soroban ScVal framing the spec pins.
        let expected_framing = expected_scval_xdr(v.context_rule_ids);
        assert_eq!(
            ids_xdr, expected_framing,
            "[{}] context_rule_ids ToXdr is NOT the soroban ScVal XDR framing \
             (SCV_VEC + present + len + per-element SCV_U32). Got {} bytes: {}",
            v.label,
            ids_xdr.len(),
            hex(&ids_xdr)
        );

        // Self-check 3: length matches the framing formula 12 + 8*N.
        assert_eq!(
            ids_xdr.len(),
            12 + 8 * v.context_rule_ids.len(),
            "[{}] ScVal XDR length must be 12 + 8*N",
            v.label
        );

        let digest_hex = hex(&digest);
        println!(
            "  [{:<16}] ids={:<3} ids_xdr={:>3}B  digest={}",
            v.label,
            v.context_rule_ids.len(),
            ids_xdr.len(),
            digest_hex
        );
        rows.push((digest_hex, digest, ids_xdr, v));
    }

    // Ordering guard, on the multi-element vector: payload||ids must differ from
    // ids||payload (proves ordering is load-bearing, mirrors the P1 tracer).
    {
        let v = &VECTORS[2]; // multi_0_1_42
        let ids: Vec<u32> = {
            let mut vec = Vec::new(&e);
            for &id in v.context_rule_ids {
                vec.push_back(id);
            }
            vec
        };
        let ids_xdr = ids.to_xdr(&e);
        let mut reversed = ids_xdr.clone();
        reversed.append(&Bytes::from_array(&e, &v.signature_payload));
        let reversed_digest = e.crypto().sha256(&reversed).to_bytes().to_array();
        let (forward, _) = compute(&e, v);
        assert_ne!(
            forward, reversed_digest,
            "ORDERING GUARD: payload||ids == ids||payload is impossible unless \
             ordering is irrelevant. Spec uses payload||ids (storage.rs:492-495)."
        );
    }

    // Determinism guard: recomputing yields identical digests.
    for v in VECTORS {
        let (d1, _) = compute(&e, v);
        let (d2, _) = compute(&e, v);
        assert_eq!(d1, d2, "[{}] sha256 must be deterministic", v.label);
    }

    // Emit the shared fixture (single source of truth for inputs + ground-truth
    // hex). The TS parity script reads exactly this file.
    let json = build_fixture_json(&rows);
    let path = fixture_path();
    std::fs::create_dir_all(path.parent().expect("fixture parent dir"))
        .expect("create fixtures dir");
    std::fs::write(&path, json.as_bytes()).expect("write fixture json");
    println!("\n  wrote shared fixture -> {}", path.display());
    println!("=== {} vectors emitted ===\n", rows.len());
}
