# Provenance of `night-market-core.mjs`

The injector's vendored slice of Night Market (AA 00059, plan decision D1, interface I-V): the page's own coin logic, bundled unchanged so the injector runs exactly what the page runs.

| What | Value |
|---|---|
| Output | `night-market-core.mjs`, sha256 `0aa5d056a8dfea19bf8ddd4b18a46c877d962a40ae3912288796817aba0ef517` (1,773,798 bytes) |
| Entry | `entry.ts`, sha256 `0121fddf3ff8a1535977abf5796a33a6a3d818b1271d66b64f2c26913effeb1e` |
| Night Market | acedward/solana-night-market PR #1 head `10b29b1170f014951f03a1d9613b9b3da4328489` (tree `64b482f695bb2362f5a38f49df9eff6f86efcf0a`, the same tree as `35557f9a8848a6f2afb44eb555288eff1d9176f9`) |
| Passport | `vendor/passport` submodule at acedward/passport PR #6 head `599327b918b55afc95d6c98a89bcd15f4e8b0d53` |
| Account module | Night Market's light compile (`bun run contracts` = `scripts/compile-contracts.sh`): compactc 0.35.0 (debb05f94 2026-09-29), archive `compactc_v0.35.0_aarch64-unknown-linux-musl.zip` sha256 `3f74ec6fc98ccca7365c5c915f6015d8893db4527faafe04a90bc36effc40a3a`; callees with compactc 0.34.0, archive `compactc_v0.34.0_aarch64-unknown-linux-musl.zip` sha256 `d3e292c4f48e257dcd6b3d3e3e4743d7d8ea0729f48953eab91a366d44cd026d`; compile stamp `74756cc31e7dcfecc393f37df50a0175fa73aa7c2e3e41fb7d62ec1169fe8091`; `managed/account/contract/index.js` sha256 `a51ecae28870ee30129b1d6121c42230cca34af819f0b7a5bd1f3948b883ce86`, pinned to `@midnight-ntwrk/compact-runtime-0.20` by `scripts/pin-contract-runtime.mjs`. It differs from the relay key volume's keyed build (`21493588…`, sha256 `ebf5680a…`) only in `expectedVk` (empty here), which nothing in this bundle reads |
| Bundler | Bun 1.3.11 (`oven/bun:1.3.11`, image `sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7`) |
| Command | `bun build /probe/entry.ts --target=node --format=esm --external @midnight-ntwrk/compact-runtime-0.20 --external @midnightntwrk/ledger-v9 --outfile /out/night-market-core.mjs` (cwd `/app` = the Night Market tree in a Docker volume with `node_modules` from `bun install --frozen-lockfile` and the light compile; `/probe` = this directory) |
| External at run time | `@midnight-ntwrk/compact-runtime-0.20` (npm alias of `@midnight-ntwrk/compact-runtime@0.20.0`, integrity `sha512-vtwZ6PiqPy6sUHmXJlrv/3SyjEsKVdQaRroWowTGgu55CJlJXONUplHyst/dRVKe9C6sApveIo2FgbXoBMiMeQ==`), `@midnightntwrk/ledger-v9@1.0.0-rc.3` (`sha512-i/Cl/d2XQ19gIm5SCruMHr+XiruxIn9Ec3i15DrZ/44Yggzu1u5+dG7QUx7Rw1htkgALXivEt7Kw4NzxPr4pBw==`), and through the runtime `@midnightntwrk/onchain-runtime-v4@4.0.0-rc.3` (`sha512-LAf4g3vgwtPqActbi5RAoZcfYduqnFqtsHN+i1s/Mcb5vi2yMbPmpSOJ0YCCIGb2S/qY7G5tQARHVD0PJyHSNA==`, held by `overrides` in `package.json`): the same versions and integrities as Night Market's `bun.lock` |
| Bundled packages | zod 4.6.5, @noble/curves 2.2.0, @noble/hashes 2.2.0, tweetnacl 1.0.3 (NOTICE) |
| Reproduce | `NM_DIR=<checkout> npm run vendor:check` (`build.sh --check`): a fresh volume, the same steps, the same sha256. Built twice on 2026-10-04 with the same sha256 |
| Licence | Apache-2.0 (`LICENSE`, Night Market's and Passport's identical text) and `NOTICE` |

## Exports (I-V)

