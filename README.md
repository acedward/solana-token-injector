# solana-token-injector

A Solana JSON-RPC proxy for wallets that accept a custom RPC (Backpack, Nightly).
Every call goes to a real upstream node untouched, except the few a wallet uses
to find and display SPL tokens. Those get synthetic accounts merged in, so a
token you define in `config.json` shows up next to your real balances.

It is **display only**. The token's accounts don't exist on chain, so sending
it, swapping it, or anything else that touches it will fail simulation.
Everything else (real SOL, real tokens, real transactions) works normally,
because those calls pass straight through.

## Quick start

```bash
npm install
cp config.example.json config.json   # put your wallet address in "balances"
npm start
```

Then in the wallet:

- **Backpack**: Settings → Preferences → Solana → RPC Connection → Custom → `http://127.0.0.1:8899`
- **Nightly**: turn on Developer Mode, then pick Custom as the Solana RPC endpoint

Set `upstream` to the cluster the wallet should otherwise behave like
(devnet for testing, or a mainnet RPC URL from your provider).

## Config

| Field | Default | Meaning |
|---|---|---|
| `upstream` | required | Real RPC to forward to |
| `upstreamWs` | derived | Websocket URL of the upstream. Derived as `wss://` on the same host, port +1 if the URL has an explicit port |
| `port` | `8899` | HTTP port. Websockets are accepted here and on `port + 1` (what `@solana/web3.js` expects) |
| `host` | `127.0.0.1` | Bind address |
| `publicUrl` | `http://host:port` | Base URL used for the generated metadata JSON |
| `log` | `true` | Print one line per RPC method: `pass`, `patched` or `local`. `"verbose"` also prints each call's params (truncated to 300 characters) |
| `tokens[]` | required | Tokens to inject (below) |

Each token:

| Field | Default | Meaning |
|---|---|---|
| `name`, `symbol` | required | Shown in the wallet (max 32 and 10 bytes) |
| `balances` | required | `{ "<wallet address>": "<amount>" }`, amounts in whole tokens, e.g. `"1250.5"` |
| `decimals` | `6` | |
| `program` | `"token"` | `"token"` or `"token-2022"`. Token-2022 also gets the on-mint metadata extension |
| `uri` | served by the proxy | Metadata JSON URL. If omitted, the proxy serves `{name, symbol, description, image}` at `/token-metadata/<symbol>.json` |
| `image`, `description` | | Used for the served metadata JSON |
| `id` | `symbol` | Seed for the mint address. Change it to get a different mint |

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

## Tests

`npm test` starts a mock upstream node and runs the proxy in front of it,
then checks the injected data through `@solana/web3.js`, `@solana/spl-token`
(including Token-2022 metadata) and `@metaplex-foundation/mpl-token-metadata`.
