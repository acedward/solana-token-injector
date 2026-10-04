// midnight-esk-decrypt: decrypt Midnight 2.x (ledger 9) shielded outputs with a viewing key.
//
// The viewing key is the zswap encryption secret key (bech32m, HRP `mn_shield-esk[_<networkId>]`).
// Everything below mirrors midnight-indexer v4.4.0-rc.1 (668ed025), which does the same
// decryption to decide whether a transaction is relevant to a viewing key; this crate returns
// the decrypted coins instead of a boolean. Source references (paths relative to the indexer
// repository) are given on each function.

pub mod protocol;

use bech32::Hrp;
use midnight_coin_structure_v3::coin::Info as InfoV9;
use midnight_ledger_v9::structure::{
    ProofMarker as ProofMarkerV9, Signature as SignatureV9,
    StandardTransaction as StandardTransactionV9,
};
use midnight_serialize_v1::{Deserializable, Serializable, tagged_deserialize};
use midnight_storage_core_v1::{DefaultDB, db::DB};
use midnight_transient_crypto_v3::{
    commitment::PureGeneratorPedersen as PureGeneratorPedersenV9,
    encryption::SecretKey as SecretKeyV9, proofs::Proof as ProofV9,
};
use midnight_zswap_v9::Offer as OfferV9;
use std::fmt;

/// Ledger release whose crates this binary is built from (indexer `Cargo.toml` `[patch.crates-io]`).
pub const LEDGER_VERSION: &str = "9.1.0.0-rc.3";

/// HRP prefix of a viewing key (indexer-api/src/infra/api/v4.rs:161-167,
/// `AddressType::SecretEncryptionKey => "mn_shield-esk"`).
pub const VIEWING_KEY_HRP_PREFIX: &str = "mn_shield-esk";

/// Same type alias as the indexer (indexer-common/src/domain/ledger.rs:53-58), with the
/// in-memory storage backend instead of the indexer's Postgres/SQLite `LedgerDb`.
pub type TransactionV9<D> = midnight_ledger_v9::structure::Transaction<
    SignatureV9,
    ProofMarkerV9,
    PureGeneratorPedersenV9,
    D,
>;

/// A decrypted shielded output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Coin {
    /// 0 = guaranteed offer; otherwise the fallible offer's segment id.
    pub segment: u16,
    /// Position of the output in the offer's `outputs` array.
    pub output_index: usize,
    /// Coin commitment of the output (32 bytes).
    pub commitment: [u8; 32],
    /// Raw shielded token type (32 bytes).
    pub token_type: [u8; 32],
    /// Amount in base units.
    pub value: u128,
}

/// Errors; their `Display` text never contains key material.
#[derive(Debug)]
pub enum Error {
    InvalidNetworkId(String),
    InvalidViewingKey(String),
    InvalidTransaction(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::InvalidNetworkId(m) => write!(f, "invalid network id: {m}"),
            Error::InvalidViewingKey(m) => write!(f, "invalid viewing key: {m}"),
            Error::InvalidTransaction(m) => write!(f, "invalid transaction: {m}"),
        }
    }
}

impl std::error::Error for Error {}

/// Network id rules of the indexer (indexer-common/src/domain.rs:74-86): non-empty, no
/// uppercase characters.
pub fn validate_network_id(network_id: &str) -> Result<(), Error> {
    if network_id.is_empty() {
        Err(Error::InvalidNetworkId("network ID must not be empty".into()))
    } else if network_id.chars().any(|c| c.is_uppercase()) {
        Err(Error::InvalidNetworkId("network ID must be all lowercase".into()))
    } else {
        Ok(())
    }
}

/// Expected viewing-key HRP for a network (indexer-api/src/infra/api/v4.rs:151-159): the bare
/// prefix for `mainnet`, `<prefix>_<networkId>` otherwise.
pub fn expected_hrp(network_id: &str) -> String {
    if network_id.eq_ignore_ascii_case("mainnet") {
        VIEWING_KEY_HRP_PREFIX.to_string()
    } else {
        format!("{VIEWING_KEY_HRP_PREFIX}_{network_id}")
    }
}

/// Decode a bech32m viewing key into the v9 encryption secret key, the way the indexer does:
/// 1. `decode_address` (indexer-api/src/infra/api/v4.rs:190-204): `bech32::decode` + HRP check;
/// 2. `ledger::SecretKey::deserialize(bytes)` (indexer-common/src/domain/ledger/secret_key.rs:23-29,
///    untagged `Deserializable::deserialize(&mut bytes, 0)`), then `repr()` (:33-35);
/// 3. `SecretKeyV9::from_repr(repr)` (indexer-common/src/domain/ledger/transaction.rs:284-285).
///
/// The indexer deserializes with transient-crypto 2.2.0-rc.1; this crate uses 3.0.0-rc.2, whose
/// `encryption.rs` and `curve.rs` are byte-identical to 2.2.0-rc.1 (checked with `diff`).
pub fn decode_viewing_key(viewing_key: &str, network_id: &str) -> Result<SecretKeyV9, Error> {
    validate_network_id(network_id)?;

    let (hrp, bytes) = bech32::decode(viewing_key)
        .map_err(|error| Error::InvalidViewingKey(format!("cannot bech32m-decode ({error})")))?;

    let expected_hrp = expected_hrp(network_id);
    if hrp.as_str() != expected_hrp {
        return Err(Error::InvalidViewingKey(format!(
            "hrp mismatch: expected HRP {expected_hrp}, but was {}",
            hrp.as_str()
        )));
    }

    let secret_key = <SecretKeyV9 as Deserializable>::deserialize(&mut bytes.as_slice(), 0)
        .map_err(|error| {
            Error::InvalidViewingKey(format!("cannot deserialize encryption secret key ({error})"))
        })?;
    let repr = secret_key.repr();

    Option::<SecretKeyV9>::from(SecretKeyV9::from_repr(&repr))
        .ok_or_else(|| Error::InvalidViewingKey("not a valid encryption secret key".into()))
}

