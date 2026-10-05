'use strict';
// AA 00059 P3 (T3.1-T3.7): the account registration API (I-4, FROZEN) in the real service process,
// with the mock indexer serving Night Market's own account states and real Ed25519 signatures.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { PublicKey } = require('@solana/web3.js');
const spl = require('@solana/spl-token');

const { startStack } = require('../helpers/stack');
const { waitFor } = require('../helpers/service');
const { renderRegistrationText } = require('../../src/accounts/message');
const { deriveKey } = require('../../src/tokens/accounts');
const { midnightTokenId } = require('../../src/tokens/midnight');
const { loadNightMarket } = require('../../src/accounts/bundle');
const keys = require('../helpers/nm-keys');
const { V, state, depositsAll } = require('../helpers/account-chain');

const A = keys.accountHex('A');
const OTHER = keys.accountHex('other');
const X = V.colours.X;
const T22 = spl.TOKEN_2022_PROGRAM_ID.toBase58();
const walletOf = (label) => new PublicKey(Buffer.from(keys.deviceKeyHex(label), 'hex')).toBase58();
const mintOf = (key) => deriveKey(`mint:${midnightTokenId('undeployed', key)}`).toBase58();

let nm;
test.before(async () => {
  nm = await loadNightMarket();
});

async function setup(t, { accounts = { pollMs: 300 }, log = false } = {}) {
  const stack = await startStack({ midnightExtra: { accounts }, configExtra: { log } });
  t.after(() => stack.stop());
  stack.indexer.setContract(A, { state: state('ok-inbox').state, actions: depositsAll(A), deployHeight: 5 });
  const origin = `http://127.0.0.1:${stack.svc.port}`;
  const body = ({ dev = 'A', acct = A, enc = 'K1', signer = dev, expiresAt = Math.floor(Date.now() / 1000) + 300, o = origin, networkId = 'undeployed', sig } = {}) => {
    const solanaAddress = walletOf(dev);
    const message = renderRegistrationText({ origin: o, networkId, solanaAddress, accountAddress: /^[0-9a-f]{64}$/.test(acct) ? acct : A, expiresAt });
    const signature = sig ?? Buffer.from(keys.deviceKey(signer).sign(Buffer.from(message, 'utf8'))).toString('hex');
    return { solanaAddress, accountAddress: acct, accountViewingKey: keys.encSecretHex(enc), message, signature };
  };
  const post = (b) => stack.svc.api('POST', '/api/accounts', b);
  const list = async () => (await stack.svc.api('GET', '/api/accounts')).json;
  const file = path.join(stack.config.dataDir, 'accounts.json');
  const fileBytes = () => (fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0));
  return { stack, origin, body, post, list, file, fileBytes };
}

async function amounts(svc, owner) {
  const r = await svc.rpc('getTokenAccountsByOwner', [owner, { programId: T22 }, { encoding: 'jsonParsed' }]);
  return Object.fromEntries(r.result.value.map((a) => [a.account.data.parsed.info.mint, a.account.data.parsed.info.tokenAmount.amount]));
}

test('T3.1 positive: 201, then 200 with the same id; masked views; the RPC lists the tokens after the first poll', async (t) => {
  const s = await setup(t);
  const info = (await s.stack.svc.api('GET', '/api/accounts/registration-info')).json;
  assert.deepEqual(info, { format: 'solana-token-injector account registration v1', origin: s.origin, networkId: 'undeployed', maxTtlSeconds: 600 });
  const b = s.body();
  const r1 = await s.post(b);
  assert.equal(r1.status, 201, r1.text);
  assert.equal(r1.json.created, true);
  assert.equal(r1.json.replacedKey, false);
  assert.equal(r1.json.keyFingerprint, nm.encPublicKeyOf(keys.encSecretHex('K1')).slice(0, 8));
  assert.equal(r1.json.heldKeys, 1);
  assert.equal(r1.json.accountAddress, A);
  const r2 = await s.post(s.body());
  assert.equal(r2.status, 200);
  assert.equal(r2.json.id, r1.json.id);
  assert.equal(r2.json.created, false);
  const one = (await s.stack.svc.api('GET', `/api/accounts/${r1.json.id}`)).json;
  assert.equal(one.id, r1.json.id);
  assert.equal('created' in one, false);
  assert.deepEqual(Object.keys(one).sort(), ['accountAddress', 'createdAt', 'error', 'heldKeys', 'history', 'id', 'keyFingerprint', 'lastCheckedAt', 'networkId', 'solanaAddress', 'status', 'tokens', 'unconfirmedNotes', 'unreadableEntries', 'unseenCoins', 'updatedAt']);
  await waitFor(async () => (await amounts(s.stack.svc, walletOf('A')))[mintOf(X)] === '500000000', { what: 'tokens in the RPC', timeoutMs: 8000 });
  const synced = (await s.list())[0];
  assert.equal(synced.status, 'synced');
  assert.deepEqual(synced.history, { complete: true, throughHeight: 13 });
  assert.equal(synced.unreadableEntries, 2);
  assert.deepEqual(synced.tokens.map((x) => [x.tokenType, x.privacy, x.amount]), [[X, 'shielded', '500000000'], [V.colours.Y, 'shielded', '7']].sort());
  assert.equal((await s.stack.svc.api('GET', '/api/accounts/0123456789abcdef')).status, 404);
  assert.equal((await s.stack.svc.api('GET', '/api/accounts/0123456789abcdef')).json.code, 'not-found');
});

