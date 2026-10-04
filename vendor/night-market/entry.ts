// The injector's vendored slice of Night Market (AA 00059, plan decision D1, interface I-V).
//
// Built with Bun 1.3.11 from Night Market's tree as it sits in a Docker volume at /app (PR #1 tree,
// passport submodule PR #6, the light compile of the account by compactc 0.35.0), by ./build.sh:
//
//   bun build /probe/entry.ts --target=node --format=esm \
//     --external @midnight-ntwrk/compact-runtime-0.20 --external @midnightntwrk/ledger-v9 \
//     --outfile /out/night-market-core.mjs
//
// Every export is the Night Market or Passport function of the same name, unchanged: the injector
// runs the page's own coin logic (the page is the oracle). The two external packages are injector
// dependencies at the versions and integrities of Night Market's bun.lock. Nothing here is edited by
// hand after the build; `npm run vendor:check` rebuilds it and compares the SHA-256.

// The account's on-chain state and the market account check (packages/core/src/passport).
export {
  AccountStateDecodeError,
  DEVICE_SCAN_LIMIT,
  checkMarketAccount,
  compareVerifierKeys,
  decodeAccountState,
  networkSaltFor,
} from '/app/packages/core/src/passport/account-chain.ts';
export { PINNED_ACCOUNT_KEYS } from '/app/packages/core/src/passport/pinned-account-keys.ts';
export { PASSPORT_CLIENT_COMMIT } from '/app/packages/core/src/passport/index.ts';
export { ed25519DeviceForKey } from '/app/packages/core/src/passport/ed25519.ts';
export { findUseCounter } from '/app/packages/core/src/passport/gated.ts';
export { predictWithdrawChange } from '/app/packages/core/src/passport/withdraw-change.ts';

// The inbox codec (Passport contract/src/wallet/deposit.ts) and the account's X25519 key.
export {
  generateEncKeyPairPortable,
  openEntryPortable,
  sealEntryPortable,
} from '/app/vendor/passport/contract/src/wallet/deposit.ts';
export { encPublicKeyOf } from '/app/packages/core/src/enc-key.ts';

// Coins: commitments, nullifiers, reconciliation against the history, holdings (packages/core/src).
export {
  confirmedOnChain,
  contractCoinCommitment,
  contractCoinNullifier,
  holdingsByColour,
  reconcileCoins,
} from '/app/packages/core/src/coins.ts';
export { activityOf, historyCovers, mergeAccountTxs } from '/app/packages/core/src/zswap-check.ts';

// The account's complete history as the page reads it (web/src/chain), decoded with ledger-v9.
export {
  AccountHistoryReader,
  HISTORY_DEPLOY_QUERY,
  HISTORY_PAGE,
  HISTORY_PAGE_QUERY,
  HISTORY_SUBSCRIPTION,
  HISTORY_TIP_QUERY,
  txsOfActions,
} from '/app/web/src/chain/history.ts';
export { LedgerDecodeError, decodeAccountTx, decodeEvent } from '/app/web/src/chain/ledger-decode.ts';

// Strict Ed25519 (the relay's verifier) and the texts a Solana wallet signs for Night Market.
export {
  SOLANA_ENVELOPE_PURPOSES,
  isStrictEd25519Key,
  verifyEd25519Strict,
} from '/app/packages/core/src/solana-auth.ts';
export { LABEL_RULE, MARKET_LABELS } from '/app/packages/core/src/market-label.ts';
export {
  ED25519_MESSAGE_BYTES,
  ED25519_SITE_PREFIX,
  assertSafeEd25519Message,
  ed25519PossessionMessage,
  renderEd25519Message,
} from '/app/vendor/passport/contract/src/wallet/ed25519-message.ts';

/** The page's state query (web/src/chain/indexer.ts `STATE_QUERY`, not exported there): copied. */
export const ACCOUNT_STATE_QUERY = `query AccountState($address: HexEncoded!) {
  contract(address: $address) { state }
  block { height }
}`;
