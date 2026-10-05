'use strict';
// AA 00059 P1 (T1.1-T1.4): the account registration text v1 (plan I-4, FROZEN at P1).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { PublicKey } = require('@solana/web3.js');

const m = require('../../src/accounts/message');
const { loadNightMarket } = require('../../src/accounts/bundle');

const EXAMPLE_FIELDS = {
  origin: 'http://127.0.0.1:18899',
  networkId: 'undeployed',
  solanaAddress: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
  accountAddress: '453b2b8d0000000000000000000000000000000000000000000000000000375a',
  expiresAt: Date.UTC(2026, 9, 5, 12, 34, 56) / 1000,
};
// The example of the plan's I-4, byte for byte.
const EXAMPLE_TEXT = [
  'solana-token-injector account registration v1',
  'Show my Midnight account in my Solana wallet',
  'RPC http://127.0.0.1:18899',
  'Midnight network undeployed',
  'Wallet 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
  'Account 453b2b8d0000000000000000000000000000000000000000000000000000375a',
  'Expires 2026-10-05 12:34:56 UTC',
  "The RPC will see this account's balances.",
  'This signature authorises nothing on chain and moves no funds.',
].join('\n');

const randomWallet = () => new PublicKey(crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(12)).toBase58();
const randomInt = (lo, hi) => lo + crypto.randomInt(hi - lo + 1);
const ORIGINS = ['http://127.0.0.1:18899', 'https://rpc.example.org', 'http://[::1]:1234', 'http://localhost:10001', 'https://rpc.example.org:8443'];
const NETWORKS = ['undeployed', 'stagenet', 'preprod', 'preview', 'mainnet', 'a', 'x'.repeat(32), 'net-0-9'];
const randomFields = () => ({
  origin: ORIGINS[crypto.randomInt(ORIGINS.length)],
  networkId: NETWORKS[crypto.randomInt(NETWORKS.length)],
  solanaAddress: randomWallet(),
  accountAddress: crypto.randomBytes(32).toString('hex'),
  expiresAt: randomInt(0, 253402300799),
});

test('T1.1 golden: the example renders byte for byte; 45-byte first line', () => {
  const text = m.renderRegistrationText(EXAMPLE_FIELDS);
  assert.equal(text, EXAMPLE_TEXT);
  assert.equal(Buffer.byteLength(text), 407); // 45+44+26+27+51+72+31+41+62 bytes + 8 LF
  assert.equal(Buffer.byteLength(text.split('\n')[0]), 45);
  assert.equal(text.split('\n')[0], m.FIRST_LINE);
  assert.deepEqual(m.parseRegistrationText(EXAMPLE_TEXT), EXAMPLE_FIELDS);
  assert.deepEqual(m.registrationInfo({ origin: EXAMPLE_FIELDS.origin, networkId: 'undeployed' }), {
    format: 'solana-token-injector account registration v1',
    origin: 'http://127.0.0.1:18899',
    networkId: 'undeployed',
    maxTtlSeconds: 600,
  });
});

test('T1.2 round trip: parse(render(f)) == f for 200 random valid field sets', () => {
  for (let i = 0; i < 200; i++) {
    const f = randomFields();
    const text = m.renderRegistrationText(f);
    assert.ok(Buffer.byteLength(text) <= m.MAX_BYTES);
    assert.deepEqual(m.parseRegistrationText(text), f, text);
  }
});