test('T3.2 every negative of SC-202 fails closed with its code; nothing stored', async (t) => {
  const s = await setup(t);
  // States served at other addresses (steps 13-14 fail before the device check).
  const at = (label, name) => {
    const addr = keys.accountHex(label);
    s.stack.indexer.setContract(addr, { state: state(name).state, actions: [], deployHeight: 5 });
    return addr;
  };
  const vkDiff = at('vkd', 'vk-different');
  const vkExtra = at('vke', 'vk-extra');
  const live = at('live', 'authority-live');
  const unbooted = at('unb', 'not-booted');
  const otherNet = at('net', 'stagenet-salt');
  const stagenetA = at('sta', 'stagenet-account-a');
  const forged = s.body();
  const cases = [
    ['forged signature (another key signs)', s.body({ signer: 'B' }), 401, 'bad-signature'],
    ['flipped signature bit', { ...forged, signature: `${forged.signature.slice(0, 10)}${forged.signature[10] === '0' ? '1' : '0'}${forged.signature.slice(11)}` }, 401, 'bad-signature'],
    ['B\'s key for A\'s account', s.body({ dev: 'B' }), 403, 'not-a-device'],
    ['account address of 63 hex', s.body({ acct: A.slice(1) }), 400, 'bad-account-address'],
    ['account address of 65 hex', s.body({ acct: `${A}0` }), 400, 'bad-account-address'],
    ['account address 0x + 64', s.body({ acct: `0x${A}` }), 400, 'bad-account-address'],
    ['account address non-hex', s.body({ acct: `${A.slice(1)}z` }), 400, 'bad-account-address'],
    ['another network in the text', s.body({ networkId: 'stagenet' }), 400, 'wrong-network'],
    ['an account of another network', s.body({ acct: otherNet }), 400, 'wrong-network'],
    ['another origin', s.body({ o: 'http://127.0.0.1:1' }), 400, 'wrong-origin'],
    ['expired', s.body({ expiresAt: Math.floor(Date.now() / 1000) - 5 }), 400, 'expired'],
    ['too far', s.body({ expiresAt: Math.floor(Date.now() / 1000) + 3600 }), 400, 'expiry-too-far'],
    ['another account\'s secret', s.body({ enc: 'K2' }), 403, 'enc-key-mismatch'],
    ['an unknown address', s.body({ acct: OTHER }), 404, 'account-not-found'],
    ['verifier keys differ', s.body({ acct: vkDiff }), 403, 'not-passport-account'],
    ['an extra circuit', s.body({ acct: vkExtra }), 403, 'not-passport-account'],
    ['a live authority', s.body({ acct: live }), 403, 'not-passport-account'],
    ['not booted', s.body({ acct: unbooted }), 403, 'not-passport-account'],
    ['the old stagenet key set', s.body({ acct: stagenetA }), 403, 'not-passport-account'],
  ];
  const before = s.fileBytes();
  for (const [name, b, status, code] of cases) {
    const r = await s.post(b);
    assert.equal(r.status, status, `${name}: ${r.text}`);
    assert.equal(r.json.code, code, `${name}: ${r.text}`);
    assert.ok(typeof r.json.error === 'string' && r.json.error.length > 0);
    assert.equal((await s.list()).length, 0, name);
    assert.ok(s.fileBytes().equals(before), `${name}: accounts.json changed`);
  }
  // The indexer down: 503 indexer-unavailable.
  s.stack.indexer.setDown(true);
  const r = await s.post(s.body());
  assert.equal(r.status, 503);
  assert.equal(r.json.code, 'indexer-unavailable');
  assert.equal((await s.list()).length, 0);
  assert.ok(s.fileBytes().equals(before));
});

