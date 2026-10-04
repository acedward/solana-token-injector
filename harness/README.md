# harness — local Midnight 2.x + Solana test networks (+ the service)

One command brings up a local Midnight 2.x network (node, indexer, proof server in Docker) and a
native `solana-test-validator`, on random free ports, derives a set of Midnight test wallets and
records everything in `harness/.state/run.json`. With `--with-service` it also builds and starts
the solana-token-injector service in the same compose project. Other commands register the wallets
with the service, make a shielded transfer, capture indexer fixtures, run the end-to-end test
(`npm run e2e`) and tear everything down.

## End-to-end test (one command)

```sh
npm ci && npm run harness:install      # once
npm run e2e                            # up --with-service, gates E1-E9, down (always)
npm run e2e -- --report /tmp/e2e.json --screenshot /tmp/e2e-page   # + JSON report, page screenshot
```

It builds `s00056/service:<run-id>` (`docker build --pull=false`), brings everything up, registers
genesis-1..3 and fresh-1 with fresh Solana keypairs through `POST /api/registrations`, then checks
(PASS/FAIL per gate on stderr, JSON report on stdout; exit 1 on any FAIL):

| Gate | Check |
|---|---|
| E3 | invalid Solana address / malformed key / wrong-network key / shielded address → 400, nothing stored; the same pair twice → 200, one registration |
| E1 | each registered wallet's injected Token-2022 amounts (`getTokenAccountsByOwner`, jsonParsed, through the service) == its wallet SDK balances, per token type; mint name/symbol/decimals == `tokens/tokens.undeployed.json`; nothing under the classic Token program; the API shows the same amounts |
| E5 | an unregistered address: the service's answer is byte-identical to the validator's (both token programs) |
| E6 | `spl-token accounts --owner <genesis-2's address>` lists the three mints with the SDK amounts; `spl-token display <mint>` shows the Token-2022 name/symbol (throwaway CLI config, never `~/.config/solana`) |
| E2 | shielded transfer genesis-1 → fresh-1 (1234567 of `00…01`): fresh-1's injected amount == 1234567, at most 30 s after the wallet SDK sees the coin (and polled for at most 60 s after `submitTransaction(…, 'Finalized')` returns), no container restart |
| E9 | (informative) genesis-1's injected `00…01` total = its previous total + its change coin (viewing keys cannot see spends, Q3) |
| E4 | `DELETE` genesis-3's registration → its tokens are gone on the very next call (answer = the validator's) |
| E7 | `docker compose restart service` → same registration ids, totals rebuilt |
| X1 | the service's log never contains a full viewing key (FR-104) |
| E8 | after `down`: no containers/volumes/networks of the project, validator PID gone, ports free, image tag removed |

Every wait polls the service's own RPC/API answers with a timeout of at most 60 s; the `synced`
badge is never a precondition (see "Known limits"). About 2 minutes.

## Try it by hand (web page + a wallet)

```sh
node harness/cli.mjs up --with-service --register    # prints the page/RPC URL and every wallet
# open the printed "Open the page" URL: the table lists the four registrations and their amounts
node harness/cli.mjs register --wallet genesis-2 --solana-address <your Nightly address>   # optional
node harness/cli.mjs transfer --from genesis-1 --to fresh-1 --token 0000000000000000000000000000000000000000000000000000000000000001 --amount 1234567
node harness/cli.mjs down                            # always; removes containers, volumes, validator, image tag
```

`--register` registers each wallet's viewing key with a fresh Solana keypair; the keypairs (local
test keys) are in `harness/.state/run.json` (`wallets[].solana.secretKeyBase58`, importable in
Nightly as a private key). In Nightly: Developer Mode → Custom Solana RPC → the printed RPC URL
(`http://127.0.0.1:<port>`). The service's websockets are on that port + 1.

## Requirements

- Node ≥ 22 (tested with 24.9.0); `npm --prefix harness install` once.
- Docker with these images **already present** (`pull_policy: never`; nothing is pulled):
  - `midnightntwrk/midnight-node@sha256:caf93d6f9fb3630c906ef3e714c151655377f3d28f907d17545de1870514da2e` (2.0.0-rc.4, arm64)
  - `midnightntwrk/indexer-standalone@sha256:5d79f3a20da9ed86236c7f7dc9d93b1beeb0b0c47c9c43a791041322eb80b74e` (4.4.0-rc.1, amd64; runs emulated on arm64)
  - `midnightntwrk/proof-server:9.0.0-rc.6`