/// Encode an encryption secret key as a bech32m viewing key, the way the node toolkit does
/// (midnight-node ledger/helpers/src/versions/common/wallet/shielded.rs:95-108: untagged
/// `serialize` of the key, bech32m with the network HRP). Used by tests and tooling only.
pub fn encode_viewing_key(secret_key: &SecretKeyV9, network_id: &str) -> String {
    let hrp = Hrp::parse(&expected_hrp(network_id)).expect("HRP for viewing key can be parsed");
    let mut data = Vec::with_capacity(64);
    Serializable::serialize(secret_key, &mut data).expect("secret key can be serialized");
    bech32::encode::<bech32::Bech32m>(hrp, &data).expect("viewing key can be bech32m-encoded")
}

/// Deserialize a raw transaction (`transaction.raw` from the indexer) as a ledger v9 transaction,
/// exactly like the indexer's V9 path (indexer-common/src/domain/ledger/transaction.rs:64-67,
/// `tagged_deserialize`, which also rejects trailing bytes). The indexer picks V9 for protocol
/// versions 2_000_000..2_001_000 (indexer-common/src/domain/protocol_version.rs:28-33,67-79);
/// a ledger v8 transaction fails here on its header tag.
pub fn deserialize_transaction(raw: &[u8]) -> Result<TransactionV9<DefaultDB>, Error> {
    tagged_deserialize(&mut &raw[..]).map_err(|error| {
        Error::InvalidTransaction(format!("cannot deserialize as ledger v9 transaction ({error})"))
    })
}

/// Decrypt every OUTPUT of the transaction's zswap offers that the key can decrypt.
///
/// Mirrors `Transaction::relevant` V9 arm (indexer-common/src/domain/ledger/transaction.rs:278-302)
/// and `can_decrypt_v9` (:372-381), but returns the decrypted coin `Info` instead of a boolean,
/// and only for `outputs` (transients are created and spent in the same transaction and never
/// reach a balance). Guaranteed offer = segment 0; each fallible offer = its segment id.
/// `ClaimRewards` transactions carry no zswap offers (the indexer returns `false`, :301).
pub fn decrypt_transaction<D: DB>(tx: &TransactionV9<D>, key: &SecretKeyV9) -> Vec<Coin> {
    let mut coins = Vec::new();

    match tx {
        TransactionV9::Standard(StandardTransactionV9 {
            guaranteed_coins,
            fallible_coins,
            ..
        }) => {
            if let Some(guaranteed_coins) = guaranteed_coins.as_ref() {
                decrypt_offer(key, 0, guaranteed_coins, &mut coins);
            }
            for entry in fallible_coins.iter() {
                let (segment, offer) = (&*entry.0, &*entry.1);
                decrypt_offer(key, *segment, offer, &mut coins);
            }
        }

        TransactionV9::ClaimRewards(_) => {}
    }

    coins.sort_by_key(|coin| (coin.segment, coin.output_index));
    coins
}

fn decrypt_offer<D: DB>(
    key: &SecretKeyV9,
    segment: u16,
    offer: &OfferV9<ProofV9, D>,
    coins: &mut Vec<Coin>,
) {
    for (output_index, output) in offer.outputs.iter().enumerate() {
        let Some(ciphertext) = output.ciphertext.clone() else {
            continue;
        };
        if let Some(info) = key.decrypt::<InfoV9>(&(*ciphertext).to_owned().into()) {
            coins.push(Coin {
                segment,
                output_index,
                commitment: output.coin_com.0.0,
                token_type: info.type_.0.0,
                value: info.value,
            });
        }
    }
}

/// The indexer's exact relevance rule (outputs AND transients, guaranteed and fallible offers),
/// kept for tests that compare with the indexer's expectations.
/// Copy of `relevant()` V9 arm + `can_decrypt_v9` (indexer-common/src/domain/ledger/transaction.rs:278-302, 372-381).
pub fn relevant_like_indexer<D: DB>(tx: &TransactionV9<D>, key: &SecretKeyV9) -> bool {
    match tx {
        TransactionV9::Standard(StandardTransactionV9 {
            guaranteed_coins,
            fallible_coins,
            ..
        }) => {
            let can_decrypt_guaranteed_coins = guaranteed_coins
                .as_ref()
                .map(|guaranteed_coins| can_decrypt_v9(key, guaranteed_coins))
                .unwrap_or_default();

            let can_decrypt_fallible_coins = || {
                fallible_coins
                    .values()
                    .any(|fallible_coins| can_decrypt_v9(key, &fallible_coins))
            };

            can_decrypt_guaranteed_coins || can_decrypt_fallible_coins()
        }

        TransactionV9::ClaimRewards(_) => false,
    }
}

fn can_decrypt_v9<D: DB>(key: &SecretKeyV9, offer: &OfferV9<ProofV9, D>) -> bool {
    let outputs = offer.outputs.iter().filter_map(|o| o.ciphertext.clone());
    let transient = offer.transient.iter().filter_map(|o| o.ciphertext.clone());
    let mut ciphertexts = outputs.chain(transient);

    ciphertexts.any(|ciphertext| {
        key.decrypt::<InfoV9>(&(*ciphertext).to_owned().into())
            .is_some()
    })
}
