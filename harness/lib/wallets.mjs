// Midnight 2.x test wallets for the 00056 harness.
//
// Derivation (the wallet SDK's, verified against the node toolkit's known answer, gate A2):
//   32-byte seed --HD m/44'/2400'/0'/<role>/0 (wallet-sdk-hd)--> role key
//   Zswap role key --ZswapSecretKeys.fromSeed--> coin + encryption keys
//   viewing key  = bech32m `mn_shield-esk_<network>1...` of the encryption secret key
//   shielded addr = bech32m `mn_shield-addr_<network>1...` of (coin public key, encryption public key)
//
// The SDK oracle (`sdkBalances`) runs the standard shielded wallet with the full secret keys and
// returns its `balances` (spend-aware). The transfer helper uses the wallet facade (shielded +
// unshielded + dust) because fees are paid in DUST.

import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import * as Rx from 'rxjs';
import { DustSecretKey, LedgerParameters, ZswapSecretKeys } from '@midnightntwrk/ledger-v9';
import { HDWallet, Roles } from '@midnightntwrk/wallet-sdk-hd';
import {
  MidnightBech32m,
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
  ShieldedEncryptionSecretKey,
} from '@midnightntwrk/wallet-sdk-address-format';
import { ShieldedWallet } from '@midnightntwrk/wallet-sdk-shielded';
import { WalletFacade } from '@midnightntwrk/wallet-sdk-facade';
import { DustWallet } from '@midnightntwrk/wallet-sdk-dust-wallet';
import { UnshieldedWallet, createKeystore, PublicKey } from '@midnightntwrk/wallet-sdk-unshielded-wallet';
import { InMemoryTransactionHistoryStorage, TransactionHistoryStorage } from '@midnightntwrk/wallet-sdk-abstractions';

export const NETWORK_ID = 'undeployed';

/** The fixed test wallets. `fresh-1` gets a random seed at `up` time. */
export const FIXED_WALLETS = [
  { name: 'genesis-1', seedHex: '00'.repeat(31) + '01' },
  { name: 'genesis-2', seedHex: '00'.repeat(31) + '02' },
  { name: 'genesis-3', seedHex: '00'.repeat(31) + '03' },
];

export const newFreshSeedHex = () => randomBytes(32).toString('hex');

/** HD-derive the 32-byte key for `role` at m/44'/2400'/0'/<role>/0. */
export function deriveRoleKey(seedHex, role) {
  if (!/^[0-9a-f]{64}$/i.test(seedHex)) throw new Error(`seed must be 64 hex chars, got ${seedHex.length}`);
  const hd = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
  if (hd.type !== 'seedOk') throw new Error(`HDWallet.fromSeed failed: ${hd.type}`);
  const res = hd.hdWallet.selectAccount(0).selectRole(role).deriveKeyAt(0);
  if (res.type !== 'keyDerived') throw new Error(`HD derivation failed for role ${role}: ${res.type}`);
  const key = Buffer.from(res.key);
  hd.hdWallet.clear();
  return key;
}

export const zswapSeedOf = (seedHex) => deriveRoleKey(seedHex, Roles.Zswap);
export const zswapKeysOf = (seedHex) => ZswapSecretKeys.fromSeed(zswapSeedOf(seedHex));

/** Viewing key = bech32m-encoded zswap encryption secret key. */
export function viewingKeyOf(seedHex, networkId = NETWORK_ID) {
  const keys = zswapKeysOf(seedHex);
  return ShieldedEncryptionSecretKey.codec
    .encode(networkId, new ShieldedEncryptionSecretKey(keys.encryptionSecretKey))
    .asString();
}

export function shieldedAddressObjOf(seedHex) {
  const keys = zswapKeysOf(seedHex);
  return new ShieldedAddress(
    new ShieldedCoinPublicKey(Buffer.from(keys.coinPublicKey, 'hex')),
    new ShieldedEncryptionPublicKey(Buffer.from(keys.encryptionPublicKey, 'hex')),
  );
}

