# solana-token-injector

A Solana JSON-RPC proxy for wallets that accept a custom RPC (Backpack, Nightly).
Every call goes to a real upstream node untouched, except the few a wallet uses
to find and display SPL tokens. Those get synthetic accounts merged in, so a
token shows up next to your real balances.

Tokens come from two places:

- **Static tokens** defined in `config.json` (phase 1).
- **Midnight shielded tokens** (registration service, v1): register a Solana
  address together with a Midnight viewing key on the service's web page, and
  that address sees one Token-2022 token per Midnight token type the key has
  received.

It is **display only**. The token's accounts don't exist on chain, so sending
it, swapping it, or anything else that touches it will fail simulation.
Everything else (real SOL, real tokens, real transactions) works normally,
because those calls pass straight through.

## Quick start (static token)

```bash
npm install
cp config.example.json config.json   # put your wallet address in "balances"
npm start
```

Remove the `midnight` block from `config.json` if you only want static tokens.

Then in the wallet:

- **Backpack**: Settings → Preferences → Solana → RPC Connection → Custom → `http://127.0.0.1:8899`
- **Nightly**: turn on Developer Mode, then pick Custom as the Solana RPC endpoint

Set `upstream` to the cluster the wallet should otherwise behave like
(devnet for testing, or a mainnet RPC URL from your provider).

## Registration service (Midnight viewing keys)

One Node process on one port serves the JSON-RPC proxy (`POST /`), a web page
(`GET /`), a JSON API (`/api/registrations`), `/health`, and the token
metadata files. For each registered viewing key it follows the Midnight
indexer and decrypts the shielded coins the key received with
`midnight-esk-decrypt`, a Rust helper run as a child process (built from
`decryptor/`).

### Read this first: what v1 shows, and what it does not

- **Not private.** The service stores the viewing keys you register (in
  plaintext in `<dataDir>/registrations.json`, file mode 0600) and anyone who
  can open the page sees every registration and its amounts. The page and the
  API show keys masked (first 16 and last 6 characters); logs never print them.
- **Amounts are totals RECEIVED, not balances.** A Midnight viewing key (the
  zswap encryption secret key) decrypts every coin the wallet receives, but it
  cannot see spends: detecting a spend needs the coin secret key, which can
  spend the funds. So the amount is exact for a wallet that has never spent.
  After a spend it over-reports: a wallet holding 100 that sends 30 (70 change
  back to itself) shows 100 + 70 = 170. The page says so.
- **No ownership proof.** Anyone can attach a viewing key to any Solana
  address, and anyone can delete a registration. The effect is display-only,
  and only for wallets pointed at this service.
- **Amounts above `u64::MAX`** (Midnight values are u128) are shown as
  `u64::MAX` in the wallet; the page shows the exact total and flags the row.

### Getting a viewing key

The viewing key is a bech32m string `mn_shield-esk_<network>1…`
(`mn_shield-esk1…` on mainnet). No production wallet exports it today. Tools
that hold the seed can print it, for example the Midnight node toolkit's
`show-viewing-key --network <network> --seed <seed>`, or the wallet SDK
(`ZswapSecretKeys.fromSeed(seed).encryptionSecretKey` encoded with
`MidnightBech32m` / `ShieldedEncryptionSecretKey`).

### Run

1. Build the decryptor (see `decryptor/`), or point `midnight.decryptorBin` /
   `DECRYPTOR_BIN` at a built `midnight-esk-decrypt`.
2. Add a `midnight` block to `config.json` (see `config.example.json`) with
   your Midnight network id and the indexer URLs. `tokens` becomes optional.
3. `npm start`, then open `http://127.0.0.1:8899/`, register your Solana
   address and viewing key, and point the wallet's custom RPC at the URL the
   page shows.

The status column reads:

