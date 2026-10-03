'use strict';
// C.7: counting rule + indexer watcher against the mock indexer and the fake decryptor.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { segmentCounts, countableCoins, progressSynced } = require('../../src/midnight/counting');
const { KeyWatcher, SUBSCRIPTION } = require('../../src/midnight/watcher');
const { DecryptorClient } = require('../../src/midnight/decryptor');
const { startMockIndexer } = require('../helpers/mock-indexer');
const { createFakeMap, FAKE_DECRYPTOR } = require('../helpers/fake-map');
const { testViewingKey } = require('../helpers/keys');
const { waitFor } = require('../helpers/service');

const T0 = '0'.repeat(64);
const T1 = `${'0'.repeat(63)}1`;
const hex = (n) => n.toString(16).padStart(64, '0');
let coinSeq = 0;
const coin = (value, { segment = 0, tokenType = T0 } = {}) => ({ segment, outputIndex: 0, commitment: hex(++coinSeq), tokenType, value: String(value) });

test('counting rule (Q19): SUCCESS all, PARTIAL_SUCCESS seg 0 + successful, FAILURE none', () => {
  assert.equal(segmentCounts({ status: 'SUCCESS', segments: null }, 0), true);
  assert.equal(segmentCounts({ status: 'SUCCESS', segments: null }, 1), true);
  const partial = { status: 'PARTIAL_SUCCESS', segments: [{ id: 1, success: false }, { id: 2, success: true }] };
  assert.equal(segmentCounts(partial, 0), true);
  assert.equal(segmentCounts(partial, 1), false);
  assert.equal(segmentCounts(partial, 2), true);
  assert.equal(segmentCounts(partial, 3), false, 'unlisted fallible segment does not count');
  assert.equal(segmentCounts({ status: 'FAILURE', segments: null }, 0), false);
  assert.equal(segmentCounts(undefined, 0), false, 'missing result counts nothing');
  const coins = [coin(1), coin(2, { segment: 1 }), coin(3, { segment: 2 })];
  assert.deepEqual(countableCoins(coins, partial).map((c) => c.value), ['1', '3']);
});

test('lane A local network shape {SUCCESS, segments: null} with guaranteed coins: all counted', () => {
  // Genesis / wallet transfers carry only segment-0 outputs; Q19's rule and
  // "segment 0 only when segments is null" agree on them.
  const coins = [coin(1), coin(2), coin(3)];
  assert.deepEqual(countableCoins(coins, { status: 'SUCCESS', segments: null }), coins);
});

test('progress: synced when checked >= highest; missing numbers = syncing', () => {
  assert.equal(progressSynced({ highestEndIndex: 5, highestCheckedEndIndex: 5 }), true);
  assert.equal(progressSynced({ highestEndIndex: 5, highestCheckedEndIndex: 6 }), true);
  assert.equal(progressSynced({ highestEndIndex: 5, highestCheckedEndIndex: 4 }), false);
  assert.equal(progressSynced({ highestEndIndex: 5 }), false);
  assert.equal(progressSynced({ highestZswapEndIndex: 3, highestCheckedZswapEndIndex: 3 }), true);
  assert.equal(progressSynced(null), false);
});

test('the subscription text is the 2.x wallet SDK selection', () => {
  for (const s of ['shieldedTransactions(sessionId: $sessionId, index: $index)', 'highestEndIndex highestCheckedEndIndex highestRelevantEndIndex',
    'transactionResult { status segments { id success } }', 'collapsedMerkleTree { startIndex endIndex update protocolVersion }']) {
    assert.ok(SUBSCRIPTION.includes(s), s);
  }
});

