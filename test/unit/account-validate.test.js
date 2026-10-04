'use strict';
// AA 00059 P1 (T1.5-T1.7): the registration checks in the frozen order of plan I-4, the strict
// signature rules, and the expiry window. Steps 12-16 run against Night Market's own account states
// (test/fixtures/nm/vectors.json) through a mock chain reader.

const test = require('node:test');
const assert = require('node:assert/strict');
const { PublicKey } = require('@solana/web3.js');

const { renderRegistrationText } = require('../../src/accounts/message');
const { checkRequest, validateRegistration } = require('../../src/accounts/validate');
const { AccountApiError, CODES } = require('../../src/accounts/errors');
const { loadNightMarket } = require('../../src/accounts/bundle');
const keys = require('../helpers/nm-keys');
const V = require('../fixtures/nm/vectors.json');

const ORIGIN = 'http://127.0.0.1:18899';
const NOW = 1_790_000_000;
const TTL = 600;
const state = (name) => V.states.find((s) => s.name === name);
const b58 = (hex) => new PublicKey(Buffer.from(hex, 'hex')).toBase58();
const L = (1n << 252n) + 27742317777372353535851937790883648493n;
const leHex = (v) => {
  const b = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) b[i] = Number((v >> BigInt(8 * i)) & 0xffn);
  return b.toString('hex');
};
const leBig = (hex) => [...Buffer.from(hex, 'hex')].reduceRight((a, x) => (a << 8n) | BigInt(x), 0n);

let nm;
test.before(async () => {
  nm = await loadNightMarket();
});

/** A valid body for device `dev` and account `acct`, signed by `signer` (default the device). */
function body({ dev = 'A', acct = keys.accountHex('A'), enc = 'K1', signer = dev, expiresAt = NOW + 300, origin = ORIGIN, networkId = 'undeployed', edit } = {}) {
  const solanaAddress = b58(keys.deviceKeyHex(dev));
  let message = renderRegistrationText({ origin, networkId, solanaAddress, accountAddress: acct, expiresAt });
  if (edit) message = edit(message);
  const signature = Buffer.from(keys.deviceKey(signer).sign(Buffer.from(message, 'utf8'))).toString('hex');
  return { solanaAddress, accountAddress: acct, accountViewingKey: keys.encSecretHex(enc), message, signature };
}

function ctx(over = {}) {
  const steps = [];
  const reads = [];
  const chainState = over.chainState === undefined ? 'ok' : over.chainState;
  return {
    steps,
    reads,
    origin: ORIGIN,
    networkId: 'undeployed',
    maxTtlSeconds: TTL,
    now: () => NOW,
    nm,
    pinnedKeys: nm.PINNED_ACCOUNT_KEYS.circuits,
    trace: (s) => steps.push(s),
    chain: {
      async readAccountState(address) {
        reads.push(address);
        if (chainState === 'down') throw new Error('ECONNREFUSED');
        if (chainState === null) return null;
        return { state: state(chainState).state, blockHeight: 100 };
      },
    },
    ...over,
  };
}

async function expectCode(b, code, c = ctx()) {
  await assert.rejects(validateRegistration(b, c), (e) => {
    assert.ok(e instanceof AccountApiError, `${code}: ${e && e.stack}`);
    assert.equal(e.code, code, e.message);
    assert.equal(e.status, CODES[code]);
    return true;
  });
  return c;
}