export function shieldedAddressOf(seedHex, networkId = NETWORK_ID) {
  return MidnightBech32m.encode(networkId, shieldedAddressObjOf(seedHex)).asString();
}

/** Everything about a wallet that needs no network. */
export function describeWallet({ name, seedHex }, networkId = NETWORK_ID) {
  return {
    name,
    seedHex,
    viewingKey: viewingKeyOf(seedHex, networkId),
    shieldedAddress: shieldedAddressOf(seedHex, networkId),
  };
}

const bigintMapToStrings = (m) =>
  Object.fromEntries(Object.entries(m ?? {}).map(([k, v]) => [k, v.toString()]).sort(([a], [b]) => a.localeCompare(b)));

function shieldedConfig(urls, networkId) {
  return {
    networkId,
    indexerClientConnection: { indexerHttpUrl: urls.indexerHttp, indexerWsUrl: urls.indexerWs },
    txHistoryStorage: new InMemoryTransactionHistoryStorage(TransactionHistoryStorage.TransactionHistoryEntryCommonSchema),
  };
}

const withTimeout = (p, ms, what) =>
  Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: timeout after ${ms} ms`)), ms).unref()),
  ]);

/**
 * SDK oracle: run the standard shielded wallet for `seedHex` against the stack, wait until it is
 * fully synced (and, if `until` is given, until `until(balances)` is true), return
 * `{ <64-hex token type>: <decimal string> }`, stop the wallet.
 */
export async function sdkBalances(seedHex, urls, { networkId = NETWORK_ID, timeoutMs = 300_000, until } = {}) {
  const wallet = ShieldedWallet(shieldedConfig(urls, networkId)).startWithSeed(zswapSeedOf(seedHex));
  try {
    await wallet.start(zswapKeysOf(seedHex));
    const state = await withTimeout(
      Rx.firstValueFrom(
        wallet.state.pipe(
          Rx.filter((s) => s.progress.isStrictlyComplete()),
          Rx.filter((s) => (until ? until(bigintMapToStrings(s.balances)) : true)),
        ),
      ),
      timeoutMs,
      'shielded wallet sync',
    );
    return bigintMapToStrings(state.balances);
  } finally {
    await wallet.stop().catch(() => {});
  }
}

// ---- wallet facade (shielded + unshielded + dust), for transfers -------------------------------

const DUST_COST = { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 }; // effectstream v-next values

export async function buildFacade(seedHex, urls, { networkId = NETWORK_ID } = {}) {
  const shieldedSeed = deriveRoleKey(seedHex, Roles.Zswap);
  const dustSeed = deriveRoleKey(seedHex, Roles.Dust);
  const unshieldedSeed = deriveRoleKey(seedHex, Roles.NightExternal);
  const zswapSecretKeys = ZswapSecretKeys.fromSeed(shieldedSeed);
  const dustSecretKey = DustSecretKey.fromSeed(dustSeed);
  const keystore = createKeystore({ kind: 'schnorr', secret: unshieldedSeed }, networkId);
  const config = {
    ...shieldedConfig(urls, networkId),
    provingServerUrl: new URL(urls.proofServer),
    relayURL: new URL(urls.nodeWs),
    costParameters: DUST_COST,
  };
  const wallet = await WalletFacade.init({
    configuration: config,
    shielded: (c) => ShieldedWallet(c).startWithSeed(shieldedSeed),
    unshielded: (c) =>
      UnshieldedWallet({
        ...c,
        txHistoryStorage: new InMemoryTransactionHistoryStorage(TransactionHistoryStorage.TransactionHistoryEntryCommonSchema),
      }).startWithPublicKey(PublicKey.fromKeyStore(keystore)),
    dust: (c) =>
      DustWallet({ ...c, costParameters: { ...DUST_COST, ledgerParams: LedgerParameters.initialParameters() } }).startWithSeed(
        dustSeed,
        LedgerParameters.initialParameters().dust,
      ),
  });
  await wallet.start(zswapSecretKeys, dustSecretKey);
  return { wallet, zswapSecretKeys, dustSecretKey, keystore };
}

/** Spendable DUST at `at` (dust-wallet 5.0.0-beta.2: `DustWalletState.balance(time)`). */
export function dustBalanceOf(state, at = new Date()) {
  const d = state.dust;
  const fn = typeof d.balance === 'function' ? d.balance : d.walletBalance;
  if (typeof fn !== 'function') throw new Error('dust wallet state has no balance(time) method');
  const v = fn.call(d, at);
  return typeof v === 'bigint' ? v : BigInt(v);
}

export async function waitFacadeSynced(wallet, { timeoutMs = 300_000 } = {}) {
  return withTimeout(
    Rx.firstValueFrom(
      wallet.state().pipe(
        Rx.filter(
          (s) =>
            s.shielded.progress.isStrictlyComplete() &&
            s.dust.progress.isStrictlyComplete() &&
            (s.unshielded?.progress?.isStrictlyComplete() ?? false),
        ),
      ),
    ),
    timeoutMs,
    'wallet facade sync',
  );
}

/** Summary of a synced facade state (for logs / evidence). */
export function facadeSummary(state) {
  return {
    shielded: bigintMapToStrings(state.shielded.balances),
    unshielded: bigintMapToStrings(state.unshielded?.balances ?? {}),
    dust: dustBalanceOf(state).toString(),
    dustCoins: state.dust.availableCoins?.length ?? null,
  };
}

/**
 * Shielded transfer of `amount` of `tokenHex` from `fromSeedHex` to the shielded address of
 * `toSeedHex` (or to `toAddress`). Returns `{ txId, before, after }`.
 */
export async function shieldedTransfer({ fromSeedHex, toAddressObj, tokenHex, amount, urls, networkId = NETWORK_ID, log = console.error }) {
  const f = await buildFacade(fromSeedHex, urls, { networkId });
  try {
    log('[transfer] syncing sender wallet (shielded + unshielded + dust)...');
    const before = await waitFacadeSynced(f.wallet);
    const beforeSummary = facadeSummary(before);
    log(`[transfer] sender synced: ${JSON.stringify(beforeSummary)}`);
    const recipe = await f.wallet.transferTransaction(
      [{ type: 'shielded', outputs: [{ amount: BigInt(amount), type: tokenHex, receiverAddress: toAddressObj }] }],
      { shieldedSecretKeys: f.zswapSecretKeys, dustSecretKey: f.dustSecretKey },
      { ttl: new Date(Date.now() + 60 * 60 * 1000) },
    );
    if (recipe.type !== 'UNPROVEN_TRANSACTION') throw new Error(`unexpected recipe type ${recipe.type}`);
    const signed = await f.wallet.signRecipe(recipe, (payload) => f.keystore.signDataAsync(payload));
    log('[transfer] proving (proof server)...');
    const t0 = Date.now();
    const finalized = await f.wallet.finalizeRecipe(signed);
    log(`[transfer] proved in ${((Date.now() - t0) / 1000).toFixed(1)} s; submitting...`);
    const txId = await f.wallet.submitTransaction(finalized);
    log(`[transfer] submitted, txId ${txId}`);
    // Wait for the sender's view to settle (no pending tx), so its change coin is visible.
    const after = await withTimeout(
      Rx.firstValueFrom(
        f.wallet.state().pipe(
          Rx.filter((s) => s.shielded.progress.isStrictlyComplete() && (s.shielded.pendingCoins?.length ?? 0) === 0),
          Rx.filter((s) => {
            const pending = s.pending;
            const n = pending?.all?.length ?? pending?.transactions?.length ?? pending?.size ?? 0;
            return n === 0;
          }),
        ),
      ),
      300_000,
      'sender settlement',
    ).catch((e) => {
      log(`[transfer] WARNING: ${e.message}`);
      return null;
    });
    return { txId, before: beforeSummary, after: after ? facadeSummary(after) : null };
  } finally {
    await f.wallet.stop().catch(() => {});
  }
}