- `solana-test-validator` on `PATH` (tested with 2.3.13).

## Commands

All commands print logs to stderr and one JSON result to stdout.

| Command | What it does |
|---|---|
| `node harness/cli.mjs up [--with-service [--register]]` | `--with-service` first builds `s00056/service:<run-id>` from the repo's `Dockerfile` (`--pull=false`; needs `oven/bun:1.3.11` locally) and, after the validator is up, starts it (`compose.service.yml`, profile `service`) and waits for `GET /health` → `ok: true`; `--register` then registers every wallet (see `register`). Without `--with-service`: Midnight + validator only, as below. Preflight: the three images are present and `solana-test-validator` runs. Refuses if a state file exists, another `s00056-*` compose project exists, or another Midnight node/indexer container is running (`--allow-other-midnight` overrides). Picks free ports ≥ 10000, writes `harness/.env`, `docker compose -p s00056-<random> up -d`, waits for node block #1, indexer `GET /ready`, the indexer's first post-genesis block, and proof server `GET /version`, starts the validator (temp ledger dir, PID recorded), waits for `GET /health` = `ok` and a `slotSubscribe` answer on the websocket (rpc port + 1), derives the wallets, checks the indexer accepts each viewing key (`connect`), queries each wallet's SDK balances, writes `harness/.state/run.json`. A failure tears the partial stack down (unless `--keep-on-failure`; `HARNESS_TEST_FAIL_AT=wallets` forces one, for testing that path). About 15–20 s. |
| `node harness/cli.mjs register [--wallet <name>] [--solana-address <addr>]` | Registers wallets with the running service: each viewing key with a fresh Solana keypair (kept in the state file), or `--wallet` with your own `--solana-address`. |
| `node harness/cli.mjs e2e [--report <file>] [--screenshot <dir>] [--keep]` | The end-to-end test above. `--report` also writes the service image build log and the service container log next to the report; `--screenshot` saves `page.png` (headless Chrome, `CHROME_BIN` to override), `api-registrations.json`, `health.json` and `get-root.html` while all four registrations hold amounts; `--keep` skips the teardown (and E8). |
| `node harness/cli.mjs status` | State file + container states + validator liveness. |
| `node harness/cli.mjs balances [--wallet <name>]` | Re-query the SDK balances (standard shielded wallet, full sync) and update the state file. |
| `node harness/cli.mjs dust [--wallet genesis-1]` | Wallet-facade view of one wallet: shielded, unshielded NIGHT, DUST balance and coins. |
| `node harness/cli.mjs transfer --from <w> --to <w> --token <64 hex> --amount <n>` | Shielded transfer with the wallet facade (fees in DUST, proof by the local proof server), then waits until the receiver's SDK balance shows it. Retries (rebuilding the wallet) for up to 300 s while fee balancing reports insufficient funds. Marks the sender `spentAnything`. About 20 s. |
| `node harness/cli.mjs fixtures [--wallet <name>] [--out <dir>]` | Per wallet: indexer `connect(viewingKey)` + `shieldedTransactions(sessionId, index: 0)` until caught up, then writes `<dir>/<wallet>.json` (default `harness/fixtures/undeployed/`, the committed set; use `--out` to avoid overwriting it) in the master plan I-3 format. About 15 s per wallet. |
| `node harness/cli.mjs down [--all]` | `docker compose --profile service down -v --remove-orphans` (also the service and its data volume), removes the run's `s00056/service:<run-id>` tag, kills the validator's process group, deletes its temp dir, `.state/` and `.env`, then checks nothing is left (containers, volumes, networks with the project label; validator PID; ports) and prints `clean: true/false`. `--all` also removes every other `s00056-*` project. |
| `node harness/cli.mjs wallets [--seed <hex>]` | Offline: derive viewing keys and shielded addresses. |
| `node harness/cli.mjs check-vk` | Offline: the viewing-key derivation against the node toolkit's known answers (exit 1 on mismatch). |

## Wallets

Derivation (the wallet SDK's; identical to the node toolkit's `show-viewing-key`): 32-byte seed →
HD `m/44'/2400'/0'/3/0` → `ZswapSecretKeys.fromSeed` → viewing key = bech32m
`mn_shield-esk_undeployed1…` of the encryption secret key; shielded address =
`mn_shield-addr_undeployed1…` of (coin public key, encryption public key).

