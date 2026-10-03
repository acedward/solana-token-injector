// Gate B1: decrypt the indexer's own 2.x fixture transactions with viewing keys derived the way
// the indexer test derives them, and check the relevance the indexer test expects.

use bip32::{DerivationPath, XPrv};
use midnight_esk_decrypt::{
    Coin, decode_viewing_key, decrypt_transaction, deserialize_transaction, encode_viewing_key,
    relevant_like_indexer,
};
use midnight_zswap_v9::keys::{SecretKeys, Seed};
use std::str::FromStr;

const TX_1_2_2: &[u8] = include_bytes!("fixtures/v9_tx_1_2_2.raw");
const TX_1_2_3: &[u8] = include_bytes!("fixtures/v9_tx_1_2_3.raw");
const TX_V8_1_2_2: &[u8] = include_bytes!("fixtures/v8_tx_1_2_2.raw");

/// Seed `00…0n` -> BIP-32 `m/44'/2400'/0'/3/0` -> zswap `SecretKeys::from(Seed)` ->
/// encryption secret key, exactly as the indexer test `viewing_key(n)`
/// (indexer-common/src/domain/ledger/transaction.rs:494-510; it uses the v8 zswap crate, whose
/// `Seed` derivation is identical to zswap 9.0.0-rc.3's), then bech32m like the node toolkit.
fn viewing_key(n: u8, network_id: &str) -> String {
    let mut seed = [0; 32];
    seed[31] = n;

    let derivation_path =
        DerivationPath::from_str("m/44'/2400'/0'/3/0").expect("derivation path can be created");
    let derived_seed: [u8; 32] = XPrv::derive_from_path(seed, &derivation_path)
        .expect("key can be derived")
        .private_key()
        .to_bytes()
        .into();

    let secret_keys = SecretKeys::from(Seed::from(derived_seed));
    encode_viewing_key(&secret_keys.encryption_secret_key, network_id)
}

fn coins(raw: &[u8], seed: u8) -> Vec<Coin> {
    let tx = deserialize_transaction(raw).expect("fixture deserializes as ledger v9");
    let key = decode_viewing_key(&viewing_key(seed, "undeployed"), "undeployed")
        .expect("derived key decodes");
    decrypt_transaction(&tx, &key)
}

#[test]
fn toolkit_known_answers() {
    // midnight-node v2.0.0-rc.4 util/toolkit/src/commands/show_viewing_key.rs test cases.
    assert_eq!(
        viewing_key(1, "undeployed"),
        "mn_shield-esk_undeployed1dlyj7u8juj68fd4psnkqhjxh32sec0q480vzswg8kd485e2kljcs9ete5h"
    );
    assert_eq!(
        viewing_key(2, "devnet"),
        "mn_shield-esk_devnet1w0dctw9zhe2ffqw4s5qks7rnl29wy5mhl957fv9nnhtxulent80q5dejklr"
    );
    assert_eq!(
        viewing_key(3, "testnet"),
        "mn_shield-esk_testnet1wvd5v04ykt59gglxknsdxpwwkhhhj8d6h3ghpkgdhdsszap2p53qkprdkd8"
    );
}

#[test]
fn indexer_api_test_key_decodes() {
    // indexer-api/src/infra/api/v4/viewing_key.rs:64-72.
    let key = "mn_shield-esk_undeployed1dlyj7u8juj68fd4psnkqhjxh32sec0q480vzswg8kd485e2kljcs9ete5h";
    let decoded = decode_viewing_key(key, "undeployed").expect("indexer test key decodes");
    assert_eq!(encode_viewing_key(&decoded, "undeployed"), key);
}

