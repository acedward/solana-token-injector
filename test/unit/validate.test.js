'use strict';
// C.5: registration validation (FR-103). Messages must be clear and must never echo the key.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const bs58 = require('bs58').default || require('bs58');
const { Keypair } = require('@solana/web3.js');
const { validateRegistration, validateSolanaAddress, validateViewingKeyFormat, viewingKeyHrp, ValidationError } = require('../../src/registry/validate');
const { testViewingKey, KNOWN_KEY } = require('../helpers/keys');

const addr = Keypair.generate().publicKey.toBase58();
const okDecryptor = { validateKey: async () => ({ ok: true }) };

async function rejects(body, re, { status = 400, networkId = 'undeployed', decryptor = okDecryptor } = {}) {
  await assert.rejects(validateRegistration(body, { networkId, decryptor }), (e) => {
    assert.ok(e instanceof ValidationError, `ValidationError, got ${e}`);
    assert.equal(e.status, status);
    assert.match(e.message, re);
    if (body && typeof body.viewingKey === 'string' && body.viewingKey.length > 20) {
      assert.ok(!e.message.includes(body.viewingKey), 'message never echoes the key');
    }
    return true;
  });
}

test('HRP rule (I-1): mn_shield-esk on mainnet, else mn_shield-esk_<networkId>', () => {
  assert.equal(viewingKeyHrp('mainnet'), 'mn_shield-esk');
  assert.equal(viewingKeyHrp('undeployed'), 'mn_shield-esk_undeployed');
});

test('valid pair passes; the toolkit known-answer key is accepted', async () => {
  const r = await validateRegistration({ solanaAddress: ` ${addr} `, viewingKey: KNOWN_KEY }, { networkId: 'undeployed', decryptor: okDecryptor });
  assert.deepEqual(r, { solanaAddress: addr, viewingKey: KNOWN_KEY });
  const upper = await validateRegistration({ solanaAddress: addr, viewingKey: KNOWN_KEY.toUpperCase() }, { networkId: 'undeployed', decryptor: okDecryptor });
  assert.equal(upper.viewingKey, KNOWN_KEY, 'all-uppercase form normalized');
  const main = testViewingKey('mainnet');
  assert.equal(validateViewingKeyFormat(main, 'mainnet'), main);
});

test('invalid Solana addresses are rejected with a message', async () => {
  const key = testViewingKey();
  await rejects({ viewingKey: key }, /Solana address is required/);
  await rejects({ solanaAddress: 42, viewingKey: key }, /Solana address is required/);
  await rejects({ solanaAddress: '0OIl', viewingKey: key }, /base58/);
  await rejects({ solanaAddress: bs58.encode(crypto.randomBytes(31)), viewingKey: key }, /32-byte public key/);
  await rejects({ solanaAddress: bs58.encode(crypto.randomBytes(33)), viewingKey: key }, /32-byte public key/);
  assert.throws(() => validateSolanaAddress(`1${addr}`), /32-byte|canonical/);
});

test('malformed and wrong-network viewing keys are rejected with a message', async () => {
  await rejects({ solanaAddress: addr }, /viewing key is required/);
  await rejects({ solanaAddress: addr, viewingKey: 'hello' }, /not a valid bech32m string/);
  await rejects({ solanaAddress: addr, viewingKey: `${KNOWN_KEY.slice(0, -1)}q` }, /not a valid bech32m string/);
  await rejects({ solanaAddress: addr, viewingKey: testViewingKey('undeployed', { checksum: 'bech32' }) }, /bech32 checksum.*bech32m/);
  await rejects({ solanaAddress: addr, viewingKey: testViewingKey('preprod') }, /network "preprod", this service runs on "undeployed"/);
  await rejects({ solanaAddress: addr, viewingKey: testViewingKey('mainnet') }, /network "mainnet"/);
  await rejects({ solanaAddress: addr, viewingKey: testViewingKey('x', { hrp: 'mn_shield-addr_undeployed' }) }, /shielded address/);
  await rejects({ solanaAddress: addr, viewingKey: testViewingKey('x', { hrp: 'mn_dust_undeployed' }) }, /"mn_dust_undeployed" string, not a viewing key/);
  await rejects({ solanaAddress: addr, viewingKey: testViewingKey('x', { hrp: 'bc' }) }, /must start with mn_shield-esk_undeployed1/);
  await rejects({ solanaAddress: addr, viewingKey: testViewingKey('undeployed', { bytes: 31 }) }, /31 bytes, expected 32/);
  await rejects('nope', /JSON object/);
  await rejects([addr], /JSON object/);
});

test('the decryptor has the final word (I-1 validateKey)', async () => {
  const key = testViewingKey();
  await rejects({ solanaAddress: addr, viewingKey: key }, /viewing key rejected: scalar out of range/, {
    decryptor: { validateKey: async () => ({ ok: false, error: 'scalar out of range' }) },
  });
  await rejects({ solanaAddress: addr, viewingKey: key }, /decryptor unavailable/, {
    status: 503,
    decryptor: { validateKey: async () => { throw new Error(`down while checking ${key}`); } },
  });
  let seen = null;
  await validateRegistration({ solanaAddress: addr, viewingKey: key }, { networkId: 'undeployed', decryptor: { validateKey: async (n, k) => { seen = [n, k]; return { ok: true }; } } });
  assert.deepEqual(seen, ['undeployed', key]);
});
