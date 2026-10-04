// Test vectors for the vendored Night Market bundle and the account source (AA 00059 P0 T0.2, T0.3,
// T0.5; P2/P3 account states), computed by NIGHT MARKET'S OWN CODE in its app volume (not by the
// bundle), so the injector's tests compare the bundle under Node against the page's code under Bun.
//
// Run by harness/nm/export-vectors.sh in Night Market's app volume (oven/bun:1.3.11, /app = the
// Night Market tree with node_modules and the light compile, this directory mounted at /probe):
//   bun /probe/export-vectors.ts > test/fixtures/nm/vectors.json
//
// Everything written is public test data: account states, ledger events, entries sealed to
// throwaway keys. The keys are DERIVED from fixed labels (sha256("aa00059 <kind> <label>"), the same
// derivation as test/helpers/nm-keys.js), so the fixture holds no secret and no seed.

import nacl from '/app/node_modules/tweetnacl/nacl-fast.js';
import { sha256 } from '/app/node_modules/@noble/hashes/sha2.js';

import { bytesToHex, hexToBytes } from '/app/packages/core/src/hex.ts';
import { contractCoinCommitment, contractCoinNullifier } from '/app/packages/core/src/coins.ts';
import { encPublicKeyOf } from '/app/packages/core/src/enc-key.ts';
import {
  checkMarketAccount,
  compareVerifierKeys,
  decodeAccountState,
  networkSaltFor,
} from '/app/packages/core/src/passport/account-chain.ts';
import { ed25519DeviceForKey } from '/app/packages/core/src/passport/ed25519.ts';
import { PINNED_ACCOUNT_KEYS } from '/app/packages/core/src/passport/pinned-account-keys.ts';
import { FIXTURE_VERIFIER_KEYS, accountStateHex, type AccountStateSpec } from '/app/packages/core/test/fixtures/account-state.ts';
import { zswapInputEventHex, zswapOutputEventHex } from '/app/packages/core/test/fixtures/ledger-events.ts';
import { sealEntryPortable } from '/app/vendor/passport/contract/src/wallet/deposit.ts';
import { decodeAccountTx, decodeEvent } from '/app/web/src/chain/ledger-decode.ts';
import { txsOfActions, type IndexerAction } from '/app/web/src/chain/history.ts';

const enc = new TextEncoder();
const det = (kind: string, label: string) => sha256(enc.encode(`aa00059 ${kind} ${label}`));
const detHex = (kind: string, label: string) => bytesToHex(det(kind, label));
/** A device: the Ed25519 key of seed det('device', label) (64 hex). */
const deviceKey = (label: string) => bytesToHex(nacl.sign.keyPair.fromSeed(det('device', label)).publicKey);
/** An account inbox key: X25519 secret det('enc', label); only its PUBLIC key is written. */
const encPub = (label: string) => encPublicKeyOf(detHex('enc', label));
const account = (label: string) => detHex('account', label);
const big = (_: string, v: unknown) => (typeof v === 'bigint' ? v.toString(10) : v);

const UNDEPLOYED = networkSaltFor('undeployed');
const STAGENET = networkSaltFor('stagenet');

// ── T0.2: device entries ─────────────────────────────────────────────────────────────────────
const entries = [
  { device: 'A', account: account('A'), epoch: 0n, counter: 0n },
  { device: 'B', account: account('B'), epoch: 1n, counter: 3n },
  { device: 'C', account: account('C'), epoch: 2n, counter: 255n },
].map((t) => ({
  deviceLabel: t.device,
  deviceKey: deviceKey(t.device),
  account: t.account,
  epoch: t.epoch.toString(),
  counter: t.counter.toString(),
  entry: bytesToHex(ed25519DeviceForKey(deviceKey(t.device)).entryAt(hexToBytes(t.account, 32), t.epoch, t.counter)),
}));

