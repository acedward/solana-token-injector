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
- **Passport account balances** (Night Market accounts): the wallet that controls
  a Night Market account registers it with one signature ("Show in my wallet"
  on Night Market), and sees the account's exact balances, shielded and
  unshielded, as Token-2022 tokens. See [Passport accounts](#passport-accounts-night-market).

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
An optional `unshielded` object (same shape as `tokens`) names unshielded token
types (Passport accounts' public balances). Other top-level fields (a `note`,
say) are ignored.

A file generated from Night Market's token list loads unchanged through
`TOKEN_REGISTRY` (or `midnight.tokenRegistry`): one entry per Midnight token
type with its real decimals and an icon, for example

```json
{
  "network": "undeployed",
  "tokens": {
    "<twBTC's 64-hex type>": { "name": "twBTC (Midnight)", "symbol": "twBTC", "decimals": 8,
                              "image": "https://…/twbtc.png" },
    "<twUSDC's 64-hex type>": { "name": "twUSDC (Midnight)", "symbol": "twUSDC", "decimals": 6,
                               "image": "https://…/twusdc.png" }
  }
}
```

With 8 decimals, 10,000,000 base units of twBTC show as 0.1. A type the file
does not name falls back to 6 decimals and a generated name, so every token
Night Market can hold should be listed.

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

## Passport accounts (Night Market)

A Night Market account is a Passport contract on Midnight that holds shielded
coins without any wallet: each deposit files a 192-byte note in the account's
inbox, sealed to the account's X25519 key. With that key's secret (the
**account viewing key**) the service computes the account's **exact** balance
with Night Market's own page code, and shows it in the Solana wallet that
controls the account. The viewing key opens notes; it cannot spend (every spend
needs the wallet's Ed25519 signature).

### How an account gets registered

Night Market's "Show in my wallet" does it, in one wallet prompt:

1. it reads `GET /api/accounts/registration-info` (this service's origin,
   network and the longest expiry it accepts);
2. it renders the registration text itself from the fixed template below and
   the wallet signs it;
3. it posts `{solanaAddress, accountAddress, accountViewingKey, message, signature}`
   to `POST /api/accounts`.

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

The service checks, before it stores anything: the text is exactly this
template, for this service's origin and network, not expired and at most 10
minutes ahead; the signature is the wallet's (strict Ed25519); the account is a
Night Market Passport account (the pinned verifier keys, its maintenance
authority retired, activated, this network's salt); the wallet is the
account's device; and the viewing key opens the account's current encryption
key. The full contract, with every error code, is
[`docs/account-registration.md`](docs/account-registration.md) (frozen; vectors
in `docs/account-registration-vectors.json`). The text authorises nothing on
chain: no Passport circuit verifies it, and its first line can never be the
first line of a Passport approval or of Night Market's proof-of-possession
envelope.

Registering again is idempotent. Registering with a new viewing key (after the
account's key was rotated) keeps the old keys too, so notes sealed to them
still open. There is no `DELETE` in v1: an operator removes a registration
from `<dataDir>/accounts.json` while the service is stopped.

### What the wallet shows

One Token-2022 token per Midnight token type the account holds:

- shielded types use the same mint as the viewing-key path
  (`midnight:<networkId>:<64-hex type>`);
- unshielded balances (the account's public balances) get their own mints
  (`midnight:<networkId>:u:<64-hex type>`, default name
  `Midnight unshielded <8 hex>`, symbol `MU<4 hex>`), so a shielded and an
  unshielded type with the same bytes are never merged;
- a wallet that has viewing-key registrations and accounts sees the sum per
  token type.

A coin counts only when its leaf is on chain (a note anyone can file with a
false description counts nothing), and it is spent when its nullifier is.

The account is followed by polling the indexer (`midnight.accounts.pollMs`,
5 s by default). On Night Market's localnet a swap and the filing of a
withdrawal's change showed in the wallet's RPC answers 15–18 s after their
block (the indexer follows finalized blocks; the requirement is 60 s).

| Status | Meaning | Amounts served |
|---|---|---|
| `syncing` | registered; nothing computed yet | none (or the last saved amounts after a restart) |
| `synced` | the last poll read the state and the account's complete history | current |
| `incomplete` | the history could not be read completely (reason in `error`) | computed from what was read |
| `stale-key` | the account's encryption key changed to one this service was never given; register again with the new key (it clears by itself if the key changes back) | frozen at the last computation |
| `error` | the last poll failed (indexer down, …) | frozen at the last computation, also across a restart |

The registration view (`GET /api/accounts/:id`) also reports:

- `unseenCoins`: coins of the account on chain that no inbox note describes.
  **A hint, not proof of a pending withdrawal.** The usual cause is a
  withdrawal's change that Night Market has not filed in the inbox yet (it
  files it right after the withdrawal with a second prompt); until it is filed,
  the wallet shows the account's balance minus that change. A third party's
  deposit under a note that does not describe it (a counterfeit note) raises
  it too, and that coin is never counted.
- `unconfirmedNotes`: inbox notes whose coin is not on chain (a counterfeit
  note, or a deposit not indexed yet). They count nothing.
- `unreadableEntries`: notes none of the registration's keys opens.

### Bridged tokens

With a journey token registry (`midnight.journeyRegistry`,
`journey-tokens.<network>.json`, written by the Solana ↔ Midnight bridge
tooling), a Midnight token type that is the Midnight half of an SPL token is
named after it: `"<name> (Midnight)"`, symbol `mn<symbol>` (never the SPL
symbol), the SPL mint's decimals. The real SPL token passes through untouched.
At start the service checks the file against the upstream: the Solana genesis
hash, and each SPL mint exists, is a classic SPL Token mint and has the listed
decimals (it retries for up to 60 s while the upstream is unreachable, then
exits). An invalid edit of the file while running is logged and the previous
file kept.

Icons: an entry may carry `image` (the icon of "<name> (Midnight)", used when
the token registry file gives that type none) and `splImage` (the icon of the
real SPL token). Both are optional `https` URLs of at most 200 bytes; other
fields of an entry are ignored.

```json
{"colour": "<64 hex>", "splMint": "<base58>", "bridgeContract": "<64 hex>",
 "name": "X", "symbol": "X", "decimals": 6,
 "image": "https://…/x-midnight.png", "splImage": "https://…/x.png"}
```

**Metadata fill-in for the real SPL tokens.** A local or new SPL mint often has
no Metaplex metadata account, and wallets then show only its address. For the
SPL mints the journey token registry lists, and **only when the upstream says
the mint's Metaplex metadata account does not exist**, the RPC answers that
account itself (`getAccountInfo` and `getMultipleAccounts`): name and symbol
from the registry entry, a `uri` pointing at this service's
`/token-metadata/spl:<mint>.json`, whose `image` is the entry's `splImage`.
It never touches the mint, its token accounts or balances, and a mint that has
real metadata upstream gets the upstream's answer byte for byte (the request is
forwarded unchanged and its answer is rewritten only for an account the
upstream reports as missing). This is the one place the injector shows data
for a real token that is not on chain (the owner's choice, 2026-10-05); remove
the mint from the registry to turn it off.

**Wallet caching:** Nightly loads a newly appeared token's name and icon only
after it is reopened (seen in the owner's session on 2026-10-05): after a
registration, a new bridged token or a registry edit, close and reopen the
wallet (or switch its RPC away and back) to see the new names and icons.

### Turning it off

The account source is **on by default** whenever `midnight` is configured. It
adds the `/api/accounts…` routes, an `accounts` block in `/health`, and the
file `<dataDir>/accounts.json` once an account registers. Set
`ACCOUNTS_ENABLED=0` (or `midnight.accounts.enabled: false`) to turn it off:
every account route then answers `503 accounts-disabled` and the service
behaves exactly as without it.

### Limits (v1)

- **Not private**: the service stores the account viewing keys and shows what
  they reveal, like the viewing-key registrations.
- Accounts with more than one device are not supported (Night Market accounts
  have one).
- The coin logic is Night Market's, vendored as a reproducible bundle in
  `vendor/night-market/` (`PROVENANCE.md`; `NM_DIR=<checkout> npm run vendor:check`
  rebuilds it and compares the SHA-256).

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
| `dataDir` | `DATA_DIR` | `./data` | Where `registrations.json` and `accounts.json` live |
| `tokens[]` | | required without `midnight` | Static tokens to inject (below) |
| `midnight.networkId` | `MIDNIGHT_NETWORK_ID` | required | e.g. `undeployed`, `preview`, `preprod`, `mainnet`; viewing keys of other networks are rejected |
| `midnight.indexerHttp` | `MIDNIGHT_INDEXER_HTTP` | required | e.g. `http://127.0.0.1:8088/api/v4/graphql` |
| `midnight.indexerWs` | `MIDNIGHT_INDEXER_WS` | `<indexerHttp>/ws` | e.g. `ws://127.0.0.1:8088/api/v4/graphql/ws` |
| `midnight.decryptorBin` | `DECRYPTOR_BIN` | required | Path to `midnight-esk-decrypt` |
| `midnight.tokenRegistry` | `TOKEN_REGISTRY` | `tokens/tokens.<networkId>.json` if present | Token names and decimals |
| `midnight.reconnectMinMs` / `reconnectMaxMs` | | `1000` / `30000` | Indexer reconnect backoff |
| `midnight.syncMinMs` / `syncQuietMs` | | `10000` / `5000` | Sync rule timings (see the status table) |
| `midnight.decryptorTimeoutMs` | | `30000` | Per-request decryptor timeout |
| `midnight.accounts.enabled` | `ACCOUNTS_ENABLED` | `true` | Passport account registrations (`0`/`false` turns them off) |
| `midnight.accounts.pollMs` | `ACCOUNTS_POLL_MS` | `5000` | How often each account is read |
| `midnight.accounts.maxConcurrent` | `ACCOUNTS_MAX_CONCURRENT` | `4` | Accounts read at the same time |
| `midnight.accounts.maxTtlSeconds` | `ACCOUNTS_MAX_TTL_S` | `600` | The longest a registration text may be valid |
| `midnight.accounts.keySetFile` | `ACCOUNTS_KEY_SET_FILE` | the vendored pinned set | The accepted account verifier keys, `{"circuits": {<circuit>: <64 hex>}}` |
| `midnight.journeyRegistry` | `JOURNEY_REGISTRY` | none | Journey token registry (bridged token names); reloaded when it changes |
| `midnight.journeyCheckDeadlineMs` | | `60000` | How long the start-up check waits for an unreachable upstream |

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
| `getAccountInfo` | Answered by the proxy for the fake mint, token accounts and Metaplex metadata account. For the Metaplex metadata account of a journey-registry SPL mint: forwarded, and filled in only when the upstream says it does not exist |
| `getMultipleAccounts` | Forwarded, then the fake accounts' slots filled in (and a registry SPL mint's missing metadata account) |
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
`accounts/` (registration text, checks, errors, store, account watcher,
service, API, the bundle loader), `tokens/display.js` and
`tokens/journey-registry.js` (bridged names), `web/index.html`.
`vendor/night-market/` holds the vendored Night Market bundle;
`tools/account-balance.mjs` prints an account's exact balance from the command
line (the same code).

## Tests

`npm test` (Node ≥ 22, no Docker, no network): the phase-1 checks (a mock
upstream node with the proxy in front, checked through `@solana/web3.js`,
`@solana/spl-token` including Token-2022 metadata, and
`@metaplex-foundation/mpl-token-metadata`), then unit and integration suites
that run the service against a mock Midnight indexer (an in-process GraphQL
`graphql-transport-ws` server) and a fake decryptor
(`test/fixtures/fake-decryptor.js`, which speaks the decryptor's JSON-lines
protocol from a map file). Every test uses random free ports ≥ 10000 and
removes its temp dirs and processes. The account suites run Night Market's
own account states and recorded localnet answers (`test/fixtures/nm/`,
`test/fixtures/nm-localnet/`) through the same mock indexer.

`NM_DIR=<solana-night-market checkout> npm run e2e:accounts` runs the account
gates end to end on Night Market's own localnet (`harness/nm/gate.mjs --mode e2e`:
the injector image in Night Market's compose project, a native
`solana-test-validator`, two accounts registered through the API, compared with
Night Market's page code after deposits, a swap, withdrawals and a key
rotation). It needs Docker with the images already present (nothing is pulled),
the Night Market app volume and the relay's key volume (see the script's
header), and takes the shared stack lock `~/.aa-00057-stack.lock`.
`bash scripts/secret-scan.sh` runs gitleaks over the history and the tree
before a push.
