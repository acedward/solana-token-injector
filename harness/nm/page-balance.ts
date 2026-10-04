// The PAGE's view of an account (AA 00059 G-BALANCE, G.3): Night Market's own page code, headless
// (test/stack/p6/page.ts over web/src/passport/operations.ts), run in Night Market's bun container
// exactly like test/stack/p6/market-flows.ts (the app volume at /app read-only, the relay's key volume
// at the managed path, the run's state at /state). This file is mounted read-only at /probe; nothing
// in the Night Market tree is changed. It uses the SAME page store as the flows ($STATE_DIR/page-<who>.json),
// so the browser-local coins (a withdrawal's change not filed yet) are the page's own.
//
//   bun /probe/page-balance.ts balances --who A|B
//   bun /probe/page-balance.ts withdraw-partial --who A --amount <base units> [--symbol twUSDC]
//   bun /probe/page-balance.ts secure --who A
//   bun /probe/page-balance.ts rotate --who A --to fresh     (P5 A6: a page that got the wallet to sign
//        "Rotate encryption key / New key <K2>" proves and pays it itself, through a third party, as
//        market-flows.ts `hostileRotate` does; K2's secret is written to $STATE_DIR/rotated-<who>.secret,
//        mode 600, never printed)
//   bun /probe/page-balance.ts rotate --who A --to opening   ("Restore my encryption key", the page's
//        restoreEncryptionKey through the relay: the opening key back)
//   bun /probe/page-balance.ts cancel --who A                ("Cancel all open offers": the page's
//        cancelOpenApprovals, a rotation to the SAME key)
//
// Prints one JSON line on stdout. Env: RELAY_URL, INDEXER_URL, NETWORK, STATE_DIR, TOKENS_FILE.
// The device seeds and the inbox secret stay in $STATE_DIR (mode 600, never printed).

import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import nacl from '/app/node_modules/tweetnacl/nacl-fast.js';

import {
  PROFILES,
  bytesToHex,
  formatShieldedAddress,
  hexToBytes,
  holdingsByColour,
  registryFor,
  type NetworkName,
  type StoredCoin,
} from '/app/packages/core/src/index.ts';
import { ChainReader, indexerWsUrlFor } from '/app/web/src/chain/indexer.ts';
import {
  callContext,
  ed25519DeviceOf,
  findUseCounter,
  generateEncKeyPairPortable,
  restoreEncKeyRequest,
} from '/app/packages/core/src/passport/index.ts';
import { openThirdParty } from '/app/test/stack/p6/third-party.ts';
import {
  awaitChange,
  cancelOpenApprovals,
  restoreEncryptionKey,
  secureChange,
  syncAccount,
  unconfirmedNotes,
  withdrawToWallet,
  type SyncResult,
} from '/app/web/src/passport/operations.ts';
import { readCoins } from '/app/web/src/passport/records.ts';
import { headlessPage } from '/app/test/stack/p6/page.ts';

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name: string, dflt?: string) => {
  const i = rest.indexOf(`--${name}`);
  if (i >= 0 && rest[i + 1] !== undefined) return rest[i + 1]!;
  if (dflt !== undefined) return dflt;
  throw new Error(`--${name} is required`);
};
const who = opt('who') as 'A' | 'B';
if (who !== 'A' && who !== 'B') throw new Error('--who must be A or B');

const NETWORK = (process.env.NETWORK ?? 'undeployed') as NetworkName;
const PROFILE = PROFILES[NETWORK];
const STATE_DIR = process.env.STATE_DIR ?? '/state';
const RELAY = process.env.RELAY_URL ?? 'http://relay:8080';
const INDEXER_URL = process.env.INDEXER_URL ?? PROFILE.midnight.indexerUrl;
const tokens = registryFor(NETWORK, process.env.TOKENS_FILE ? JSON.parse(readFileSync(process.env.TOKENS_FILE, 'utf8')) : undefined);

interface Party {
  seed: string;
  encSecret: string;
  encPublic: string;
  account?: string;
  txs?: { waveOne: string; waveTwo: string; activation: string };
}
const state = JSON.parse(readFileSync(join(STATE_DIR, 'state.json'), 'utf8')) as {
  A: Party;
  B: Party;
  recipientSeed: string;
  counterfeits?: string[];
};
const p = state[who];
if (!p.account) throw new Error(`${who} has no account yet`);
const account = p.account.replace(/^0x/, '').toLowerCase();