#[test]
fn fixture_relevance_matches_indexer() {
    // indexer-common/src/domain/ledger/transaction.rs:473-489.
    let expected: [(&str, &[u8], [bool; 3]); 2] = [
        ("tx_1_2_2", TX_1_2_2, [true, true, false]),
        ("tx_1_2_3", TX_1_2_3, [true, false, true]),
    ];

    for (name, raw, relevant) in expected {
        let tx = deserialize_transaction(raw).expect("fixture deserializes as ledger v9");
        for seed in 1..=3u8 {
            let key = decode_viewing_key(&viewing_key(seed, "undeployed"), "undeployed").unwrap();
            let want = relevant[(seed - 1) as usize];
            assert_eq!(
                relevant_like_indexer(&tx, &key),
                want,
                "indexer relevance rule, {name}, seed {seed}"
            );
            let coins = decrypt_transaction(&tx, &key);
            assert_eq!(
                !coins.is_empty(),
                want,
                "decrypted outputs, {name}, seed {seed}: {coins:?}"
            );
            for coin in &coins {
                // Machine-readable line for the evidence file (run with --nocapture).
                println!(
                    "COIN fixture={name} seed=00..0{seed} segment={} outputIndex={} tokenType={} value={} commitment={}",
                    coin.segment,
                    coin.output_index,
                    hex::encode(coin.token_type),
                    coin.value,
                    hex::encode(coin.commitment)
                );
            }
        }
    }
}

#[test]
fn outputs_are_sorted_and_unique() {
    for raw in [TX_1_2_2, TX_1_2_3] {
        for seed in 1..=3u8 {
            let coins = coins(raw, seed);
            let mut keys: Vec<_> = coins.iter().map(|c| (c.segment, c.output_index)).collect();
            let sorted = {
                let mut k = keys.clone();
                k.sort();
                k
            };
            assert_eq!(keys, sorted);
            keys.dedup();
            assert_eq!(keys.len(), coins.len());
            let mut commitments: Vec<_> = coins.iter().map(|c| c.commitment).collect();
            commitments.sort();
            commitments.dedup();
            assert_eq!(commitments.len(), coins.len());
        }
    }
}

#[test]
fn wrong_network_key_is_rejected() {
    let key = viewing_key(1, "undeployed");
    let error = decode_viewing_key(&key, "preview").unwrap_err().to_string();
    assert!(error.starts_with("invalid viewing key: hrp mismatch"), "{error}");
    assert!(!error.contains(&key));
    let error = decode_viewing_key(&key, "mainnet").unwrap_err().to_string();
    assert!(error.contains("expected HRP mn_shield-esk,"), "{error}");
}

#[test]
fn mainnet_uses_bare_prefix() {
    let key = viewing_key(1, "mainnet");
    assert!(key.starts_with("mn_shield-esk1"), "{key}");
    decode_viewing_key(&key, "mainnet").expect("mainnet key decodes");
}

#[test]
fn invalid_network_ids_are_rejected() {
    let key = viewing_key(1, "undeployed");
    assert!(decode_viewing_key(&key, "").is_err());
    assert!(decode_viewing_key(&key, "Undeployed").is_err());
}

#[test]
fn garbage_keys_are_rejected() {
    for key in [
        "",
        "not a key",
        "mn_shield-esk_undeployed1qqqqqq",
        // valid bech32m but a 1-byte payload
        &bech32::encode::<bech32::Bech32m>(
            bech32::Hrp::parse("mn_shield-esk_undeployed").unwrap(),
            &[1u8],
        )
        .unwrap(),
    ] {
        let error = decode_viewing_key(key, "undeployed").unwrap_err().to_string();
        assert!(error.starts_with("invalid viewing key"), "{error}");
    }
    // A shielded ADDRESS is not a viewing key (different HRP).
    let error = decode_viewing_key(
        "mn_shield-addr_undeployed1dlyj7u8juj68fd4psnkqhjxh32sec0q480vzswg8kd485e2kljcs9ete5h",
        "undeployed",
    )
    .unwrap_err()
    .to_string();
    assert!(error.starts_with("invalid viewing key"), "{error}");
}

#[test]
fn non_v9_and_corrupt_transactions_are_rejected() {
    let error = deserialize_transaction(TX_V8_1_2_2).unwrap_err().to_string();
    assert!(error.contains("expected header tag"), "{error}");

    let error = deserialize_transaction(&TX_1_2_2[..TX_1_2_2.len() - 1]).unwrap_err().to_string();
    assert!(error.starts_with("invalid transaction"), "{error}");

    let mut trailing = TX_1_2_2.to_vec();
    trailing.push(0);
    assert!(deserialize_transaction(&trailing).is_err());

    assert!(deserialize_transaction(&[]).is_err());
}

#[test]
fn repeated_decryption_is_stable() {
    let first = coins(TX_1_2_2, 1);
    for _ in 0..50 {
        assert_eq!(coins(TX_1_2_2, 1), first);
    }
}