async function setup(t, { decryptorTimeoutMs = 3000, syncMinMs = 0, syncQuietMs = 0, progressEveryMs = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sti-watch-'));
  const map = createFakeMap(path.join(dir, 'map.json'));
  const decryptor = new DecryptorClient({ bin: FAKE_DECRYPTOR, env: { ...process.env, FAKE_DECRYPTOR_MAP: map.file }, timeoutMs: decryptorTimeoutMs, minBackoffMs: 20 }).start();
  const indexer = await startMockIndexer({ progressEveryMs });
  const watchers = [];
  const watch = (viewingKey) => {
    const w = new KeyWatcher({ viewingKey, networkId: 'undeployed', indexerHttp: indexer.httpUrl, indexerWs: indexer.wsUrl, decryptor, reconnectMinMs: 50, reconnectMaxMs: 200, syncMinMs, syncQuietMs });
    watchers.push(w);
    return w.start();
  };
  t.after(async () => {
    for (const w of watchers) await w.stop();
    await decryptor.stop();
    await indexer.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // tx(key, coins, result?) -> adds the raw to the fake map and the indexer
  let rawSeq = 0;
  const tx = (key, coins, { status = 'SUCCESS', segments = null } = {}) => {
    const raw = `ab${(++rawSeq).toString(16).padStart(8, '0')}`;
    map.set(raw, coins);
    return indexer.addTransaction(key, { raw, status, segments });
  };
  return { indexer, decryptor, map, watch, tx };
}

const total = (w, type = T0) => w.snapshot().totals.get(type) || 0n;

test('watcher: replay from index 0, live updates, counting rule, dedupe, sync status', async (t) => {
  const { indexer, watch, tx } = await setup(t);
  const key = testViewingKey();
  tx(key, [coin(100), coin(7, { tokenType: T1 })]);
  tx(key, [coin(1000)], { status: 'FAILURE' });
  const w = watch(key);
  await waitFor(() => w.status === 'synced', { what: 'synced' });
  assert.equal(total(w), 100n);
  assert.equal(total(w, T1), 7n);
  assert.equal(w.snapshot().transactions, 2);
  assert.equal(indexer.calls.connect, 1);
  assert.ok(indexer.calls.queries[0].includes('mutation Connect($viewingKey: ViewingKey!) { connect(viewingKey: $viewingKey) }'));

  let changes = 0;
  w.on('change', () => changes++);
  tx(key, [coin(50)]); // live
  await waitFor(() => total(w) === 150n, { what: 'live tx counted' });
  assert.ok(changes >= 1, 'change event emitted');

  tx(key, [coin(5), coin(6, { segment: 1 }), coin(9, { segment: 2 })], { status: 'PARTIAL_SUCCESS', segments: [{ id: 1, success: false }, { id: 2, success: true }] });
  await waitFor(() => total(w) === 164n, { what: 'partial success: seg 0 + seg 2' });

  const ev = tx(key, [coin(1)]);
  await waitFor(() => total(w) === 165n, { what: 'one more' });
  indexer.redeliver(key, ev); // duplicate delivery
  indexer.setProgress({ highestEndIndex: 20, highestCheckedEndIndex: 20, highestRelevantEndIndex: 20 });
  await waitFor(() => w.snapshot().progress.highestEndIndex === 20, { what: 'progress after duplicate' });
  assert.equal(total(w), 165n, 'duplicate not double-counted');
});

test('watcher: progress with missing fields or behind = syncing', async (t) => {
  const { indexer, watch } = await setup(t);
  indexer.setProgress({ highestEndIndex: 10 });
  const w = watch(testViewingKey());
  await waitFor(() => w.lastEventAt, { what: 'first event' });
  assert.equal(w.status, 'syncing');
  indexer.setProgress({ highestEndIndex: 10, highestCheckedEndIndex: 9, highestRelevantEndIndex: 0 });
  await waitFor(() => w.progress && w.progress.highestCheckedEndIndex === 9, { what: 'progress' });
  assert.equal(w.status, 'syncing');
  indexer.setProgress({ highestEndIndex: 10, highestCheckedEndIndex: 10, highestRelevantEndIndex: 0 });
  await waitFor(() => w.status === 'synced', { what: 'synced' });
});

test('watcher: socket drop -> error, totals kept, reconnect with a fresh connect, no double count', async (t) => {
  const { indexer, watch, tx } = await setup(t);
  const key = testViewingKey();
  tx(key, [coin(10)]);
  tx(key, [coin(20)]);
  const w = watch(key);
  await waitFor(() => w.status === 'synced' && total(w) === 30n, { what: 'synced' });
  indexer.setDown(true); // drops sockets, refuses reconnects
  await waitFor(() => w.status === 'error', { what: 'error status' });
  assert.ok(w.error, 'error message set');
  assert.equal(total(w), 30n, 'last totals kept while down');
  const connectsWhileDown = indexer.calls.connect;
  await new Promise((r) => setTimeout(r, 300));
  indexer.setDown(false);
  tx(key, [coin(5)]); // arrived while we were away
  await waitFor(() => w.status === 'synced' && total(w) === 35n, { what: 'recovered', timeoutMs: 5000 });
  assert.equal(w.error, null);
  assert.ok(indexer.calls.connect > connectsWhileDown, 'fresh connect mutation on reconnect');
  assert.equal(w.snapshot().coins, 3, 'replay from index 0 de-duplicated');
});

test('watcher: rejected session -> error, then recovers', async (t) => {
  const { indexer, watch, tx } = await setup(t);
  const key = testViewingKey();
  tx(key, [coin(3)]);
  indexer.rejectSessions(true);
  const w = watch(key);
  await waitFor(() => w.status === 'error' && /unknown or expired session ID/.test(w.error), { what: 'session rejected' });
  indexer.rejectSessions(false);
  await waitFor(() => w.status === 'synced' && total(w) === 3n, { what: 'recovered' });
});

test('watcher: connect refused by the indexer -> error with its message', async (t) => {
  const { watch } = await setup(t);
  const w = watch('not-a-key');
  await waitFor(() => w.status === 'error', { what: 'error' });
  assert.match(w.error, /invalid viewing key/);
});

test('watcher: an undecodable transaction is skipped, the rest counted', async (t) => {
  const { indexer, map, watch, tx } = await setup(t);
  const key = testViewingKey();
  tx(key, [coin(1)]);
  map.set('bad', { error: 'undecodable transaction' });
  indexer.addTransaction(key, { raw: 'bad' });
  tx(key, [coin(2)]);
  const w = watch(key);
  await waitFor(() => w.status === 'synced', { what: 'synced' });
  assert.equal(total(w), 3n);
  assert.equal(w.snapshot().skipped, 1);
  assert.equal(w.status, 'synced', 'a skipped tx does not fail the watcher');
});

test('watcher: decryptor timeout -> resubscribe, nothing lost', async (t) => {
  const { indexer, map, watch } = await setup(t, { decryptorTimeoutMs: 300 });
  const key = testViewingKey();
  map.replace({ h1: [coin(4)], __hangRaws: ['h1'] });
  indexer.addTransaction(key, { raw: 'h1' });
  const w = watch(key);
  await waitFor(() => w.status === 'error' && /decryptor/.test(w.error), { what: 'decryptor error', timeoutMs: 5000 });
  map.set('__hangRaws', []);
  await waitFor(() => w.status === 'synced' && total(w) === 4n, { what: 'recovered', timeoutMs: 5000 });
});

test('watcher: stop disposes the subscription and disconnects the session', async (t) => {
  const { indexer, watch } = await setup(t);
  const key = testViewingKey();
  const w = watch(key);
  await waitFor(() => w.status === 'synced', { what: 'synced' });
  assert.equal(indexer.subscriptions(key), 1);
  const sessionId = w.sessionId;
  await w.stop();
  await waitFor(() => indexer.subscriptions(key) === 0, { what: 'subscription closed' });
  assert.deepEqual(indexer.calls.disconnect, [sessionId]);
});

// Sync rule (coordinator, from lane A's run of indexer 4.4.0-rc.1): progress
// numbers alone cannot tell that a new session has caught up.
function statusLog(w) {
  const t0 = Date.now();
  const log = [];
  let prev = w.status;
  w.on('change', () => {
    if (w.status !== prev) log.push({ status: w.status, at: Date.now() - t0 });
    prev = w.status;
  });
  return log;
}

test('sync rule: no `synced` before syncMinMs, even when progress says checked >= highest', async (t) => {
  const { watch, tx } = await setup(t, { syncMinMs: 400, syncQuietMs: 150, progressEveryMs: 50 });
  const key = testViewingKey();
  tx(key, [coin(1)]);
  const w = watch(key);
  const log = statusLog(w);
  await waitFor(() => w.lastEventAt && total(w) === 1n, { what: 'first events' });
  assert.equal(w.status, 'syncing', 'first progress event (immediate) does not count');
  await waitFor(() => w.status === 'synced', { what: 'synced', timeoutMs: 3000 });
  const synced = log.find((e) => e.status === 'synced');
  assert.ok(synced.at >= 380, `synced only after syncMinMs (got ${synced.at} ms)`);
});

test('sync rule: a transaction just before the progress event delays `synced` by syncQuietMs', async (t) => {
  const { watch, tx } = await setup(t, { syncMinMs: 200, syncQuietMs: 500, progressEveryMs: 50 });
  const key = testViewingKey();
  const w = watch(key);
  await waitFor(() => w.lastEventAt, { what: 'subscribed' });
  const startedAt = Date.now();
  await new Promise((r) => setTimeout(r, 150));
  tx(key, [coin(2)]); // a late-arriving transaction (like the genesis tx a few seconds after connect)
  const txAt = Date.now();
  await waitFor(() => total(w) === 2n, { what: 'tx counted' });
  await new Promise((r) => setTimeout(r, 200)); // past syncMinMs, inside the quiet window
  assert.equal(w.status, 'syncing', `still syncing ${Date.now() - startedAt} ms after start, ${Date.now() - txAt} ms after the tx`);
  await waitFor(() => w.status === 'synced', { what: 'synced', timeoutMs: 3000 });
  assert.ok(Date.now() - txAt >= 480, 'synced only after the quiet window');
});

test('sync rule: once caught up, live transactions keep `synced`; behind or reconnect resets', async (t) => {
  const { indexer, watch, tx } = await setup(t, { syncMinMs: 150, syncQuietMs: 100, progressEveryMs: 40 });
  const key = testViewingKey();
  const w = watch(key);
  await waitFor(() => w.status === 'synced', { what: 'synced', timeoutMs: 3000 });
  const log = statusLog(w);
  tx(key, [coin(3)]);
  await waitFor(() => total(w) === 3n, { what: 'live tx' });
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(log, [], 'no flip to syncing after a live transaction');
  indexer.setProgress({ highestEndIndex: 12, highestCheckedEndIndex: 11, highestRelevantEndIndex: 0 });
  await waitFor(() => w.status === 'syncing', { what: 'behind -> syncing' });
  indexer.setProgress({ highestEndIndex: 12, highestCheckedEndIndex: 12, highestRelevantEndIndex: 0 });
  await waitFor(() => w.status === 'synced', { what: 'synced again' });
  indexer.dropSockets();
  await waitFor(() => w.status === 'error', { what: 'error after drop' });
  await waitFor(() => w.status === 'syncing', { what: 'syncing after reconnect' });
  await waitFor(() => w.status === 'synced', { what: 'synced after reconnect', timeoutMs: 3000 });
});
