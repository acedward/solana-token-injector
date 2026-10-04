'use strict';
// AA 00059 P0 (T0.1-T0.5): the vendored Night Market bundle, loaded from CommonJS under Node, gives
// the values Night Market's own code gives under Bun (test/fixtures/nm/vectors.json, exported by
// harness/nm/export-vectors.ts in Night Market's app volume) and the ledger's own WASM gives.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { loadNightMarket } = require('../../src/accounts/bundle');
const V = require('../fixtures/nm/vectors.json');
const keys = require('../helpers/nm-keys');

const hex = (n) => crypto.randomBytes(n).toString('hex');
const low = (h) => String(h).replace(/^0x/, '').toLowerCase();
const bytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const plain = (v) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString(10) : x)));

let nm;
let ledger;
test.before(async () => {
  nm = await loadNightMarket();
  ledger = await import('@midnightntwrk/ledger-v9');
});

test('T0.1 contractCoinCommitment equals ledger-v9 ZswapOutput.newContractOwned(...).commitment (100 random coins)', () => {
  const values = [0n, 1n, 1_000_000n, 2n ** 63n - 1n, 2n ** 64n - 1n, 2n ** 128n - 1n];
  for (let i = 0; i < 100; i++) {
    const value = i < values.length ? values[i] : BigInt(`0x${hex(i % 2 ? 8 : 15)}`);
    const coin = { nonce: hex(32), type: hex(32), value };
    const contract = hex(32);
    const want = low(ledger.ZswapOutput.newContractOwned(coin, undefined, contract).commitment);
    const ours = nm.contractCoinCommitment({ nonce: coin.nonce, color: coin.type, value: value.toString() }, contract);
    assert.equal(ours, want, `coin ${i}`);
  }
});

test('T0.1b contractCoinNullifier equals ledger-v9 ZswapInput.newContractOwned(...).nullifier', () => {
  for (const value of [1n, 1_000_000n, 2n ** 64n - 1n]) {
    const coin = { nonce: hex(32), type: hex(32), value };
    const contract = hex(32);
    const output = ledger.ZswapOutput.newContractOwned(coin, undefined, contract);
    const [applied] = new ledger.ZswapChainState().tryApply(ledger.ZswapOffer.fromOutput(output, coin.type, coin.value));
    const state = applied.postBlockUpdate(new Date(), 3600n);
    const input = ledger.ZswapInput.newContractOwned({ ...coin, mt_index: 0n }, undefined, contract, state);
    assert.equal(nm.contractCoinNullifier({ nonce: coin.nonce, color: coin.type, value: value.toString() }, contract), low(input.nullifier));
  }
});

test('T0.2 ed25519DeviceForKey(k).entryAt equals Night Market\'s own value (3 tuples)', () => {
  assert.equal(V.entries.length, 3);
  for (const e of V.entries) {
    assert.equal(e.deviceKey, keys.deviceKeyHex(e.deviceLabel), 'the derivation matches the exporter');
    const got = Buffer.from(nm.ed25519DeviceForKey(e.deviceKey).entryAt(bytes(e.account), BigInt(e.epoch), BigInt(e.counter))).toString('hex');
    assert.equal(got, e.entry);
  }
});

test('T0.3 decodeEvent of built and real stagenet events equals Night Market\'s decode', () => {
  assert.ok(V.events.length >= 20);
  const kinds = new Set();
  for (const e of V.events) {
    const got = plain(nm.decodeEvent(e.raw));
    assert.deepEqual(got, e.decoded, e.from);
    kinds.add(got.kind);
  }
  assert.ok(kinds.has('output') && kinds.has('input'), 'both leaf and spend events are covered');
  // decodeAccountTx over the real histories (txsOfActions groups the indexer's actions).
  for (const h of V.histories) {
    const f = require(`../fixtures/nm/stagenet-p11b/${h.file.split('/').pop()}`);
    const txs = nm.txsOfActions(f.data.contract.actions).map((t) => plain(nm.decodeAccountTx(h.account, t)));
    assert.deepEqual(txs, h.txs, h.file);
  }
  assert.throws(() => nm.decodeEvent('deadbeef'), (e) => e instanceof nm.LedgerDecodeError);
});

