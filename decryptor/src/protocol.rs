// JSON-lines protocol I-1 (plans/00056-solana-token-injector.md, "I-1. Decryptor protocol").
//
// One JSON object per input line, one JSON object per output line, in request order.
// Every failure is reported per request as `{"id", "ok": false, "error"}`; nothing here may
// panic the process, and no response or log line contains a viewing key.

use crate::{
    Coin, Error, LEDGER_VERSION, decode_viewing_key, decrypt_transaction, deserialize_transaction,
    validate_network_id,
};
use midnight_transient_crypto_v3::encryption::SecretKey as SecretKeyV9;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};

/// Upper bound of the decoded-key cache; the cache is cleared when it is reached.
const KEY_CACHE_MAX: usize = 4_096;

/// Protocol state: the decoded-key cache, keyed by (networkId, viewingKey) strings.
#[derive(Default)]
pub struct Session {
    keys: HashMap<(String, String), SecretKeyV9>,
}

impl Session {
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of cached keys (for tests).
    pub fn cached_keys(&self) -> usize {
        self.keys.len()
    }

    /// Handle one input line and return the response line (without the newline).
    /// Returns `None` for a blank line (not a request).
    pub fn handle_line(&mut self, line: &str) -> Option<String> {
        let line = line.trim();
        if line.is_empty() {
            return None;
        }

        let response = match serde_json::from_str::<Value>(line) {
            Err(error) => error_response(&Value::Null, format!("malformed request: {error}")),
            Ok(Value::Object(request)) => {
                let id = request.get("id").cloned().unwrap_or(Value::Null);
                match catch_unwind(AssertUnwindSafe(|| self.handle_request(&id, &request))) {
                    Ok(response) => response,
                    Err(_) => error_response(&id, "internal error while handling request".into()),
                }
            }
            Ok(_) => error_response(&Value::Null, "malformed request: not a JSON object".into()),
        };

        Some(response.to_string())
    }

    fn handle_request(&mut self, id: &Value, request: &Map<String, Value>) -> Value {
        let op = match request.get("op") {
            Some(Value::String(op)) => op.as_str(),
            Some(_) => return error_response(id, "malformed request: op must be a string".into()),
            None => return error_response(id, "malformed request: missing op".into()),
        };

        match op {
            "version" => json!({
                "id": id,
                "ok": true,
                "version": env!("CARGO_PKG_VERSION"),
                "ledger": LEDGER_VERSION,
            }),

            "validateKey" => match self.key(request) {
                Ok(_) => json!({ "id": id, "ok": true }),
                Err(error) => error_response(id, error),
            },

            "decrypt" => match self.decrypt(request) {
                Ok(coins) => json!({
                    "id": id,
                    "ok": true,
                    "coins": coins.iter().map(coin_json).collect::<Vec<_>>(),
                }),
                Err(error) => error_response(id, error),
            },

            other => error_response(id, format!("unknown op: {}", truncate(other, 64))),
        }
    }

    fn decrypt(&mut self, request: &Map<String, Value>) -> Result<Vec<Coin>, String> {
        let key = self.key(request)?;
        let raw = string_field(request, "raw")?;
        let raw = raw.strip_prefix("0x").unwrap_or(raw);
        let raw = hex::decode(raw).map_err(|error| format!("invalid raw: not hex ({error})"))?;
        let tx = deserialize_transaction(&raw).map_err(|error| error.to_string())?;
        Ok(decrypt_transaction(&tx, &key))
    }

    fn key(&mut self, request: &Map<String, Value>) -> Result<SecretKeyV9, String> {
        let network_id = string_field(request, "networkId")?;
        let viewing_key = string_field(request, "viewingKey")?;
        validate_network_id(network_id).map_err(|error| error.to_string())?;

        let cache_key = (network_id.to_string(), viewing_key.to_string());
        if let Some(key) = self.keys.get(&cache_key) {
            return Ok(*key);
        }

        let key = decode_viewing_key(viewing_key, network_id).map_err(|error: Error| error.to_string())?;
        if self.keys.len() >= KEY_CACHE_MAX {
            self.keys.clear();
        }
        self.keys.insert(cache_key, key);
        Ok(key)
    }
}

fn string_field<'a>(request: &'a Map<String, Value>, name: &str) -> Result<&'a str, String> {
    match request.get(name) {
        Some(Value::String(value)) => Ok(value.as_str()),
        Some(_) => Err(format!("malformed request: {name} must be a string")),
        None => Err(format!("malformed request: missing {name}")),
    }
}

fn coin_json(coin: &Coin) -> Value {
    json!({
        "segment": coin.segment,
        "outputIndex": coin.output_index,
        "commitment": hex::encode(coin.commitment),
        "tokenType": hex::encode(coin.token_type),
        "value": coin.value.to_string(),
    })
}

fn error_response(id: &Value, error: String) -> Value {
    json!({ "id": id, "ok": false, "error": error })
}

fn truncate(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}
