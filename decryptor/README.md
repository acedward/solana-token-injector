# midnight-esk-decrypt

A small Rust helper that decrypts the shielded coins a **Midnight viewing key** can see in a
Midnight 2.x (ledger 9) transaction. Given a transaction's raw bytes (`transaction.raw` from the
indexer) and a bech32m viewing key, it returns each output the key can decrypt: its coin
commitment, token type and value.

The service in this repository runs it as a long-lived child process and talks to it in JSON
lines over stdin/stdout.

## What a viewing key can and cannot see

The viewing key (`mn_shield-esk…`) is the wallet's zswap **encryption secret key**. It decrypts
every coin the wallet *receives* (including its own change), but it cannot tell when a coin is
*spent*: a spend is only recognisable through the coin's nullifier, which needs the coin secret
key, a spending credential. So the totals built from this helper are **total received per token
type**. They equal the wallet's balance only for a wallet that has never spent. A wallet that
received 100 and sent 30 with 70 change shows 170. (Decision Q3 in
`plans/00056-solana-token-injector-questions.md` of the project workspace.)

## How it mirrors the indexer

The Midnight indexer already performs this decryption to decide which transactions are relevant
to a viewing key; this helper runs the same code and returns the decrypted data instead of a
boolean. Source: `midnight-indexer` v4.4.0-rc.1 (`668ed025`):

| Step | Indexer source | Here |
|---|---|---|
| Key: bech32 decode + HRP check | `indexer-api/src/infra/api/v4.rs` `decode_address`, `AddressType::hrp` | `decode_viewing_key` |
| Key: payload → secret key | `indexer-common/src/domain/ledger/secret_key.rs` (untagged deserialize, `repr`) and `transaction.rs` (`SecretKeyV9::from_repr`) | `decode_viewing_key` |
| Transaction: ledger v9 tagged deserialization | `indexer-common/src/domain/ledger/transaction.rs` `Transaction::deserialize` (V9 arm) | `deserialize_transaction` |
| Decryption of offer outputs | `transaction.rs` `relevant()` V9 arm, `can_decrypt_v9` | `decrypt_transaction` |

Crates: the ledger-v9 family with the indexer's exact git tags (`crate-ledger-9.1.0.0-rc.3`,
`zswap-9.0.0-rc.3`, `coin-structure-3.0.0-rc.1`, `transient-crypto-3.0.0-rc.2`,
`serialize-1.2.0-rc.1`, `base-crypto-1.1.0-rc.2`, …). `[patch.crates-io]` is copied from the
indexer's `Cargo.toml`, and `Cargo.lock` was seeded from the indexer's lock: every package in it
is the indexer's version. Toolchain `1.95.0` (`rust-toolchain.toml`, same as the indexer).

Only ledger v9 (Midnight 2.x: stagenet, local `undeployed` 2.x) is supported. A ledger v8
(Midnight 1.x: preprod, mainnet) transaction is rejected with a header-tag error. 1.x support
would presumably be the same code built against the crates.io `midnight-ledger 8.1.0` family
(not built or tested).

## Protocol (JSON lines)

Start `midnight-esk-decrypt` with no arguments. Write one JSON object per line to stdin; it
writes one JSON object per line to stdout, **in request order**. Blank lines are ignored. Logs go
to stderr only. No output or log line contains a viewing key.

Requests:

```json
{"id": "r1", "op": "decrypt", "networkId": "undeployed", "viewingKey": "mn_shield-esk_undeployed1…", "raw": "<hex of transaction.raw>"}
{"id": "r2", "op": "validateKey", "networkId": "undeployed", "viewingKey": "mn_shield-esk_undeployed1…"}
{"id": "r3", "op": "version"}
```

Responses:

```json
{"id": "r1", "ok": true, "coins": [{"segment": 0, "outputIndex": 1, "commitment": "<64 hex>", "tokenType": "<64 hex>", "value": "49999999999990"}]}
{"id": "r2", "ok": true}
{"id": "r3", "ok": true, "version": "0.1.0", "ledger": "9.1.0.0-rc.3"}
{"id": "r4", "ok": false, "error": "invalid viewing key: hrp mismatch: expected HRP mn_shield-esk_undeployed, but was mn_shield-esk_preview"}
```

- `id` is echoed as given (any JSON value; `null` when the line could not be parsed).
- `coins` lists only `outputs` (not `transient` coins, which are created and spent in the same
  transaction) that decrypt with the key, sorted by `segment`, then `outputIndex`.
  `segment` 0 is the guaranteed offer; a fallible offer reports its segment id (u16).
  `outputIndex` is the position in that offer's `outputs`.
