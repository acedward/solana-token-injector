'use strict';
// C.8: HTTP routes on the one server (Q7): registrations API, /health, CORS,
// masking (Q10), no full key in API or logs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Keypair } = require('@solana/web3.js');
const { startStack } = require('../helpers/stack');
const { startMockUpstream } = require('../helpers/mock-upstream');
const { startService, waitFor } = require('../helpers/service');
const { testViewingKey } = require('../helpers/keys');

test('registrations API and /health', async (t) => {
  const stack = await startStack({ configExtra: { log: 'verbose' } });
  t.after(() => stack.stop());
  const { svc } = stack;
  const addr = Keypair.generate().publicKey.toBase58();
  const key = testViewingKey();
  let id;

  await t.test('POST creates (201), the same pair again returns it (200)', async () => {
    const r = await stack.register(addr, key);
    assert.equal(r.status, 201);
    assert.match(r.json.id, /^[0-9a-f]{16}$/);
    assert.equal(r.json.solanaAddress, addr);
    assert.equal(r.json.viewingKeyMasked, `${key.slice(0, 16)}…${key.slice(-6)}`);
    assert.equal(r.json.networkId, 'undeployed');
    assert.ok(['connecting', 'syncing', 'synced'].includes(r.json.status));
    assert.deepEqual(r.json.tokens, []);
    assert.ok(!r.text.includes(key), 'response never contains the full key');
    id = r.json.id;
    const again = await stack.register(addr, key);
    assert.equal(again.status, 200);
    assert.equal(again.json.id, id);
    assert.equal((await stack.list()).length, 1);
  });

  await t.test('invalid inputs: 400 with a message, nothing stored', async () => {
    const cases = [
      [{ solanaAddress: 'nope', viewingKey: key }, /Solana address/],
      [{ solanaAddress: addr, viewingKey: 'mn_shield-esk_undeployed1qqqq' }, /bech32m/],
      [{ solanaAddress: addr, viewingKey: testViewingKey('preprod') }, /network "preprod"/],
      [{ solanaAddress: addr }, /viewing key is required/],
    ];
    for (const [body, re] of cases) {
      const r = await svc.api('POST', '/api/registrations', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.json.error, re);
    }
    const bad = await svc.api('POST', '/api/registrations', '{not json');
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /must be JSON/);
    const rejected = testViewingKey();
    stack.map.set('__rejectKeys', [rejected]); // well-formed, but the decryptor says no
    const rr = await stack.register(addr, rejected);
    assert.equal(rr.status, 400);
    assert.match(rr.json.error, /viewing key rejected: invalid viewing key: not a field element/);
    assert.equal((await stack.list()).length, 1, 'nothing stored by the failures');
  });

  await t.test('GET one, 404s and 405s', async () => {
    assert.equal((await svc.api('GET', `/api/registrations/${id}`)).json.id, id);
    assert.equal((await svc.api('GET', '/api/registrations/0123456789abcdef')).status, 404);
    assert.equal((await svc.api('DELETE', '/api/registrations/zzz')).status, 404);
    assert.equal((await svc.api('PUT', '/api/registrations', {})).status, 405);
    assert.equal((await svc.api('GET', '/api/nothing')).status, 404);
  });

  await t.test('/health reports upstream, indexer, decryptor and registrations', async () => {
    await waitFor(async () => (await svc.api('GET', '/health')).json.decryptor.version, { what: 'decryptor version' });
    const h = (await svc.api('GET', '/health')).json;
    assert.equal(h.ok, true);
    assert.deepEqual(h.upstream, { ok: true });
    assert.equal(h.indexer.ok, true);
    assert.equal(h.indexer.networkId, 'undeployed');
    assert.equal(h.decryptor.ok, true);
    assert.equal(h.decryptor.version, '0.0.0-fake');
    assert.equal(h.registrations.total, 1);
    assert.ok(!JSON.stringify(h).includes(stack.upstream.url), 'no upstream URL (it may carry an API key)');
  });

  await t.test('CORS preflight allows DELETE; API answers carry CORS', async () => {
    const r = await fetch(`${svc.url}/api/registrations/${id}`, { method: 'OPTIONS' });
    assert.equal(r.status, 204);
    assert.match(r.headers.get('access-control-allow-methods'), /DELETE/);
    assert.equal((await svc.api('GET', '/api/registrations')).headers.get('access-control-allow-origin'), '*');
  });

  await t.test('data file holds the key at rest (Q10), mode 0600; logs never hold it', async () => {
    const file = path.join(stack.config.dataDir, 'registrations.json');
    assert.ok(fs.readFileSync(file, 'utf8').includes(key));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(svc.output().includes(`${key.slice(0, 16)}…${key.slice(-6)}`), 'verbose log shows the masked key');
    assert.ok(!svc.output().includes(key), 'service output never contains the full key');
    assert.ok(!JSON.stringify(await stack.list()).includes(key));
  });

  await t.test('DELETE: 204, then 404', async () => {
    assert.equal((await svc.api('DELETE', `/api/registrations/${id}`)).status, 204);
    assert.equal((await svc.api('DELETE', `/api/registrations/${id}`)).status, 404);
    assert.deepEqual(await stack.list(), []);
  });
});

test('without a midnight block the API says so (503) and RPC still works', async (t) => {
  const up = await startMockUpstream();
  const wallet = Keypair.generate().publicKey.toBase58();
  const svc = await startService({ config: { upstream: up.url, tokens: [{ name: 'Night', symbol: 'NIGHT', balances: { [wallet]: '1' } }] } });
  t.after(async () => {
    await svc.stop();
    await up.close();
  });
  const r = await svc.api('GET', '/api/registrations');
  assert.equal(r.status, 503);
  assert.match(r.json.error, /not configured/);
  const h = (await svc.api('GET', '/health')).json;
  assert.equal(h.ok, true);
  assert.equal(h.indexer.configured, false);
  assert.equal((await svc.rpc('getBalance', [wallet])).result.value, 1000000000);
});