| Name | Seed | Holds on a fresh chain (SDK balances, base units) |
|---|---|---|
| `genesis-1` | `00…01` | shielded `00…00` = 250000000000000, `00…01` = 50000000000000, `00…02` = 50000000000000; unshielded NIGHT 250000000000000; DUST for fees |
| `genesis-2` | `00…02` | same shielded amounts as genesis-1 |
| `genesis-3` | `00…03` | same shielded amounts as genesis-1 |
| `fresh-1` | random per `up` (in the state file) | nothing |

All three genesis wallets' coins come from one genesis transaction (hash `0d60ae23…`), relevant to
all three viewing keys. Viewing keys for the fixed seeds:

- genesis-1 `mn_shield-esk_undeployed1dlyj7u8juj68fd4psnkqhjxh32sec0q480vzswg8kd485e2kljcs9ete5h`
- genesis-2 `mn_shield-esk_undeployed1w0dctw9zhe2ffqw4s5qks7rnl29wy5mhl957fv9nnhtxulent80q5t9mydg`
- genesis-3 `mn_shield-esk_undeployed1wvd5v04ykt59gglxknsdxpwwkhhhj8d6h3ghpkgdhdsszap2p53qkzr6qn2`

These are local `undeployed` test keys only.

## Files

- `harness/.env`, `harness/.state/run.json` — per run, gitignored, removed by `down`. The state file
  format is master plan I-2 (plus `midnight` versions, `validator.{dir,logFile,args,version}`,
  `transfers`, per-wallet `indexerAcceptsViewingKey` and `spentAnything`).
- `harness/fixtures/undeployed/*.json` — committed indexer fixtures (master plan I-3) captured after a
  1234567 transfer of type `00…01` from genesis-1 to fresh-1: genesis-1 has 2 relevant transactions
  (genesis + the transfer with its change), genesis-2/3 have 1, fresh-1 has 1. The fresh-1 seed in
  its fixture is the random seed of that run.
- Validator log: `<validator.dir>/validator.log` while the stack is up.
- `harness/compose.service.yml` — the service (profile `service`, same compose project): indexer at
  `indexer:8088` inside the network, the validator through `host.docker.internal`, data on the
  `service-data` volume, published on `127.0.0.1:<service>` (+1 for websockets).
- `harness/lib/e2e.mjs` — gates E1–E7, E9, X1; `harness/lib/service.mjs` — API/RPC helpers.

## Known limits

- **The Solana test validator's RPC, websocket and faucet listen on all interfaces** (`*:<port>`),
  not only 127.0.0.1: `solana-test-validator 2.3.13` has no option for it (`--bind-address` covers
  gossip/TPU only). The Midnight containers publish on 127.0.0.1 only. Keep runs short; `down`
  kills it (questions file Q20).
- The indexer image is amd64-only and runs under emulation; it is fine for this tiny chain.
- One Midnight stack at a time on this host (`up` refuses otherwise). `mem_limit`s: node 4 GB,
  indexer 6 GB, proof server 8 GB.
- The indexer's shielded-transactions progress is not a per-wallet "caught up" signal:
  `highestCheckedEndIndex` is the maximum over all wallets, and progress is cached for up to 5 s, so
  right after the first `connect` of a key it can report `highestRelevantEndIndex: 0` while relevant
  transactions are still coming. `fixtures` waits ≥ 12 s and for `highestRelevantEndIndex` to equal
  the highest end index delivered. The harness sets the progress interval to 2 s
  (`INDEXER_PROGRESS_INTERVAL`, default in the image: 30 s).
- `transactionResult.segments` is `null` for these `SUCCESS` transactions.
- A viewing key sees received coins only (questions file Q3): genesis-1's fixture contains its
  original coins and its change, not its spend.
- DUST for fees is valued at the latest block the INDEXER has (`blockData.timestamp`), not the system
  clock. The genesis block's timestamp is 2025-08-05 and the indexer follows finalized blocks
  (~2 behind, 6 s blocks), so until it indexes block #1 the genesis wallets have zero usable DUST
  ("Insufficient Funds: could not balance dust") even though `dust` (system clock) shows
  1.25·10²⁴. `up` therefore waits for indexer height ≥ 1.
- The genesis transaction is deterministic: its hash and raw bytes are identical on every fresh
  chain; transfer transactions differ per run.
- DUST: after paying 275386941611635 for the transfer, genesis-1's DUST balance still read
  1250000000000000000000000 (UNVERIFIED why; probably the generation cap is reached again at once).
