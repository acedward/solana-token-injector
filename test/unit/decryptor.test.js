'use strict';
// C.6: decryptor client (I-1 JSON lines) against the fake decryptor:
// ids, concurrency, errors, restart with backoff, queueing, retry, timeout.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DecryptorClient, DecryptError } = require('../../src/midnight/decryptor');
const { createFakeMap, FAKE_DECRYPTOR } = require('../helpers/fake-map');
const { testViewingKey } = require('../helpers/keys');
const { waitFor } = require('../helpers/service');

const KEY = testViewingKey('undeployed');
const OTHER = testViewingKey('undeployed');
const T0 = '0'.repeat(64);
const hex = (n) => n.toString(16).padStart(64, '0');
const coin = (n, extra = {}) => ({ segment: 0, outputIndex: n, commitment: hex(n), tokenType: T0, value: String(n * 10), ...extra });

function setup(t, initial = {}, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sti-dec-'));
  const map = createFakeMap(path.join(dir, 'map.json'), initial);
  const client = new DecryptorClient({
    bin: opts.bin || FAKE_DECRYPTOR,
    env: { ...process.env, FAKE_DECRYPTOR_MAP: map.file },
    timeoutMs: opts.timeoutMs || 3000,
    minBackoffMs: 50,
    maxBackoffMs: 400,
  }).start();
  t.after(async () => {
    await client.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { client, map };
}

test('version, validateKey and decrypt (I-1)', async (t) => {
  const { client } = setup(t, { aa: [coin(1), coin(2, { viewingKey: OTHER })], bb: { error: 'undecodable transaction' } });
  const v = await client.request({ op: 'version' });
  assert.deepEqual([v.ok, v.version], [true, '0.0.0-fake']);
  assert.deepEqual(await client.validateKey('undeployed', KEY), { ok: true });
  assert.equal((await client.validateKey('preprod', KEY)).ok, false);
  assert.deepEqual(await client.decrypt('undeployed', KEY, 'aa'), [coin(1)], 'coins of other keys filtered');
  assert.deepEqual((await client.decrypt('undeployed', OTHER, 'aa')).length, 2);
  await assert.rejects(client.decrypt('undeployed', KEY, 'bb'), (e) => e instanceof DecryptError && /undecodable/.test(e.message));
  await waitFor(() => client.status().version === '0.0.0-fake', { what: 'version in status' });
  assert.equal(client.status().ok, true);
});

test('50 concurrent requests are matched by id', async (t) => {
  const map = {};
  for (let i = 1; i <= 50; i++) map[`r${i}`] = [coin(i)];
  const { client } = setup(t, map);
  const out = await Promise.all(Array.from({ length: 50 }, (_, i) => client.decrypt('undeployed', KEY, `r${i + 1}`)));
  out.forEach((coins, i) => assert.equal(coins[0].outputIndex, i + 1));
});

test('restart on exit with backoff; requests queue while restarting', async (t) => {
  const { client } = setup(t, { aa: [coin(1)] });
  await client.request({ op: 'version' });
  client.child.stdin.write('{"op":"__exit","code":3}\n'); // the fake crashes
  await waitFor(() => client.status().state === 'restarting', { what: 'restarting state' });
  assert.match(client.status().lastError, /exited \(3\)/);
  const queued = client.decrypt('undeployed', KEY, 'aa'); // queued while the process is down
  assert.deepEqual(await queued, [coin(1)], 'a request queued during the restart completes');
  assert.equal(client.status().restarts, 1);
  assert.equal(client.status().ok, true);
  // Backoff grows on consecutive crashes and resets after a good answer.
  client.child.stdin.write('{"op":"__exit","code":4}\n');
  await waitFor(() => client.status().restarts === 2 && client.status().ok, { what: 'second restart' });
  assert.deepEqual(await client.decrypt('undeployed', KEY, 'aa'), [coin(1)]);
  assert.equal(client.backoff, 50, 'backoff reset after a successful answer');
});

test('an in-flight request survives a crash (retried once)', async (t) => {
  const { client, map } = setup(t, { aa: [coin(1)], __delayMs: 300 });
  await waitFor(() => client.status().ok, { what: 'running' });
  const p = client.decrypt('undeployed', KEY, 'aa');
  await new Promise((r) => setTimeout(r, 50));
  client.child.kill('SIGKILL');
  map.set('__delayMs', 0);
  assert.deepEqual(await p, [coin(1)]);
  assert.equal(client.status().restarts, 1);
});

test('a request with no answer times out and the stuck process is replaced', async (t) => {
  const { client } = setup(t, { aa: [coin(1)], hang: [], __hangRaws: ['hang'] }, { timeoutMs: 300 });
  await assert.rejects(client.decrypt('undeployed', KEY, 'hang'), /timeout after 300 ms/);
  await waitFor(() => client.status().restarts >= 1 && client.status().ok, { what: 'restart after timeout' });
  assert.deepEqual(await client.decrypt('undeployed', KEY, 'aa'), [coin(1)]);
});

test('missing binary: status reports it, requests time out, no crash', async (t) => {
  const { client } = setup(t, {}, { bin: '/nonexistent/midnight-esk-decrypt', timeoutMs: 200 });
  await assert.rejects(client.validateKey('undeployed', KEY), /timeout/);
  const s = client.status();
  assert.equal(s.ok, false);
  assert.match(s.lastError, /binary not found/);
});

test('stop() rejects pending requests and ends the child', async (t) => {
  const { client } = setup(t, { __hangRaws: ['hang'] });
  await waitFor(() => client.status().ok, { what: 'running' });
  const child = client.child;
  const p = assert.rejects(client.decrypt('undeployed', KEY, 'hang'), /stopped/);
  await new Promise((r) => setTimeout(r, 50));
  await client.stop();
  await p;
  assert.notEqual(child.exitCode === null && child.signalCode === null, true, 'child exited');
  await assert.rejects(client.request({ op: 'version' }), /stopped/);
});
