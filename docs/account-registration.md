# Account registration (I-4) and the bridged-token display rule (I-4b)

**Status: FROZEN** (AA 00059 P1, 2026-10-04). A change needs a question in the 00059 questions file, the owner's answer, and a note in the 00057 master plan's status log: Night Market (00060) builds its "Show in my wallet" against this document.

A Passport account (Night Market) holds shielded coins statelessly: each deposit files a 192-byte note sealed to the account's X25519 `enc_key`. With that X25519 secret (the **account viewing key**) the injector computes the account's exact balance with Night Market's own code, and shows it in the wallet that controls the account. The viewing key cannot spend: every spend needs the device's Ed25519 signature.

Reference implementation: `src/accounts/message.js` (the text), `src/accounts/validate.js` (the checks), `src/accounts/errors.js` (codes), `src/tokens/display.js` (I-4b). Vectors: [`account-registration-vectors.json`](account-registration-vectors.json) (the texts, their SHA-256 and test-key signatures; `test/unit/account-message.test.js` keeps them equal to the code).

## Transport

HTTP on the injector's RPC port, the same origin as the wallet's custom RPC URL. JSON bodies of at most 16 KiB. CORS `*`.

| Method | Path | Answer |
|---|---|---|
| `GET` | `/api/accounts/registration-info` | 200 `{"format":"solana-token-injector account registration v1","origin":"<origin>","networkId":"<net>","maxTtlSeconds":600}` |
| `POST` | `/api/accounts` | 201 a new registration; 200 the same registration again (same key) or the key replaced; 4xx/5xx `{"error":"<message>","code":"<code>"}` |
| `GET` | `/api/accounts` | 200 `[<view>]` |
| `GET` | `/api/accounts/:id` | 200 `<view>`; 404 `{"error":"no such registration","code":"not-found"}` |

No `DELETE` in v1 (00059 Q2 C): a registration is removed by the operator. A wrong method answers 405 `method-not-allowed` with an `allow` header. When the account source is disabled, every route answers 503 `accounts-disabled`.

## The request

```json
{
  "solanaAddress": "<canonical base58 of the wallet's 32-byte Ed25519 key>",
  "accountAddress": "<64 hex: the Passport account's contract address>",
  "accountViewingKey": "<64 hex: the account's X25519 inbox secret>",
  "message": "<the exact v1 text the wallet signed>",
  "signature": "<128 hex: the 64-byte Ed25519 signature over the text's UTF-8 bytes>"
}
```

## The text, v1

Nine lines joined by one LF (`0x0A`); no CR; no trailing LF; printable ASCII `0x20`–`0x7E` only; at most 512 bytes.

```
solana-token-injector account registration v1
Show my Midnight account in my Solana wallet
RPC {origin}
Midnight network {networkId}
Wallet {solanaAddress}
Account {accountAddress}
Expires {YYYY-MM-DD HH:MM:SS} UTC
The RPC will see this account's balances.
This signature authorises nothing on chain and moves no funds.
```

| Field | Rule |
|---|---|
| `{origin}` | The injector's public origin exactly as WHATWG `new URL(publicUrl).origin` serialises it: `http` or `https`, lowercase host, the port only when it is not the scheme's default, no path, no trailing slash (`http://[::1]:1234` keeps its brackets). Take it from `registration-info.origin`. |
| `{networkId}` | The injector's Midnight network id, `[a-z0-9][a-z0-9-]{0,31}`; `registration-info.networkId`. |
| `{solanaAddress}` | Canonical base58 of the 32-byte key (`new PublicKey(s).toBase58() === s`); equal to the body's. |
| `{accountAddress}` | 64 lowercase hex, no `0x`; equal to the body's (compared lowercased). |
| `Expires` | UTC, whole seconds, zero-padded, a real date and time in the years 1970–9999. Accepted when `now < Expires <= now + maxTtlSeconds` (default 600 s) on the injector's clock. |