test('positive: a device-signed v1 text for its account passes all 16 steps', async () => {
  const c = ctx();
  const r = await validateRegistration(body(), c);
  assert.deepEqual(c.steps, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  assert.equal(r.accountAddress, keys.accountHex('A'));
  assert.equal(r.useCounter, 3n);
  assert.equal(r.encPublicKey, nm.encPublicKeyOf(keys.encSecretHex('K1')));
  assert.equal(r.viewingKey, keys.encSecretHex('K1'));
});

test('T1.5 validation order: each of steps 1-11 answers its code; no later step and no chain read', async () => {
  const good = body();
  const cases = [
    [1, 'malformed', null],
    [1, 'malformed', []],
    [1, 'malformed', { ...good, signature: undefined }],
    [1, 'malformed', { ...good, message: 42 }],
    [2, 'bad-solana-address', { ...good, solanaAddress: 'not base58!' }],
    [2, 'bad-solana-address', { ...good, solanaAddress: `1${good.solanaAddress}` }],
    [3, 'bad-account-address', { ...good, accountAddress: good.accountAddress.slice(1) }],
    [3, 'bad-account-address', { ...good, accountAddress: `${good.accountAddress}0` }],
    [3, 'bad-account-address', { ...good, accountAddress: `0x${good.accountAddress}` }],
    [3, 'bad-account-address', { ...good, accountAddress: `${good.accountAddress.slice(1)}g` }],
    [4, 'bad-viewing-key', { ...good, accountViewingKey: 'mn_shield-esk_undeployed1qqq' }],
    [5, 'malformed', { ...good, signature: good.signature.slice(2) }],
    [6, 'bad-message', { ...good, message: good.message.replace(/\n/g, '\r\n') }],
    [7, 'message-mismatch', body({ edit: (t) => t.replace(keys.accountHex('A'), keys.accountHex('B')) })],
    [7, 'message-mismatch', { ...body(), solanaAddress: b58(keys.deviceKeyHex('B')) }],
    [8, 'wrong-origin', body({ origin: 'http://127.0.0.1:18900' })],
    [9, 'wrong-network', body({ networkId: 'stagenet' })],
    [10, 'expired', body({ expiresAt: NOW - 1 })],
    [10, 'expiry-too-far', body({ expiresAt: NOW + TTL + 1 })],
    [11, 'bad-signature', body({ signer: 'B' })],
  ];
  for (const [step, code, b] of cases) {
    const c = await expectCode(b, code);
    assert.equal(c.steps.at(-1), step, `${code}: stopped at step ${c.steps.at(-1)}, not ${step}`);
    assert.deepEqual(c.steps, Array.from({ length: step }, (_, i) => i + 1));
    assert.equal(c.reads.length, 0, `${code}: the chain was read`);
  }
  // The body's account is compared lowercased with the text's.
  const upper = { ...body(), accountAddress: keys.accountHex('A').toUpperCase() };
  assert.equal((await validateRegistration(upper, ctx())).accountAddress, keys.accountHex('A'));
});

test('steps 12-16 against Night Market\'s own account states (mock chain), each with its code', async () => {
  const cases = [
    ['down', 'indexer-unavailable', 12],
    [null, 'account-not-found', 12],
    ['vk-different', 'not-passport-account', 13],
    ['vk-extra', 'not-passport-account', 13],
    ['authority-live', 'not-passport-account', 13],
    ['not-booted', 'not-passport-account', 13],
    ['stagenet-account-a', 'not-passport-account', 13],
    ['stagenet-salt', 'wrong-network', 14],
    ['counter-300', 'not-a-device', 15],
    ['ok-inbox-k2', 'enc-key-mismatch', 16],
  ];
  for (const [chainState, code, step] of cases) {
    const c = await expectCode(body(), code, ctx({ chainState }));
    assert.equal(c.steps.at(-1), step, `${chainState}: stopped at ${c.steps.at(-1)}`);
  }
  // B's key for A's account: a valid signature by B, but B is not A's device.
  await expectCode(body({ dev: 'B' }), 'not-a-device');
  // Another account's secret.
  await expectCode(body({ enc: 'K2' }), 'enc-key-mismatch');
  // The detail names what differs, never the viewing key.
  await assert.rejects(validateRegistration(body(), ctx({ chainState: 'vk-extra' })), (e) => e.detail.includes('extra: add_device_with_ed25519'));
  // Device scan: entry at counter 7 with auth nonce 9 is found.
  assert.equal((await validateRegistration(body(), ctx({ chainState: 'scan-7-of-9' }))).useCounter, 7n);
  // The rotated key: K2's secret registers against the K2 state.
  assert.equal((await validateRegistration(body({ enc: 'K2' }), ctx({ chainState: 'ok-inbox-k2' }))).encPublicKey, nm.encPublicKeyOf(keys.encSecretHex('K2')));
});

test('T1.6 signatures: strict verification (flipped bit, s + L, R = identity, other key, other text)', async () => {
  const good = body();
  assert.ok(checkRequest(good, ctx()));
  const sig = good.signature;
  const flip = (hex, i) => {
    const b = Buffer.from(hex, 'hex');
    b[i] ^= 1;
    return b.toString('hex');
  };
  const sPlusL = sig.slice(0, 64) + leHex(leBig(sig.slice(64)) + L);
  const rIdentity = `01${'00'.repeat(31)}${sig.slice(64)}`;
  const other = body({ signer: 'B' }).signature;
  const otherText = body({ edit: (t) => t.replace('balances.', 'balances!') });
  for (const [name, b] of [
    ['flipped bit in R', { ...good, signature: flip(sig, 3) }],
    ['flipped bit in s', { ...good, signature: flip(sig, 40) }],
    ['s + L', { ...good, signature: sPlusL }],
    ['R = identity', { ...good, signature: rIdentity }],
    ['another key', { ...good, signature: other }],
    ['zero signature', { ...good, signature: '00'.repeat(64) }],
  ]) {
    assert.throws(() => checkRequest(b, ctx()), (e) => e.code === 'bad-signature', name);
  }
  // One character changed: the text is no longer the template (bad-message) or, if it still parses,
  // the signature fails. Change the signed bytes but keep the grammar: re-sign one text, send another.
  const t1 = body({ expiresAt: NOW + 300 });
  const t2 = body({ expiresAt: NOW + 301 });
  assert.throws(() => checkRequest({ ...t2, signature: t1.signature }, ctx()), (e) => e.code === 'bad-signature');
  assert.throws(() => checkRequest(otherText, ctx()), (e) => e.code === 'bad-message');
  // Identity and small-order keys are refused at step 2 (the inputs of Night Market's negatives step).
  const weak = [
    `01${'00'.repeat(31)}`, // the identity
    '00'.repeat(32), // order 4
    `ec${'ff'.repeat(30)}7f`, // order 2 (y = -1)
    '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05', // order 8
    'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a', // order 8
  ];
  for (const k of weak) {
    assert.throws(() => checkRequest({ ...good, solanaAddress: b58(k) }, ctx()), (e) => e.code === 'bad-solana-address', k);
  }
});

test('T1.7 expiry boundaries: now - 1 expired, now + maxTtl accepted, now + maxTtl + 1 too far', () => {
  assert.throws(() => checkRequest(body({ expiresAt: NOW - 1 }), ctx()), (e) => e.code === 'expired');
  assert.throws(() => checkRequest(body({ expiresAt: NOW }), ctx()), (e) => e.code === 'expired');
  assert.ok(checkRequest(body({ expiresAt: NOW + 1 }), ctx()));
  assert.ok(checkRequest(body({ expiresAt: NOW + TTL }), ctx()));
  assert.throws(() => checkRequest(body({ expiresAt: NOW + TTL + 1 }), ctx()), (e) => e.code === 'expiry-too-far');
});

test('errors carry the frozen HTTP statuses and never the viewing key', async () => {
  assert.equal(CODES['bad-signature'], 401);
  assert.equal(CODES['indexer-unavailable'], 503);
  assert.equal(CODES['account-not-found'], 404);
  for (const code of ['not-passport-account', 'not-a-device', 'enc-key-mismatch']) assert.equal(CODES[code], 403);
  const b = body({ enc: 'K2' });
  await assert.rejects(validateRegistration(b, ctx()), (e) => {
    const json = JSON.stringify(e.toJSON());
    assert.ok(!json.includes(b.accountViewingKey));
    assert.deepEqual(Object.keys(e.toJSON()).sort(), ['code', 'error']);
    return true;
  });
});