// ── T0.3: ledger events ──────────────────────────────────────────────────────────────────────
const built = [
  zswapOutputEventHex({ txHash: detHex('tx', '1'), contract: account('A'), commitment: detHex('cm', '1'), mtIndex: 0 }),
  zswapOutputEventHex({ txHash: detHex('tx', '2'), contract: account('A'), commitment: detHex('cm', '2'), mtIndex: 63 }),
  zswapOutputEventHex({ txHash: detHex('tx', '3'), contract: account('B'), commitment: detHex('cm', '3'), mtIndex: 16383 }),
  zswapOutputEventHex({ txHash: detHex('tx', '4'), contract: account('B'), commitment: detHex('cm', '4'), mtIndex: 70000 }),
  zswapInputEventHex({ txHash: detHex('tx', '5'), contract: account('A'), nullifier: detHex('nf', '5') }),
];
const events: Array<{ raw: string; decoded: unknown; from: string }> = built.map((raw) => ({
  raw,
  decoded: JSON.parse(JSON.stringify(decodeEvent(raw), big)),
  from: 'packages/core/test/fixtures/ledger-events.ts',
}));
const histories: Array<{ file: string; account: string; txs: unknown }> = [];
for (const f of ['account-a-history.json', 'account-b-history.json']) {
  const h = (await Bun.file(`/app/test/fixtures/stagenet-p11b/${f}`).json()) as {
    account: string;
    data: { contract: { actions: IndexerAction[] } };
  };
  for (const a of h.data.contract.actions)
    for (const e of a.transaction.zswapLedgerEvents ?? [])
      events.push({ raw: e.raw, decoded: JSON.parse(JSON.stringify(decodeEvent(e.raw), big)), from: `test/fixtures/stagenet-p11b/${f}` });
  const txs = txsOfActions(h.data.contract.actions).map((t) => decodeAccountTx(h.account, t));
  histories.push({ file: `test/fixtures/stagenet-p11b/${f}`, account: h.account, txs: JSON.parse(JSON.stringify(txs, big)) });
}

// ── Coins and sealed entries for the account states (P2/P3) ──────────────────────────────────
const COLOUR_X = detHex('colour', 'X');
const COLOUR_Y = detHex('colour', 'Y');
const ZERO = '00'.repeat(32);
const coin = (label: string, color: string, value: bigint) => ({ nonce: detHex('nonce', label), color, value: value.toString(10) });
// c1, c2 sealed to K1; c3 sealed to K2; c4 sealed to K3 (a key the tests never register).
const coins = [
  { id: 'c1', key: 'K1', ...coin('c1', COLOUR_X, 500_000_000n) },
  { id: 'c2', key: 'K1', ...coin('c2', COLOUR_Y, 7n) },
  { id: 'c3', key: 'K2', ...coin('c3', COLOUR_X, 1_000_000n) },
  { id: 'c4', key: 'K3', ...coin('c4', ZERO, 42n) },
];
const sealed: string[] = [];
for (const c of coins)
  sealed.push(
    bytesToHex(
      await sealEntryPortable(hexToBytes(encPub(c.key), 32), {
        nonce: hexToBytes(c.nonce, 32),
        color: hexToBytes(c.color, 32),
        value: BigInt(c.value),
      }),
    ),
  );
const coinFacts = coins.map((c, i) => ({
  ...c,
  inboxIndex: String(i),
  entry: sealed[i],
  commitmentA: contractCoinCommitment(c, account('A')),
  nullifierA: contractCoinNullifier(c, account('A')),
}));