test('T3.3 replace: a new key that derives the new enc_key -> 200 replacedKey, heldKeys 2', async (t) => {
  const s = await setup(t);
  const r1 = await s.post(s.body());
  assert.equal(r1.status, 201);
  s.stack.indexer.setState(A, state('ok-inbox-k2').state);
  // The old key is now refused (it does not open the current enc_key).
  assert.equal((await s.post(s.body())).json.code, 'enc-key-mismatch');
  const r2 = await s.post(s.body({ enc: 'K2' }));
  assert.equal(r2.status, 200, r2.text);
  assert.equal(r2.json.id, r1.json.id);
  assert.equal(r2.json.replacedKey, true);
  assert.equal(r2.json.heldKeys, 2);
  assert.equal(r2.json.keyFingerprint, nm.encPublicKeyOf(keys.encSecretHex('K2')).slice(0, 8));
  // The ring opens K1's and K2's notes: X = c1 + c3.
  await waitFor(async () => (await amounts(s.stack.svc, walletOf('A')))[mintOf(X)] === '501000000', { what: 'ring amounts', timeoutMs: 8000 });
  // The same K2 again: 200, nothing replaced.
  const r3 = await s.post(s.body({ enc: 'K2' }));
  assert.equal(r3.status, 200);
  assert.equal(r3.json.replacedKey, false);
});

test('T3.4 device counter: = auth nonce ok; 7 of nonce 9 ok (scan); only at 300 -> not-a-device', async (t) => {
  const s = await setup(t);
  s.stack.indexer.setState(A, state('scan-7-of-9').state);
  assert.equal((await s.post(s.body())).status, 201);
  s.stack.indexer.setState(A, state('counter-300').state);
  assert.equal((await s.post(s.body())).json.code, 'not-a-device');
  s.stack.indexer.setState(A, state('ok').state);
  assert.equal((await s.post(s.body())).status, 200);
});

test('T3.5 limits: a body over 16 KiB closes the connection; non-JSON -> 400 malformed; wrong methods -> 405', async (t) => {
  const s = await setup(t);
  const big = JSON.stringify({ ...s.body(), pad: 'x'.repeat(17 * 1024) });
  const closed = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: s.stack.svc.port, path: '/api/accounts', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(big) } }, (res) => {
      res.resume();
      res.on('end', () => resolve(`answered ${res.statusCode}`));
    });
    req.on('error', (e) => resolve(`closed: ${e.code}`));
    req.end(big);
  });
  assert.match(closed, /^closed: (ECONNRESET|EPIPE)/, closed);
  const bad = await s.stack.svc.api('POST', '/api/accounts', 'not json');
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'malformed');
  for (const [method, p, allow] of [['DELETE', '/api/accounts/0123456789abcdef', 'GET, OPTIONS'], ['PUT', '/api/accounts', 'GET, POST, OPTIONS'], ['POST', '/api/accounts/registration-info', 'GET, OPTIONS']]) {
    const r = await s.stack.svc.api(method, p, method === 'DELETE' ? undefined : {});
    assert.equal(r.status, 405, `${method} ${p}`);
    assert.equal(r.json.code, 'method-not-allowed');
    assert.equal(r.headers.get('allow'), allow);
  }
  assert.equal((await s.list()).length, 0);
});

test('T3.6 no viewing key in any response or log line', async (t) => {
  const s = await setup(t, { log: 'verbose' });
  const texts = [];
  for (const b of [s.body(), s.body(), s.body({ enc: 'K2' }), s.body({ dev: 'B' }), s.body({ signer: 'B' })]) texts.push((await s.post(b)).text);
  s.stack.indexer.setState(A, state('ok-inbox-k2').state);
  texts.push((await s.post(s.body({ enc: 'K2' }))).text);
  await waitFor(async () => (await s.list())[0].status === 'synced', { what: 'synced', timeoutMs: 8000 });
  texts.push((await s.stack.svc.api('GET', '/api/accounts')).text, (await s.stack.svc.api('GET', '/health')).text, (await s.stack.svc.api('GET', '/')).text);
  const secrets = ['K1', 'K2'].map((l) => keys.encSecretHex(l));
  const all = `${texts.join('\n')}\n${s.stack.svc.output()}`.toLowerCase();
  for (const sec of secrets) assert.ok(!all.includes(sec), 'a viewing key leaked');
  assert.match(s.stack.svc.output(), /account registration [0-9a-f]{16} added/);
});

test('accounts disabled: every account route answers 503 accounts-disabled; /health has no accounts', async (t) => {
  const s = await setup(t, { accounts: { enabled: false } });
  for (const [m, p] of [['GET', '/api/accounts'], ['POST', '/api/accounts'], ['GET', '/api/accounts/registration-info'], ['GET', '/api/accounts/0123456789abcdef']]) {
    const r = await s.stack.svc.api(m, p, m === 'POST' ? s.body() : undefined);
    assert.equal(r.status, 503, `${m} ${p}`);
    assert.equal(r.json.code, 'accounts-disabled');
  }
  assert.equal('accounts' in (await s.stack.svc.api('GET', '/health')).json, false);
  assert.match((await s.stack.svc.api('GET', '/')).text, /<table id="accounts">/);
});