Each is the Night Market or Passport function of the same name: see `entry.ts` for the module each comes from. `checkMarketAccount`, `AccountStateDecodeError`, `txsOfActions`, the history queries, `LABEL_RULE`, `ED25519_MESSAGE_BYTES` and `ACCOUNT_STATE_QUERY` (a copy of `web/src/chain/indexer.ts`'s unexported `STATE_QUERY`) were added to the plan's I-V list before it was frozen at the end of P0.

## Source files in the bundle

| File | From | Git blob / hash |
|---|---|---|
| `packages/core/src/accounts.ts` | night-market `10b29b1` | blob `2878a535ce9d3dbeb213a7ac72a0e0bd6ea88114` |
| `packages/core/src/amount.ts` | night-market `10b29b1` | blob `00563e7dd65cd15a152242a29d99d8c195b45332` |
| `packages/core/src/api.ts` | night-market `10b29b1` | blob `70b2c3324443947c5dde89e43653fb3f59b796b5` |
| `packages/core/src/auth.ts` | night-market `10b29b1` | blob `d5dbe58c5f8bd2cf6edfdb5bb926f1f31ca8a62d` |
| `packages/core/src/coins.ts` | night-market `10b29b1` | blob `2deae6240f3f129b54813b6b598bbd7e692db53b` |
| `packages/core/src/demo-tokens.ts` | night-market `10b29b1` | blob `b368a19a7a01a1765730ddba3dec410bb458f4c0` |
| `packages/core/src/enc-key.ts` | night-market `10b29b1` | blob `6896227e0527cffff95b846caeed144227552605` |
| `packages/core/src/hex.ts` | night-market `10b29b1` | blob `29c2e5835e8842fa82183962dcbf249ba98f2d01` |
| `packages/core/src/market-label.ts` | night-market `10b29b1` | blob `746ef000dd1516277604ad5f267e85a7ba5284fa` |
| `packages/core/src/market/feed.ts` | night-market `10b29b1` | blob `28f1071c30f3a813cfbfc16e663f31980044423b` |
| `packages/core/src/market/kernel-client.ts` | night-market `10b29b1` | blob `f954d26e5e57938cd115b0e3a47a4490f596c109` |
| `packages/core/src/market/prices.ts` | night-market `10b29b1` | blob `2a0fe1015e09e68d6c00605c11cfb70bc98cc238` |
| `packages/core/src/market/wire.ts` | night-market `10b29b1` | blob `82f111d9808520f6813e605b62583523bd23d990` |
| `packages/core/src/network.ts` | night-market `10b29b1` | blob `1fd7cf5d844e6273f9022651dee5ab6bee9b766c` |
| `packages/core/src/passport/account-chain.ts` | night-market `10b29b1` | blob `bb94fb6c7a66794d14946bd4cb34440f98f04a3f` |
| `packages/core/src/passport/account-provenance.ts` | night-market `10b29b1` | blob `6e29630d260fefeaa02c0dd813a7ac9ee1ed7e12` |
| `packages/core/src/passport/ed25519.ts` | night-market `10b29b1` | blob `fa7caf05be4b951560cd0d2a7be37bab7603a55c` |
| `packages/core/src/passport/gated.ts` | night-market `10b29b1` | blob `9e32d2894e5be869a4e890d0a602b90540935a04` |
| `packages/core/src/passport/index.ts` | night-market `10b29b1` | blob `cb1f0eb83d62eb36de73734d9c892c396594c7b8` |
| `packages/core/src/passport/pinned-account-keys.ts` | night-market `10b29b1` | blob `c5db6c637e7b1713689d36307471787e6cdb651b` |
| `packages/core/src/passport/withdraw-change.ts` | night-market `10b29b1` | blob `636094860fc347702a583b404aa8886f646d98ac` |
| `packages/core/src/signing.ts` | night-market `10b29b1` | blob `bdd2a92df561c2350af84e5f26082be56e0db27b` |
| `packages/core/src/solana-auth.ts` | night-market `10b29b1` | blob `5ad5137150a8ebd54ac67f3ecec51a3b40a169f9` |
| `packages/core/src/tokens/pairs.ts` | night-market `10b29b1` | blob `5d46f2c568e75717851ad83d4f054b9e07865d2a` |
| `packages/core/src/tokens/registry.ts` | night-market `10b29b1` | blob `fa5a8d664d98a02e216c6e3b1264b13acdc7e30c` |
| `packages/core/src/trade.ts` | night-market `10b29b1` | blob `5008ce80da6cca958d48f37cd4337d2c65870ff4` |
| `packages/core/src/unshielded.ts` | night-market `10b29b1` | blob `7b7a8c09a37574bee5a6fac144a37fce59986aa0` |
| `packages/core/src/withdraw-unshielded.ts` | night-market `10b29b1` | blob `07f8b59bbd922f9abaed0dbcfddc260e603afadf` |
| `packages/core/src/zswap-check.ts` | night-market `10b29b1` | blob `4738aee44951ce449c0eb73b3921dce72f92bd69` |
| `vendor/passport/contract/contracts/managed/account/contract/index.js` | generated (light compile) | sha256 `a51ecae28870ee30129b1d6121c42230cca34af819f0b7a5bd1f3948b883ce86` |
| `vendor/passport/contract/src/wallet/contract.ts` | passport `599327b` | blob `62f4e1d96fdb6cc1e4efa73ad93ea9b965786b78` |
| `vendor/passport/contract/src/wallet/deposit.ts` | passport `599327b` | blob `f459d9a597bd5e9851fc2d442746b40321892f60` |
| `vendor/passport/contract/src/wallet/ed25519-message.ts` | passport `599327b` | blob `db6fdca1fc3d41bc1a20db6c22542b743cf879c2` |
| `vendor/passport/contract/src/wallet/ed25519.ts` | passport `599327b` | blob `7fc85cacb0da7e3187c70b2e65217442cb52d048` |
| `vendor/passport/contract/src/wallet/entry-format.ts` | passport `599327b` | blob `3e847fc210f0d955912d00d27d069462138de038` |
| `vendor/passport/contract/src/wallet/hex.ts` | passport `599327b` | blob `4d46769569ec9f2536d54d2f8caac42540d5e005` |
| `web/src/chain/history.ts` | night-market `10b29b1` | blob `500b4d08085220719a5dc39ae9265e4ee30878ea` |
| `web/src/chain/ledger-decode.ts` | night-market `10b29b1` | blob `fe3974ed20b160f7b43554c5b01db8c41d48c34b` |
| `web/src/chain/subscription.ts` | night-market `10b29b1` | blob `56b892a7094189012538286f981d1a1624fb006f` |