- `commitment` is the output's coin commitment and `tokenType` the raw 32-byte shielded token
  type, both as 64 lowercase hex (the same strings as the wallet SDK's `RawTokenType` balance
  keys). `value` is a decimal string (u128, base units).
- Viewing-key HRP: `mn_shield-esk` for network `mainnet`, `mn_shield-esk_<networkId>` otherwise.
  A network id must be non-empty and lowercase (indexer rule). Decoded keys are cached per
  (networkId, viewingKey).
- `raw` is hex, with or without a `0x` prefix. `ClaimRewards` transactions give `coins: []`.
- Every failure (malformed JSON, unknown `op`, missing field, bad hex, wrong-network key,
  undecodable or non-v9 transaction, invalid UTF-8) is an `ok: false` response for that line;
  the process keeps running. It exits 0 when stdin closes.
- `midnight-esk-decrypt --version` prints the version and exits.

## Counting received totals from the indexer's transactions

The `shieldedTransactions` subscription delivers each relevant transaction with
`transactionResult { status segments { id success } }`. Count a decrypted coin when:

| `status` | segment 0 (guaranteed) | fallible segment `s` |
|---|---|---|
| `SUCCESS` (the indexer sends `segments: null`) | yes | yes |
| `PARTIAL_SUCCESS` | yes | only if `segments` lists `{id: s, success: true}` |
| `FAILURE` | no | no |

and count each `commitment` once (a reconnecting subscription re-delivers transactions). This is
the indexer's own rule (`indexer-api/src/infra/api/v4/transaction.rs` maps `Success` to
`segments: None`; decision Q19).

## Build

Native (host toolchain via rustup; `rust-toolchain.toml` selects 1.95.0):

```sh
cd decryptor
cargo build --release          # target/release/midnight-esk-decrypt
```

Docker (linux; builds only from the local `oven/bun:1.3.11`, never pulls):

```sh
docker build --pull=false -t s00056/decryptor:<run-id> decryptor/
# or just the binary, no image:
docker build --pull=false --output type=local,dest=./out decryptor/   # ./out/usr/local/bin/midnight-esk-decrypt
```

The build installs rustup and the pinned toolchain inside the build stage and caches
`~/.cargo/registry`, `~/.cargo/git` and `target` in BuildKit cache mounts. The final stage
holds only `/usr/local/bin/midnight-esk-decrypt`; the binary links against glibc, so run it in
an `oven/bun:1.3.11`-based (Debian) container or `COPY --from=` it into one.

## Tests

```sh
cd decryptor
cargo test
node scripts/selftest-check-fixtures.mjs target/release/midnight-esk-decrypt
node scripts/check-fixtures.mjs <harness>/fixtures/undeployed target/release/midnight-esk-decrypt
```

- `tests/decrypt.rs`: derives the viewing keys of seeds `00…01..03` like the indexer test
  (BIP-32 `m/44'/2400'/0'/3/0` → zswap `SecretKeys::from(Seed)` → encryption secret key),
  checks the three node-toolkit known answers, and checks the indexer's own 2.x fixture
  transactions (`tests/fixtures/`, vendored unchanged) against the relevance the indexer test
  expects; plus key and transaction error cases.
- `tests/protocol.rs`: runs the binary with a mixed session (valid requests, malformed lines,
  wrong-network key, non-v9 transaction, invalid UTF-8) and checks one response per request in
  order and that no key is ever printed.
- `scripts/check-fixtures.mjs <fixtures dir> <binary> [--network id] [--json out]`: for every
  wallet fixture written by the local-network harness, decrypts all its transactions, totals per
  token type with the rule above, and compares with the wallet SDK's balances for wallets that
  never spent. Exit 0 = all match, 1 = mismatch or decrypt error, 2 = usage error.
- `scripts/selftest-check-fixtures.mjs <binary>`: exercises `check-fixtures.mjs` on synthetic
  fixtures built from the indexer's transactions (duplicates, `FAILURE`, `PARTIAL_SUCCESS`,
  spent wallet, mismatch, undecodable transaction).

## Limitations

- Received totals only (see above); spends are invisible to a viewing key.
- Ledger v9 only.
- No check that the transaction's own `network_id` matches the request's `networkId` (the
  indexer does not check it either); only the key's HRP is checked.
- One request at a time; a decrypt of an ~18 KB transaction takes about 1.6 ms (release build,
  Apple M4 Max host, 500–5 000 sequential requests).