test('T1.3 refused texts -> RegistrationTextError (bad-message)', () => {
  const L = EXAMPLE_TEXT.split('\n');
  const swap = (i, v) => L.map((x, j) => (j === i ? v : x)).join('\n');
  const cases = {
    crlf: EXAMPLE_TEXT.replace(/\n/g, '\r\n'),
    'trailing LF': `${EXAMPLE_TEXT}\n`,
    'leading LF': `\n${EXAMPLE_TEXT}`,
    'missing line': L.slice(0, 8).join('\n'),
    'extra line': [...L, 'more'].join('\n'),
    'reordered lines': [L[1], L[0], ...L.slice(2)].join('\n'),
    'swapped Wallet and Account': [...L.slice(0, 4), L[5], L[4], ...L.slice(6)].join('\n'),
    'fixed line in another case': swap(0, L[0].toUpperCase()),
    'line 2 in another case': swap(1, L[1].toLowerCase()),
    'line 9 changed': swap(8, 'This signature authorises everything.'),
    'non-ASCII e-acute': swap(1, 'Show my Midnight account in my Solana wallét'),
    'non-ASCII nbsp': swap(3, 'Midnight network undeployed'),
    'tab': swap(3, 'Midnight network\tundeployed'),
    'uppercase account hex': swap(5, `Account ${EXAMPLE_FIELDS.accountAddress.toUpperCase()}`),
    'account with 0x': swap(5, `Account 0x${EXAMPLE_FIELDS.accountAddress}`),
    'account 63 hex': swap(5, `Account ${EXAMPLE_FIELDS.accountAddress.slice(1)}`),
    'non-canonical wallet (leading 1)': swap(4, `Wallet 1${EXAMPLE_FIELDS.solanaAddress}`),
    'wallet not base58': swap(4, 'Wallet 0OIl'),
    'impossible date 2026-02-30': swap(6, 'Expires 2026-02-30 12:00:00 UTC'),
    'hour 24': swap(6, 'Expires 2026-10-05 24:00:00 UTC'),
    'second 60': swap(6, 'Expires 2026-10-05 23:59:60 UTC'),
    'no UTC': swap(6, 'Expires 2026-10-05 12:34:56'),
    'GMT': swap(6, 'Expires 2026-10-05 12:34:56 GMT'),
    'ISO T': swap(6, 'Expires 2026-10-05T12:34:56 UTC'),
    'year before 1970': swap(6, 'Expires 1969-12-31 23:59:59 UTC'),
    'origin with a path': swap(2, 'RPC http://127.0.0.1:18899/rpc'),
    'origin with a trailing slash': swap(2, 'RPC http://127.0.0.1:18899/'),
    'origin with a default port': swap(2, 'RPC http://h:80'),
    'origin https default port': swap(2, 'RPC https://h:443'),
    'origin uppercase host': swap(2, 'RPC http://RPC.example.org'),
    'origin ws scheme': swap(2, 'RPC ws://127.0.0.1:18899'),
    'origin with userinfo': swap(2, 'RPC http://u@h'),
    'network uppercase': swap(3, 'Midnight network Undeployed'),
    'network too long': swap(3, `Midnight network ${'x'.repeat(33)}`),
    'empty': '',
    '513 bytes': `${EXAMPLE_TEXT}${' '.repeat(513 - Buffer.byteLength(EXAMPLE_TEXT))}`,
  };
  for (const [name, text] of Object.entries(cases)) {
    assert.throws(() => m.parseRegistrationText(text), m.RegistrationTextError, name);
  }
  for (const [i, line] of L.entries()) {
    assert.throws(() => m.parseRegistrationText(swap(i, ` ${line}`)), m.RegistrationTextError, `leading space on line ${i + 1}`);
    assert.throws(() => m.parseRegistrationText(swap(i, `${line} `)), m.RegistrationTextError, `trailing space on line ${i + 1}`);
  }
  assert.throws(() => m.parseRegistrationText(42), m.RegistrationTextError);
  assert.throws(() => m.parseRegistrationText(Buffer.from(EXAMPLE_TEXT)), m.RegistrationTextError);
});

// A random label the arm accepts: words of visible ASCII with single spaces, 1..24 characters.
function randomLabel() {
  for (;;) {
    const words = Array.from({ length: randomInt(1, 4) }, () =>
      Array.from({ length: randomInt(1, 8) }, () => String.fromCharCode(randomInt(0x21, 0x7e))).join(''));
    const label = words.join(' ');
    if (label.length <= 24) return label;
  }
}
const b32 = () => new Uint8Array(crypto.randomBytes(32));