| Status | Meaning |
|---|---|
| `connecting` | first connection to the indexer in progress |
| `syncing` | subscribed; the indexer may still be delivering this key's past transactions |
| `synced` | caught up: a progress event arrived at least `syncMinMs` (10 s) after subscribing, the indexer reported checked ≥ highest, and no relevant transaction arrived in the `syncQuietMs` (5 s) before it. On a real indexer this should take about 25–35 s (the indexer's default config sends a progress event at once, then about every 30 s; not measured yet). Amounts appear before that, as soon as each transaction is decrypted |
| `error: …` | the indexer or the decryptor failed; the last amounts are still served, and the service reconnects with backoff (1 s → 30 s) and replays from index 0 (coins are de-duplicated by commitment) |

What counts toward a total: outputs of the guaranteed segment of `SUCCESS` and
`PARTIAL_SUCCESS` transactions, fallible-segment outputs of `SUCCESS`
transactions and of segments listed with `success: true` in a
`PARTIAL_SUCCESS`; nothing from `FAILURE`. Transient outputs (created and spent
in the same transaction) are never counted.

### Midnight tokens on the Solana side

One Token-2022 mint per (network, token type), with the on-mint TokenMetadata
extension and a Metaplex metadata account. The mint address is
`sha256("solana-token-injector:mint:midnight:<networkId>:<64-hex token type>")`.
Each registered address holds the sum of its registrations' totals, in Midnight
base units. Names, symbols, decimals and logos come from the token registry
file; unknown types are shown as `Midnight <first 8 hex>` / `MN<first 4 hex>`
with 6 decimals.

Token registry file (`tokens/tokens.<networkId>.json`; the bundled one for
`undeployed` names the three genesis types `00…00`, `00…01`, `00…02`). It is
reloaded when it changes:

```json
{
  "network": "undeployed",
  "tokens": {
    "<64-hex token type>": {
      "name": "Midnight Test Token",
      "symbol": "MNTT",
      "decimals": 6,
      "image": "https://…/logo.png",
      "description": "…"
    }
  }
}
```

`name` ≤ 32 bytes, `symbol` ≤ 10 bytes (Metaplex limits), `decimals` 0–255,
optional `image`, `description`, and `uri` (your own metadata JSON, ≤ 200 bytes).

### API

| Request | Answer |
|---|---|
| `GET /` | the web page |
| `GET /api/registrations` | JSON array of registrations |
| `POST /api/registrations` with `{"solanaAddress": "…", "viewingKey": "mn_shield-esk_…"}` | `201` new registration, `200` the same pair already registered, `400 {"error": "…"}` invalid input (nothing stored), `503` the decryptor is unreachable or `midnight` is not configured |
| `GET /api/registrations/:id` | one registration, or `404` |
| `DELETE /api/registrations/:id` | `204`, or `404` |
| `GET /health` | `{ok, upstream: {ok}, indexer: {ok, networkId}, decryptor: {ok, state, version, ledger, restarts, pending, lastError}, registrations: {total, connecting, syncing, synced, error, viewingKeys}}` |

A registration:

```json
{
  "id": "3f1c0a9b8e7d6c5b",
  "solanaAddress": "…",
  "viewingKeyMasked": "mn_shield-esk_un…9ete5h",
  "networkId": "undeployed",
  "createdAt": "2026-10-03T09:00:00.000Z",
  "status": "synced",
  "error": null,
  "lastEventAt": "2026-10-03T09:00:31.000Z",
  "tokens": [
    {"tokenType": "00…00", "mint": "…", "name": "Midnight Test Token", "symbol": "MNTT",
     "decimals": 6, "amount": "250000000000000", "uiAmountString": "250000000", "clamped": false}
  ]
}
```

`id` is the first 16 hex characters of `sha256(solanaAddress + ":" + viewingKey)`.
`amount` is the exact total of that registration; `clamped` says whether the
address's summed total (what the wallet shows) exceeds `u64::MAX`.
Registering, deleting and `config.json` edits are visible to the next RPC call;
new coins from the indexer within about 100 ms.

Note: `GET /health` answers JSON, while a real Solana node answers `GET /health`
with the plain text `ok`.

## Config

`config.json`, with environment variables overriding the file. Relative paths
in the file are relative to the file; relative paths in the environment are
relative to the working directory. Edits to `tokens`, `log` and the token
registry apply without a restart (an invalid edit is logged and the previous
config kept); other keys need a restart.

| Field | Env | Default | Meaning |
|---|---|---|---|
| `upstream` | `UPSTREAM` | required | Real RPC to forward to |
| `upstreamWs` | `UPSTREAM_WS` | derived | Websocket URL of the upstream. Derived as `wss://` on the same host, port +1 if the URL has an explicit port |
| `port` | `PORT` | `8899` | HTTP port. Websockets are accepted here and on `port + 1` (what `@solana/web3.js` expects) |
| `host` | `HOST` | `127.0.0.1` | Bind address |
| `publicUrl` | `PUBLIC_URL` | `http://host:port` | Base URL used for the generated metadata JSON and shown on the page |
| `log` | `LOG` | `true` | Print one line per RPC method: `pass`, `patched` or `local`. `"verbose"` also prints each call's params (truncated to 300 characters) |
| `dataDir` | `DATA_DIR` | `./data` | Where `registrations.json` lives |
| `tokens[]` | | required without `midnight` | Static tokens to inject (below) |
| `midnight.networkId` | `MIDNIGHT_NETWORK_ID` | required | e.g. `undeployed`, `preview`, `preprod`, `mainnet`; viewing keys of other networks are rejected |
| `midnight.indexerHttp` | `MIDNIGHT_INDEXER_HTTP` | required | e.g. `http://127.0.0.1:8088/api/v4/graphql` |
| `midnight.indexerWs` | `MIDNIGHT_INDEXER_WS` | `<indexerHttp>/ws` | e.g. `ws://127.0.0.1:8088/api/v4/graphql/ws` |
| `midnight.decryptorBin` | `DECRYPTOR_BIN` | required | Path to `midnight-esk-decrypt` |
| `midnight.tokenRegistry` | `TOKEN_REGISTRY` | `tokens/tokens.<networkId>.json` if present | Token names and decimals |
| `midnight.reconnectMinMs` / `reconnectMaxMs` | | `1000` / `30000` | Indexer reconnect backoff |
| `midnight.syncMinMs` / `syncQuietMs` | | `10000` / `5000` | Sync rule timings (see the status table) |
| `midnight.decryptorTimeoutMs` | | `30000` | Per-request decryptor timeout |

Set `CONFIG_WATCH=0` to turn off the hot reload.

Each static token:

| Field | Default | Meaning |
|---|---|---|
| `name`, `symbol` | required | Shown in the wallet (max 32 and 10 bytes) |
| `balances` | required | `{ "<wallet address>": "<amount>" }`, amounts in whole tokens, e.g. `"1250.5"` |
| `decimals` | `6` | |
| `program` | `"token"` | `"token"` or `"token-2022"`. Token-2022 also gets the on-mint metadata extension |
| `uri` | served by the proxy | Metadata JSON URL. If omitted, the proxy serves `{name, symbol, description, image}` at `/token-metadata/<symbol>.json` |
| `image`, `description` | | Used for the served metadata JSON |
| `id` | `symbol` | Seed for the mint address. Change it to get a different mint (ids starting with `midnight:` are reserved) |

Mint addresses are derived from a hash of the `id`, so they're stable across
restarts and can never coincide with a real mint. The startup banner prints the
mint and token account addresses.

## What gets changed

| RPC method | Behavior |
|---|---|
| `getTokenAccountsByOwner` | Fake token account appended when the owner and program match. Filtering by the fake mint is answered by the proxy, because the upstream would reject an unknown mint |
| `getAccountInfo` | Answered by the proxy for the fake mint, token accounts and Metaplex metadata account |
| `getMultipleAccounts` | Forwarded, then the fake accounts' slots filled in |
| `getProgramAccounts` | Fake accounts appended when they pass the request's `dataSize`/`memcmp` filters |
| `getTokenAccountBalance`, `getTokenSupply`, `getTokenLargestAccounts` | Answered by the proxy for the fake token |
| everything else, including `sendTransaction` and websocket subscriptions | Passed through untouched |

All encodings are handled (`jsonParsed`, `base64`, `base58`, `base64+zstd` on
Node ≥ 22.15), plus `dataSlice` and JSON-RPC batches. Large integers such as
`rentEpoch` are passed through without precision loss.

## If the token doesn't appear

1. **Watch the log.** If the wallet never calls `getTokenAccountsByOwner` (or
   `getProgramAccounts`) through the proxy, it's reading balances from its own
   backend or an indexer API, and an RPC proxy can't affect it.
2. **Check the hidden/spam list.** Wallets often hide tokens with no price.
3. **Images.** The wallet fetches `image` itself; use a public HTTPS URL.
   Wallets that load images through their own servers can't reach `localhost`.
4. **No USD value** will be shown; prices come from the wallet's own servers.
5. **Midnight tokens:** check the registration's status on the page and
   `GET /health` (indexer and decryptor reachable).

## Code layout

`proxy.js` is the entry point; the code is in `src/`: `config.js`,
`config-watch.js`, `app.js` (wiring), `server.js` and `api.js` (HTTP),
`ws-proxy.js`, `log.js`, `amounts.js`, `rpc/` (planners, handler, encodings,
upstream), `tokens/` (account encoders, token state, static and Midnight
token specs, token registry), `registry/` (store, validation, service),
`midnight/` (decryptor client, indexer watcher, counting rule, coin book),
`web/index.html`.

## Tests

`npm test` (Node ≥ 22, no Docker, no network): the phase-1 checks (a mock
upstream node with the proxy in front, checked through `@solana/web3.js`,
`@solana/spl-token` including Token-2022 metadata, and
`@metaplex-foundation/mpl-token-metadata`), then unit and integration suites
that run the service against a mock Midnight indexer (an in-process GraphQL
`graphql-transport-ws` server) and a fake decryptor
(`test/fixtures/fake-decryptor.js`, which speaks the decryptor's JSON-lines
protocol from a map file). Every test uses random free ports ≥ 10000 and
removes its temp dirs and processes.