The injector parses a text with this grammar, re-renders it from the parsed fields and compares the bytes; anything else is `bad-message`.

Example (`docs/account-registration-vectors.json`, `valid[0]` has the same layout with a test key):

```
solana-token-injector account registration v1
Show my Midnight account in my Solana wallet
RPC http://127.0.0.1:18899
Midnight network undeployed
Wallet 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU
Account 453b2b8d0000000000000000000000000000000000000000000000000000375a
Expires 2026-10-05 12:34:56 UTC
The RPC will see this account's balances.
This signature authorises nothing on chain and moves no funds.
```

It is 407 bytes; its first line is 45 bytes.

### Why it is safe to sign

- It authorises nothing on chain: no Passport circuit verifies it, and Night Market's relay re-renders its own envelope text before it verifies.
- Its first line (45 bytes, `solana-token-injector …`) can never be the first line of a Passport Ed25519-arm message (always `Site: ` + a 24-byte padded label = 30 bytes) or of Night Market's proof-of-possession envelope (the bare label, 1–24 bytes). Tested both ways with the vendored renderers (`test/unit/account-message.test.js`, T1.4).
- It passes Passport's `assertSafeEd25519Message` (printable, not `0xff`-prefixed, does not parse as a Solana transaction, no Sign-In With Solana line).
- It is bound to the RPC origin and the network, so it cannot be replayed to another injector or network. Within the expiry a replay to the same injector re-registers the same pair (idempotent) and still needs the viewing key, which is not in the text.
- **Night Market renders it itself** from this template and never signs text an injector supplies. The injector serves only `registration-info`.
- Any other text a wallet is asked to sign for this ecosystem (00060's landing key, I-5) uses another first line; the injector refuses every first line but its own.

## Verification order

The first failure answers. Nothing is read from the chain before step 12 and nothing is stored before step 17.

| Step | Check | Code | HTTP |
|---|---|---|---|
| 1 | The body is a JSON object with the five string fields | `malformed` | 400 |
| 2 | `solanaAddress`: canonical base58 of 32 bytes and a strict Ed25519 key (canonical, prime order, not the identity) | `bad-solana-address` | 400 |
| 3 | `accountAddress`: 64 hex (no `0x`) | `bad-account-address` | 400 |
| 4 | `accountViewingKey`: 64 hex | `bad-viewing-key` | 400 |
| 5 | `signature`: 128 hex | `malformed` | 400 |
| 6 | `message` parses as the v1 template and re-renders to the same bytes | `bad-message` | 400 |
| 7 | Its `Wallet` and `Account` equal the body's | `message-mismatch` | 400 |
| 8 | Its `RPC` equals this injector's origin | `wrong-origin` | 400 |
| 9 | Its `Midnight network` equals this injector's | `wrong-network` | 400 |
| 10 | `now < Expires <= now + maxTtlSeconds` | `expired` / `expiry-too-far` | 400 |
| 11 | Strict Ed25519 signature over the text's bytes by `solanaAddress` (s < L; R canonical and not the identity; RFC 8032 without ZIP-215; and tweetnacl) | `bad-signature` | 401 |
| 12 | The indexer answers `contract(address){state}`; no contract | `indexer-unavailable` / `account-not-found` | 503 / 404 |
| 13 | The state decodes as a Passport account; its operations' verifier-key digests equal the pinned set exactly (`21493588…`); the maintenance authority is retired; it is activated (`booted`) | `not-passport-account` (with `detail`) | 403 |
| 14 | Its network salt is `keccak256("midnight:" ‖ networkId)` | `wrong-network` | 400 |
| 15 | `devices` holds the wallet's device entry at counter `auth_nonce`, else at some counter 0–255 | `not-a-device` | 403 |
| 16 | The X25519 public key of `accountViewingKey` equals `enc_key` | `enc-key-mismatch` | 403 |
| 17 | Stored: new → 201; the same key → 200; a new key → 200 with `replacedKey: true`, the old key kept to open older notes | `storage-error` on a write failure | 500 |

Other codes: `not-found` (404, an unknown id), `method-not-allowed` (405), `accounts-disabled` (503). The viewing key is never returned, logged or echoed in an error.

## The registration view

`GET` answers and the `POST` answer:

```json
{
  "id": "<first 16 hex of sha256('account:' + solanaAddress + ':' + accountAddress)>",
  "solanaAddress": "…", "accountAddress": "<64 hex>", "networkId": "undeployed",
  "keyFingerprint": "<first 8 hex of the current X25519 public key>", "heldKeys": 1,
  "createdAt": "<ISO>", "updatedAt": "<ISO>",
  "status": "syncing", "error": null, "lastCheckedAt": null,
  "history": { "complete": false, "throughHeight": 0 },
  "unseenCoins": 0, "unconfirmedNotes": 0, "unreadableEntries": 0,
  "tokens": [
    { "tokenType": "<64 hex>", "privacy": "shielded", "mint": "<base58>", "name": "Test X (Midnight)", "symbol": "mnX",
      "decimals": 6, "amount": "500000000", "uiAmountString": "500", "clamped": false }
  ],
  "created": true, "replacedKey": false
}
```

`created` and `replacedKey` appear only in the `POST` answer.

| Status | Meaning | Amounts served |
|---|---|---|
| `syncing` | Registered; no complete computation yet | none yet (or the persisted last amounts after a restart) |
| `synced` | The last poll read the state and a complete history | current |
| `incomplete` | The last poll's history is not complete (the reason in `error`) | computed from what was read, flagged |
| `stale-key` | No held key derives the on-chain `enc_key` (a rotation to a key the injector never got). Cleared without re-registering when a held key matches again; re-registering with the new key also clears it | frozen at the last computation before it |
| `error` | The last poll failed (indexer down, decode error); the reason in `error` | frozen at the last computation |

`unseenCoins` counts the account's leaves that no opened note explains, minus its spends that no opened coin explains: typically a withdrawal's change that Night Market has not filed yet (`append_inbox`). The RPC under-reports by that change until it is filed (00059 Q1 C). `unconfirmedNotes` counts notes whose coin has no leaf (a counterfeit note counts nothing). `unreadableEntries` counts notes no held key opens.

## For Night Market (00060)

1. `GET /api/accounts/registration-info`.
2. Render the text yourself from this template with the connected wallet, the account and an expiry at most `maxTtlSeconds` ahead (leave a margin for clock skew).
3. `signMessage` the text's UTF-8 bytes.
4. `POST /api/accounts` with the five fields.
5. Poll `GET /api/accounts/:id` until `synced`; show `unseenCoins` as a hint to file a withdrawal's change; offer to register again on `stale-key`.

## I-4b: the display rule for bridged colours

For a journey token registry (I-1) entry `{colour, splMint, bridgeContract, name, symbol, decimals}`:

- **name** = `base + " (Midnight)"`, where `base` is `name` cut to at most 21 bytes at a UTF-8 character boundary, trailing spaces trimmed (at most 32 bytes in all, the Metaplex v1 limit).
- **symbol** = `"mn"` + `symbol` cut to at most 8 bytes (at most 10 bytes). If that equals the SPL symbol ignoring case, it is `"MN"` + the colour's first 6 hex, uppercase. It never equals the SPL symbol.
- **decimals** = `decimals`, which must equal the SPL mint's on-chain decimals.
- **description** = `Midnight half of <name> (SPL mint <splMint>), bridged by contract <first 16 hex of bridgeContract>; display only`. `image` and `uri` come from the injector's own token registry when it lists the same colour.
- I-1 takes precedence over the injector's own token registry for the name, symbol and decimals of the colours it lists.

Example: `{name: "Test X", symbol: "X", decimals: 6}` shows as **Test X (Midnight)**, **mnX**, 6 decimals.