test('T1.4 domain separation, both directions (vendored arm renderer and possession envelope)', async () => {
  const nm = await loadNightMarket();
  const labels = [...Object.values(nm.MARKET_LABELS), ...Array.from({ length: 50 }, randomLabel)];
  const key = b32();
  const ops = [
    { op: 'withdrawUnshielded', color: b32(), amount: 5n, recipient: b32() },
    { op: 'withdrawShielded', color: b32(), amount: 10n ** 23n, recipient: b32() },
    { op: 'withdrawShieldedToContract', color: b32(), amount: 1n, recipient: b32() },
    { op: 'appendInbox', entry: new Uint8Array(crypto.randomBytes(192)) },
    { op: 'rotateEncKey', newKey: key, currentKey: key },
    { op: 'rotateEncKey', newKey: b32(), currentKey: key },
    { op: 'openSwapShielded', giveColor: b32(), giveAmount: 200n, recipientKind: 0n, recipient: b32(), want: { color: b32(), value: 50n }, validUntil: 1_900_000_000n },
  ];
  let arm = 0;
  for (const label of labels) {
    for (const input of ops) {
      const msg = nm.renderEd25519Message({ contractAddress: b32(), authNonce: 7n, challenge: b32(), label }, input);
      const first = msg.text.split('\n')[0];
      assert.equal(Buffer.byteLength(first), 30, `${input.op} ${label}`);
      assert.ok(first.startsWith(nm.ED25519_SITE_PREFIX));
      assert.throws(() => m.parseRegistrationText(msg.text), m.RegistrationTextError);
      arm++;
    }
    for (const purpose of new Set(Object.values(nm.SOLANA_ENVELOPE_PURPOSES))) {
      const bytes = nm.ed25519PossessionMessage({ label, publicKeyBase58: randomWallet(), purpose, nonce: crypto.randomBytes(32).toString('hex') });
      const text = Buffer.from(bytes).toString('latin1');
      const first = text.split('\n')[0];
      assert.ok(Buffer.byteLength(first) >= 1 && Buffer.byteLength(first) <= 24);
      assert.throws(() => m.parseRegistrationText(text), m.RegistrationTextError);
    }
  }
  assert.equal(arm, labels.length * ops.length);
  // The other direction: no I-4 text can be either, and every one passes the wallet-safety guard.
  for (let i = 0; i < 200; i++) {
    const text = m.renderRegistrationText(randomFields());
    const first = text.split('\n')[0];
    assert.notEqual(Buffer.byteLength(first), 30);
    assert.ok(Buffer.byteLength(first) > 24);
    assert.ok(!first.startsWith('Site: '));
    assert.ok(!nm.LABEL_RULE.test(first) || first.length > 24);
    nm.assertSafeEd25519Message(new Uint8Array(Buffer.from(text, 'utf8')));
  }
});

test('docs/account-registration-vectors.json equals the frozen codec (00060 checks its renderer against it)', async () => {
  const nm = await loadNightMarket();
  const file = require('../../docs/account-registration-vectors.json');
  assert.deepEqual(file, require('../helpers/registration-vectors').build());
  for (const v of file.valid) {
    assert.equal(m.renderRegistrationText(v.fields), v.text);
    assert.deepEqual(m.parseRegistrationText(v.text), v.fields);
    assert.ok(nm.verifyEd25519Strict(v.signer.publicKeyHex, new Uint8Array(Buffer.from(v.text, 'utf8')), new Uint8Array(Buffer.from(v.signature, 'hex'))));
  }
  for (const v of file.invalid) assert.throws(() => m.parseRegistrationText(v.text), m.RegistrationTextError, v.why);
});
