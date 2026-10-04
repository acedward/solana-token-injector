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
//
// Prints one JSON line on stdout. Env: RELAY_URL, INDEXER_URL, NETWORK, STATE_DIR, TOKENS_FILE.
// The device seeds and the inbox secret stay in $STATE_DIR (mode 600, never printed).

import { readFileSync } from 'node:fs';
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
import { ChainReader } from '/app/web/src/chain/indexer.ts';
import {
  awaitChange,
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
