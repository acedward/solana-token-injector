'use strict';
// AA 00059 P2 (T2.2-T2.4): the account watcher over a mock indexer serving Night Market's own account
// states (test/fixtures/nm/vectors.json) and ledger events the vendored ledger-v9 decodes.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadNightMarket } = require('../../src/accounts/bundle');
const { createIndexerReader } = require('../../src/accounts/chain');
const { AccountWatcher } = require('../../src/accounts/watcher');
const { startMockIndexer } = require('../helpers/mock-indexer');
const keys = require('../helpers/nm-keys');
const { V, state, coin, deposit, spend, depositsAll } = require('../helpers/account-chain');

const A = keys.accountHex('A');
const X = V.colours.X;
const Y = V.colours.Y;
const ZERO = V.colours.ZERO;

let nm;
test.before(async () => {
  nm = await loadNightMarket();
});

const key = (label) => ({ secret: keys.encSecretHex(label), publicKey: nm.encPublicKeyOf(keys.encSecretHex(label)) });
const totals = (m) => Object.fromEntries([...(m || new Map())].map(([k, v]) => [k, v.toString(10)]));

async function setup({ stateName = 'ok-inbox', actions, ring = ['K1'], pageLimit, pollMs = 60_000 } = {}) {
  const idx = await startMockIndexer();
  idx.setContract(A, { state: state(stateName).state, actions: actions || depositsAll(A), deployHeight: 5 });
  const chain = createIndexerReader({ indexerHttp: idx.httpUrl, indexerWs: idx.wsUrl, nm, timeoutMs: 3000 });
  const w = new AccountWatcher({ address: A, keys: ring.map(key), nm, chain, pollMs, backoffMinMs: 50, backoffMaxMs: 200, historyPageLimit: pageLimit });
  const changes = [];
  w.on('change', (s) => changes.push(s.status));
  return { idx, chain, w, changes, close: async () => { await w.stop(); await idx.close(); } };
}

test('T2.2 key ring: entries sealed to K1 and K2 open with {K1, K2}; K3\'s is unreadable only', async () => {
  const one = await setup({ ring: ['K1'] });
  await one.w.pollNow();
  let s = one.w.snapshot();
  assert.equal(s.status, 'synced', s.error);
  assert.deepEqual(totals(s.amounts.shielded), { [X]: '500000000', [Y]: '7' });
  assert.equal(s.unreadableEntries, 2);
  assert.equal(s.unseenCoins, 2, 'the leaves of c3 and c4 are explained by no opened note');
  await one.close();

  const two = await setup({ ring: ['K1', 'K2'] });
  await two.w.pollNow();
  s = two.w.snapshot();
  assert.equal(s.status, 'synced');
  assert.deepEqual(totals(s.amounts.shielded), { [X]: '501000000', [Y]: '7' });
  assert.equal(s.unreadableEntries, 1);
  assert.equal(s.unseenCoins, 1);
  assert.deepEqual(s.history, { complete: true, throughHeight: 13 });
  // A spend of c1 (its nullifier) removes it; the spend is explained by an opened coin.
  two.idx.addAction(A, spend(A, coin('c1').nullifierA, { height: 20, id: 200 }));
  await two.w.pollNow();
  s = two.w.snapshot();
  assert.deepEqual(totals(s.amounts.shielded), { [X]: '1000000', [Y]: '7' });
  assert.equal(s.unseenCoins, 1);
  // A note whose coin has no leaf (a counterfeit) counts nothing: drop c2's deposit from the history.
  await two.close();
  const noLeaf = await setup({ ring: ['K1', 'K2'], actions: depositsAll(A).filter((_, i) => i !== 1) });
  await noLeaf.w.pollNow();
  s = noLeaf.w.snapshot();
  assert.deepEqual(totals(s.amounts.shielded), { [X]: '501000000' });
  assert.equal(s.unconfirmedNotes, 1);
  await noLeaf.close();
});

test('T2.3 unshielded balances: their own keys, never merged with the shielded colour of the same bytes', async () => {
  const t = await setup({ stateName: 'ok-inbox-unshielded', ring: ['K1', 'K2', 'K3'] });
  await t.w.pollNow();
  const s = t.w.snapshot();
  assert.equal(s.status, 'synced', s.error);
  assert.deepEqual(totals(s.amounts.shielded), { [X]: '501000000', [Y]: '7', [ZERO]: '42' });
  assert.deepEqual(totals(s.amounts.unshielded), { [ZERO]: '5000000', [X]: '7' });
  await t.close();
});