test('T0.4 sealEntryPortable -> openEntryPortable round trip; another key opens nothing', async () => {
  const k = nm.generateEncKeyPairPortable();
  const other = nm.generateEncKeyPairPortable();
  const coin = { nonce: bytes(hex(32)), color: bytes(hex(32)), value: 123456789n };
  const entry = await nm.sealEntryPortable(k.publicKey, coin);
  assert.equal(entry.length, 192);
  const opened = await nm.openEntryPortable(k.secretKey, entry);
  assert.deepEqual(plain({ ...opened, nonce: Buffer.from(opened.nonce).toString('hex'), color: Buffer.from(opened.color).toString('hex') }),
    plain({ ...coin, nonce: Buffer.from(coin.nonce).toString('hex'), color: Buffer.from(coin.color).toString('hex') }));
  assert.equal(await nm.openEntryPortable(other.secretKey, entry), null);
  assert.equal(nm.encPublicKeyOf(Buffer.from(k.secretKey).toString('hex')), Buffer.from(k.publicKey).toString('hex'));
});

test('T0.4b the exporter\'s entries open with the derived keys exactly as recorded', async () => {
  for (const c of V.coins) {
    const opened = await nm.openEntryPortable(bytes(keys.encSecretHex(c.key)), bytes(c.entry));
    assert.ok(opened, c.id);
    assert.equal(Buffer.from(opened.nonce).toString('hex'), c.nonce);
    assert.equal(Buffer.from(opened.color).toString('hex'), c.color);
    assert.equal(opened.value.toString(), c.value);
    assert.equal(nm.contractCoinCommitment(c, keys.accountHex('A')), c.commitmentA);
  }
});

test('T0.5 decodeAccountState and the market check equal Night Market\'s on every state fixture', () => {
  assert.equal(V.fixtureKeysArePinned, true, 'the fixture states carry the pinned key set');
  assert.equal(nm.PINNED_ACCOUNT_KEYS.keySet, '21493588f30536e0f409dcf79deea54878f0c2cf6fee601a2359e54a776d5c5e');
  assert.equal(nm.PINNED_ACCOUNT_KEYS.keySet, V.pinnedKeySet);
  assert.equal(nm.networkSaltFor('undeployed'), V.undeployedSalt);
  assert.equal(nm.PASSPORT_CLIENT_COMMIT, '599327b918b55afc95d6c98a89bcd15f4e8b0d53');
  for (const s of V.states) {
    const d = nm.decodeAccountState(s.account, s.state);
    assert.deepEqual(plain({ view: d.view, authority: d.authority, unshielded: d.unshielded, credited: d.credited, round: d.round }), s.decoded, s.name);
    assert.deepEqual(nm.compareVerifierKeys(d.operations, nm.PINNED_ACCOUNT_KEYS.circuits), s.operationsEqualPinned, s.name);
    if (s.check) {
      const c = nm.checkMarketAccount(d, {
        deviceKey: keys.deviceKeyHex(s.deviceLabel),
        encPublicKey: nm.encPublicKeyOf(keys.encSecretHex(s.encKeyLabel)),
        networkSalt: V.undeployedSalt,
        verifierKeys: nm.PINNED_ACCOUNT_KEYS.circuits,
      });
      assert.deepEqual({ ok: c.ok, codes: c.problems.map((p) => p.code), useCounter: c.useCounter === null ? null : c.useCounter.toString() }, s.check, s.name);
    }
  }
  // The real stagenet account A is of the PREVIOUS key set: refused (Night Market's own test says the same).
  const a = V.states.find((s) => s.name === 'stagenet-account-a');
  assert.equal(a.operationsEqualPinned.equal, false);
  assert.deepEqual(a.operationsEqualPinned.extra, ['add_device_with_ed25519', 'remove_device_with_ed25519']);
  assert.throws(() => nm.decodeAccountState('11'.repeat(32), 'deadbeef'), /does not decode/);
});
