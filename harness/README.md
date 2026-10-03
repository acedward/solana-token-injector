# harness — local Midnight 2.x + Solana test networks

One command brings up a local Midnight 2.x network (node, indexer, proof server in Docker) and a
native `solana-test-validator`, on random free ports, derives a set of Midnight test wallets and
records everything in `harness/.state/run.json`. Other commands make a shielded transfer, capture
indexer fixtures and tear everything down.

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
| `node harness/cli.mjs up` | Preflight: the three images are present and `solana-test-validator` runs. Refuses if a state file exists, another `s00056-*` compose project exists, or another Midnight node/indexer container is running (`--allow-other-midnight` overrides). Picks free ports ≥ 10000, writes `harness/.env`, `docker compose -p s00056-<random> up -d`, waits for node block #1, indexer `GET /ready` and proof server `GET /version`, starts the validator (temp ledger dir, PID recorded), waits for `GET /health` = `ok` and a `slotSubscribe` answer on the websocket (rpc port + 1), derives the wallets, checks the indexer accepts each viewing key (`connect`), queries each wallet's SDK balances, writes `harness/.state/run.json`. A failure tears the partial stack down (unless `--keep-on-failure`; `HARNESS_TEST_FAIL_AT=wallets` forces one, for testing that path). About 11–13 s. |
| `node harness/cli.mjs status` | State file + container states + validator liveness. |
| `node harness/cli.mjs balances [--wallet <name>]` | Re-query the SDK balances (standard shielded wallet, full sync) and update the state file. |
| `node harness/cli.mjs dust [--wallet genesis-1]` | Wallet-facade view of one wallet: shielded, unshielded NIGHT, DUST balance and coins. |
| `node harness/cli.mjs transfer --from <w> --to <w> --token <64 hex> --amount <n>` | Shielded transfer with the wallet facade (fees in DUST, proof by the local proof server), then waits until the receiver's SDK balance shows it. Marks the sender `spentAnything`. About 20 s. |
| `node harness/cli.mjs fixtures [--wallet <name>]` | Per wallet: indexer `connect(viewingKey)` + `shieldedTransactions(sessionId, index: 0)` until caught up, then writes `harness/fixtures/undeployed/<wallet>.json` (master plan I-3). About 15 s per wallet. |
| `node harness/cli.mjs down [--all]` | `docker compose down -v --remove-orphans`, kills the validator's process group, deletes its temp dir, `.state/` and `.env`, then checks nothing is left (containers, volumes, networks with the project label; validator PID; ports) and prints `clean: true/false`. `--all` also removes every other `s00056-*` project. |
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
- DUST: after paying 275386941611635 for the transfer, genesis-1's DUST balance still read
  1250000000000000000000000 (UNVERIFIED why; probably the generation cap is reached again at once).