test('T2.4 statuses: error (amounts kept) -> synced; incomplete; stale-key (frozen) -> synced; same-key rotation stays synced', async () => {
  const t = await setup({ ring: ['K1'] });
  await t.w.pollNow();
  assert.equal(t.w.snapshot().status, 'synced');
  const before = totals(t.w.snapshot().amounts.shielded);
  // The indexer goes down: error, the amounts are kept.
  t.idx.setDown(true);
  await t.w.pollNow();
  let s = t.w.snapshot();
  assert.equal(s.status, 'error');
  assert.match(s.error, /indexer/);
  assert.deepEqual(totals(s.amounts.shielded), before);
  // It comes back: synced.
  t.idx.setDown(false);
  await t.w.pollNow();
  assert.equal(t.w.snapshot().status, 'synced');
  // A rotation to a key nobody registered: stale-key, the amounts frozen even when the chain moves.
  t.idx.setState(A, state('ok-inbox-k4').state);
  t.idx.addAction(A, spend(A, coin('c1').nullifierA, { height: 30, id: 300 }));
  await t.w.pollNow();
  s = t.w.snapshot();
  assert.equal(s.status, 'stale-key');
  assert.deepEqual(totals(s.amounts.shielded), before, 'frozen');
  // Back to a held key: synced without re-registering (and the spend now counts).
  t.idx.setState(A, state('ok-inbox').state);
  await t.w.pollNow();
  s = t.w.snapshot();
  assert.equal(s.status, 'synced');
  assert.deepEqual(totals(s.amounts.shielded), { [Y]: '7' });
  // A same-key rotation ("Cancel all open offers": the nonce moves, the key does not): never stale.
  t.idx.setState(A, state('ok-inbox-nonce4').state);
  await t.w.pollNow();
  assert.equal(t.w.snapshot().status, 'synced');
  assert.ok(!t.changes.slice(t.changes.lastIndexOf('synced')).includes('stale-key'));
  await t.close();

  // A rotation to K2 with only K1 held: stale-key; re-registered with K2 (ring {K1, K2}): synced, and
  // the coins filed before the rotation still count.
  const r = await setup({ ring: ['K1'] });
  await r.w.pollNow();
  r.idx.setState(A, state('ok-inbox-k2').state);
  await r.w.pollNow();
  assert.equal(r.w.snapshot().status, 'stale-key');
  r.w.setKeys([key('K1'), key('K2')]);
  await r.w.pollNow();
  s = r.w.snapshot();
  assert.equal(s.status, 'synced');
  assert.deepEqual(totals(s.amounts.shielded), { [X]: '501000000', [Y]: '7' });
  await r.close();

  // A full newest page with a failing stream: incomplete, the amounts from what was read, flagged.
  const inc = await setup({ ring: ['K1', 'K2'], pageLimit: 2 });
  inc.idx.failStreams(true);
  await inc.w.pollNow();
  s = inc.w.snapshot();
  assert.equal(s.status, 'incomplete');
  assert.ok(s.error);
  assert.equal(s.history.complete, false);
  // Only c3 and c4 (the newest page of 2) have leaves read: c3 (K2) counts; c1/c2 are unconfirmed notes.
  assert.deepEqual(totals(s.amounts.shielded), { [X]: '1000000' });
  inc.idx.failStreams(false);
  await inc.w.pollNow();
  s = inc.w.snapshot();
  assert.equal(s.status, 'synced', s.error);
  assert.deepEqual(totals(s.amounts.shielded), { [X]: '501000000', [Y]: '7' });
  await inc.close();
});

test('the first poll after a restart serves the persisted amounts until it completes; errors back off', async () => {
  const idx = await startMockIndexer();
  idx.setDown(true);
  const chain = createIndexerReader({ indexerHttp: idx.httpUrl, indexerWs: idx.wsUrl, nm, timeoutMs: 1000 });
  const persisted = { shielded: { [X]: '123' }, unshielded: { [ZERO]: '9' } };
  const w = new AccountWatcher({ address: A, keys: [key('K1')], nm, chain, pollMs: 60_000, backoffMinMs: 40, backoffMaxMs: 160, initialAmounts: persisted });
  assert.equal(w.snapshot().status, 'syncing');
  assert.deepEqual(w.snapshot().amountsJson, persisted);
  const t0 = Date.now();
  w.start();
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(w.snapshot().status, 'error');
  assert.deepEqual(w.snapshot().amountsJson, persisted);
  assert.ok(w.failures >= 3 && w.failures < 15, `backoff: ${w.failures} failures in ${Date.now() - t0} ms`);
  await w.stop();
  await idx.close();
});