// ── T0.5 / P2 / P3: account states, built by the account's own constructor (account-state.ts) ──
const base = (over: Partial<AccountStateSpec> = {}): AccountStateSpec => ({
  account: account('A'),
  deviceKey: deviceKey('A'),
  encKey: encPub('K1'),
  salt: UNDEPLOYED,
  authNonce: 3n,
  useCounter: 3n,
  ...over,
});
const swapped = { ...FIXTURE_VERIFIER_KEYS };
{
  const [a, b] = ['append_inbox_with_ed25519', 'rotate_enc_key_with_ed25519'];
  [swapped[a], swapped[b]] = [swapped[b]!, swapped[a]!];
}
const specs: Array<{ name: string; note: string; spec: AccountStateSpec }> = [
  { name: 'ok', note: 'A, device A at counter = nonce 3, enc key K1, undeployed', spec: base() },
  { name: 'ok-inbox', note: 'ok + inbox c1..c4 (c1, c2 to K1; c3 to K2; c4 to K3)', spec: base({ inbox: sealed }) },
  { name: 'ok-inbox-k2', note: 'ok-inbox with enc key K2 (a rotation to a key the injector may hold)', spec: base({ inbox: sealed, encKey: encPub('K2') }) },
  { name: 'ok-inbox-k4', note: 'ok-inbox with enc key K4 (a rotation to a key nobody registers)', spec: base({ inbox: sealed, encKey: encPub('K4') }) },
  { name: 'ok-unshielded', note: 'ok + unshielded 00..00 = 5000000 and X = 7 (credited the same)', spec: base({ unshielded: [[ZERO, 5_000_000n], [COLOUR_X, 7n]], credited: [[ZERO, 5_000_000n], [COLOUR_X, 7n]] }) },
  { name: 'ok-inbox-unshielded', note: 'ok-inbox + unshielded 00..00 = 5000000 and X = 7 (credited the same)', spec: base({ inbox: sealed, unshielded: [[ZERO, 5_000_000n], [COLOUR_X, 7n]], credited: [[ZERO, 5_000_000n], [COLOUR_X, 7n]] }) },
  { name: 'ok-inbox-nonce4', note: 'ok-inbox after a same-key rotation ("Cancel all open offers"): auth nonce and counter 4, enc key K1', spec: base({ inbox: sealed, authNonce: 4n, useCounter: 4n }) },
  { name: 'scan-7-of-9', note: 'device entry at counter 7, auth nonce 9', spec: base({ authNonce: 9n, useCounter: 7n }) },
  { name: 'counter-300', note: 'device entry at counter 300, auth nonce 9 (beyond the 0..255 scan)', spec: base({ authNonce: 9n, useCounter: 300n }) },
  { name: 'vk-different', note: 'two circuits with each other\'s verifier keys', spec: base({ operations: swapped }) },
  { name: 'vk-extra', note: 'the pinned set plus add_device_with_ed25519', spec: base({ operations: { ...FIXTURE_VERIFIER_KEYS, add_device_with_ed25519: FIXTURE_VERIFIER_KEYS['append_inbox_with_ed25519']! } }) },
  { name: 'authority-live', note: 'maintenance authority with one committee key', spec: base({ authority: { committee: 1, threshold: 1 } }) },
  { name: 'not-booted', note: 'no device, not booted', spec: base({ noDevice: true, booted: false, authNonce: 0n }) },
  { name: 'stagenet-salt', note: 'the network salt of stagenet', spec: base({ salt: STAGENET }) },
  { name: 'two-devices', note: 'device A plus another entry', spec: base({ extraDevices: [detHex('entry', 'other')] }) },
];
const states = [] as Array<Record<string, unknown>>;
for (const s of specs) {
  const hex = await accountStateHex(s.spec);
  const d = decodeAccountState(s.spec.account, hex);
  const check = checkMarketAccount(d, {
    deviceKey: s.spec.deviceKey,
    encPublicKey: s.spec.encKey,
    networkSalt: UNDEPLOYED,
    verifierKeys: PINNED_ACCOUNT_KEYS.circuits,
  });
  states.push({
    name: s.name,
    note: s.note,
    account: s.spec.account,
    deviceLabel: 'A',
    encKeyLabel: s.name.endsWith('-k2') ? 'K2' : s.name.endsWith('-k4') ? 'K4' : 'K1',
    state: hex,
    decoded: JSON.parse(JSON.stringify({ view: d.view, authority: d.authority, unshielded: d.unshielded, credited: d.credited, round: d.round }, big)),
    operationsEqualPinned: compareVerifierKeys(d.operations, PINNED_ACCOUNT_KEYS.circuits),
    check: { ok: check.ok, codes: check.problems.map((p) => p.code), useCounter: check.useCounter === null ? null : check.useCounter.toString() },
  });
}
// The real stagenet account A (public, read 2026-10-01): decoded, and compared with the pinned set.
{
  const f = (await Bun.file('/app/test/fixtures/stagenet-account-a.json').json()) as { account: string; state: string };
  const d = decodeAccountState(f.account, f.state);
  states.push({
    name: 'stagenet-account-a',
    note: 'test/fixtures/stagenet-account-a.json (live stagenet, previous key set)',
    account: f.account,
    state: f.state,
    decoded: JSON.parse(JSON.stringify({ view: d.view, authority: d.authority, unshielded: d.unshielded, credited: d.credited, round: d.round }, big)),
    operationsEqualPinned: compareVerifierKeys(d.operations, PINNED_ACCOUNT_KEYS.circuits),
  });
}

process.stdout.write(
  `${JSON.stringify(
    {
      generatedBy: 'harness/nm/export-vectors.ts (AA 00059) in Night Market\'s app volume, Bun 1.3.11',
      derivation: 'device seed = sha256("aa00059 device <label>"); enc secret = sha256("aa00059 enc <label>"); account = sha256("aa00059 account <label>") (test/helpers/nm-keys.js)',
      pinnedKeySet: PINNED_ACCOUNT_KEYS.keySet,
      fixtureKeysArePinned: Object.keys(FIXTURE_VERIFIER_KEYS).length === Object.keys(PINNED_ACCOUNT_KEYS.circuits).length,
      undeployedSalt: UNDEPLOYED,
      colours: { X: COLOUR_X, Y: COLOUR_Y, ZERO },
      entries,
      events,
      histories,
      coins: coinFacts,
      states,
    },
    null,
    1,
  )}\n`,
);