const kp = nacl.sign.keyPair.fromSeed(hexToBytes(p.seed, 32));
const signer = {
  deviceKey: bytesToHex(kp.publicKey),
  address: '',
  signMessage: async (m: Uint8Array) => nacl.sign.detached(m, kp.secretKey),
};
const chain = new ChainReader({ indexerUrl: INDEXER_URL, networkId: PROFILE.midnightNetworkId });
const pg = headlessPage({
  network: NETWORK,
  relayUrl: RELAY,
  chain,
  signer,
  tokens,
  storePath: join(STATE_DIR, `page-${who}.json`),
  account: { address: account, encSecret: p.encSecret, encPublic: p.encPublic, ...(p.txs ? { txs: p.txs } : {}) },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sym = (colour: string) => tokens.byColour(colour)?.symbol ?? colour.slice(0, 8);

/** syncAccount until every inbox note but a planted counterfeit has its leaf (market-flows.ts settledCoins). */
async function settled(tries = 40): Promise<SyncResult> {
  const fake = new Set(state.counterfeits ?? []);
  const waiting = (coins: readonly StoredCoin[]) =>
    coins.some((c) => !c.spent && c.inInbox && c.mtIndex === null && !fake.has(c.commitment));
  let sync = await syncAccount(pg, account);
  pg.flush();
  for (let i = 0; i < tries && waiting(sync.coins); i++) {
    await sleep(3_000);
    sync = await syncAccount(pg, account);
    pg.flush();
  }
  return sync;
}

function view(sync: SyncResult) {
  return {
    who,
    account,
    stateHeight: sync.stateHeight,
    history: { complete: sync.history.complete, throughHeight: sync.history.throughHeight, txs: sync.history.txs.length, ...(sync.history.gap ? { gap: sync.history.gap } : {}) },
    holdings: holdingsByColour(sync.coins).map((h) => ({
      colour: h.color,
      symbol: sym(h.color),
      total: h.total.toString(10),
      coins: h.coins,
      notInInbox: h.notInInbox,
      unpositioned: h.unpositioned,
    })),
    unshielded: sync.unshielded,
    unconfirmed: sync.unconfirmed,
    unconfirmedNotes: unconfirmedNotes(sync.coins).length,
    unreadable: sync.unreadable,
    coins: sync.coins.map((c) => ({
      colour: c.color,
      value: c.value,
      commitment: c.commitment,
      mtIndex: c.mtIndex,
      spent: c.spent,
      inInbox: c.inInbox,
      origin: c.origin,
      ...(c.pending ? { pending: true } : {}),
    })),
  };
}

async function recipient(): Promise<string> {
  const ledger = (await import('/app/node_modules/@midnightntwrk/ledger-v9/midnight_ledger_wasm_v9_fs.js').catch(
    () => import('@midnightntwrk/ledger-v9'),
  )) as unknown as {
    ZswapSecretKeys: { fromSeed(s: Uint8Array): { coinPublicKey: unknown; encryptionPublicKey: unknown } };
  };
  const rk = ledger.ZswapSecretKeys.fromSeed(hexToBytes(state.recipientSeed, 32));
  const keyHex = (k: unknown) =>
    (typeof k === 'string' ? k : ((k as { toHexString?(): string }).toHexString?.() ?? String(k))).replace(/^0x/, '');
  return formatShieldedAddress({ coinPublicKey: keyHex(rk.coinPublicKey), encryptionPublicKey: keyHex(rk.encryptionPublicKey) }, NETWORK);
}

async function main() {
  const t0 = Date.now();
  if (cmd === 'balances') {
    const sync = await settled();
    return { ...view(sync), seconds: (Date.now() - t0) / 1000 };
  }
  if (cmd === 'withdraw-partial') {
    const amount = BigInt(opt('amount'));
    const token = tokens.bySymbol(opt('symbol', 'twUSDC'));
    if (!token) throw new Error('unknown --symbol');
    await settled();
    const to = await recipient();
    const r = await withdrawToWallet(pg, account, { color: token.midnightColour, amount, recipient: to });
    pg.flush();
    if (!r.change) throw new Error('the withdrawal left no change (pick an amount below the coin)');
    const outcome = await awaitChange(pg, account, r.change.commitment, 180_000);
    pg.flush();
    const sync = await settled();
    return {
      cmd,
      txId: r.txId,
      paid: amount.toString(10),
      change: { colour: r.change.color, value: r.change.value, commitment: r.change.commitment },
      changeMismatch: r.changeMismatch,
      changeOutcome: outcome.state,
      after: view(sync),
      seconds: (Date.now() - t0) / 1000,
    };
  }
  if (cmd === 'rotate') {
    const to = opt('to');
    const before = await chain.accountState(account);
    if (!before) throw new Error('no account state');
    let newKey: string;
    let txId: string;
    if (to === 'fresh') {
      const k = generateEncKeyPairPortable();
      newKey = bytesToHex(k.publicKey);
      const secretFile = join(STATE_DIR, `rotated-${who}.secret`);
      writeFileSync(secretFile, `${bytesToHex(k.secretKey)}\n`, { mode: 0o600 });
      chmodSync(secretFile, 0o600);
      const tp = await openThirdParty({
        seedFile: process.env.THIRD_PARTY_SEED_FILE ?? '/run/nm/third.seed',
        networkId: PROFILE.midnightNetworkId,
        indexerUrl: INDEXER_URL,
        indexerWsUrl: indexerWsUrlFor(INDEXER_URL),
        nodeWsUrl: process.env.NODE_WS_URL ?? PROFILE.midnight.nodeWsUrl,
        contractProofServerUrl: process.env.CONTRACT_PROOF_SERVER_URL ?? 'http://proof-server-rc8:6300',
        dustProofServerUrl: process.env.DUST_PROOF_SERVER_URL ?? 'http://proof-server:6300',
        managedPath: process.env.MIDNIGHT_MANAGED_PATH ?? '/app/vendor/passport/contract/contracts/managed',
      });
      try {
        const view = before;
        const device = ed25519DeviceOf(signer, { network: NETWORK, tokens });
        const counter = findUseCounter(view.devices, (n: bigint) =>
          bytesToHex(device.entryAt(hexToBytes(view.account, 32), BigInt(view.deviceEpoch), n)),
        );
        if (counter === null) throw new Error(`${who}'s device is not live on its account`);
        const ctx = callContext({ account: view.account, authNonce: BigInt(view.authNonce), networkSalt: view.networkSalt, encKey: view.encKey });
        const auth = await device.sign(ctx, restoreEncKeyRequest({ newKey, authNonce: view.authNonce }), counter);
        txId = (await tp.rotateKey(account, newKey, auth)).txId;
      } finally {
        await tp.stop();
      }
    } else if (to === 'opening') {
      newKey = p.encPublic;
      txId = (await restoreEncryptionKey(pg, account)).txId;
      pg.flush();
    } else throw new Error('--to must be fresh or opening');
    let now = await chain.accountState(account);
    for (let i = 0; i < 40 && now?.encKey !== newKey; i++) {
      await sleep(3_000);
      now = await chain.accountState(account);
    }
    return { cmd, to, txId, newKeyFingerprint: newKey.slice(0, 8), chainShowsNewKey: now?.encKey === newKey, authNonce: now?.authNonce, seconds: (Date.now() - t0) / 1000 };
  }
  if (cmd === 'cancel') {
    const before = await chain.accountState(account);
    const r = await cancelOpenApprovals(pg, account);
    pg.flush();
    const now = await chain.accountState(account);
    return { cmd, txId: r.txId, authNonceBefore: before?.authNonce, authNonce: r.authNonce, keyUnchanged: now?.encKey === before?.encKey, seconds: (Date.now() - t0) / 1000 };
  }
  if (cmd === 'secure') {
    await settled();
    const coin = readCoins(pg.store, pg.scope, account).find(
      (c) => !c.spent && !c.inInbox && c.origin === 'change' && c.mtIndex !== null && !c.pending,
    );
    if (!coin) throw new Error('no confirmed, unfiled change to secure');
    const r = await secureChange(pg, account, coin);
    pg.flush();
    // The page then sees the note: the coin is in the inbox once the append lands.
    let sync = await settled();
    for (let i = 0; i < 40 && !sync.coins.some((c) => c.commitment === coin.commitment && c.inInbox); i++) {
      await sleep(3_000);
      sync = await settled();
    }
    return { cmd, txId: r.txId, coin: { colour: coin.color, value: coin.value, commitment: coin.commitment }, after: view(sync), seconds: (Date.now() - t0) / 1000 };
  }
  throw new Error(`unknown command ${cmd}`);
}

main().then(
  (out) => {
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(0);
  },
  (e: unknown) => {
    process.stderr.write(`page-balance: ${String((e as Error)?.stack ?? e)}\n`);
    process.exit(1);
  },
);
