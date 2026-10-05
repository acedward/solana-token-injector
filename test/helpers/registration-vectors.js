'use strict';
// The I-4 vectors (docs/account-registration-vectors.json): built from the frozen codec and the
// label-derived test keys, so Night Market (00060) can check its own renderer byte for byte.
// `node test/helpers/registration-vectors.js > docs/account-registration-vectors.json` regenerates
// the file; test/unit/account-message.test.js fails when the file and the codec disagree.

const crypto = require('crypto');
const { PublicKey } = require('@solana/web3.js');
const m = require('../../src/accounts/message');
const keys = require('./nm-keys');

const b58 = (hex) => new PublicKey(Buffer.from(hex, 'hex')).toBase58();
const at = (y, mo, d, h, mi, s) => Date.UTC(y, mo - 1, d, h, mi, s) / 1000;

function build() {
  const inputs = [
    { origin: 'http://127.0.0.1:18899', networkId: 'undeployed', device: 'A', account: '453b2b8d0000000000000000000000000000000000000000000000000000375a', expiresAt: at(2026, 10, 5, 12, 34, 56) },
    { origin: 'https://rpc.example.org', networkId: 'stagenet', device: 'B', account: keys.accountHex('B'), expiresAt: at(2026, 12, 31, 23, 59, 59) },
    { origin: 'http://[::1]:1234', networkId: 'undeployed', device: 'C', account: keys.accountHex('C'), expiresAt: at(2027, 2, 28, 0, 0, 0) },
    { origin: 'https://rpc.example.org:8443', networkId: 'preprod', device: 'A', account: keys.accountHex('A'), expiresAt: at(2030, 1, 1, 9, 5, 7) },
  ];
  const valid = inputs.map((i) => {
    const fields = { origin: i.origin, networkId: i.networkId, solanaAddress: b58(keys.deviceKeyHex(i.device)), accountAddress: i.account, expiresAt: i.expiresAt };
    const text = m.renderRegistrationText(fields);
    const signature = Buffer.from(keys.deviceKey(i.device).sign(Buffer.from(text, 'utf8'))).toString('hex');
    return {
      fields,
      text,
      bytes: Buffer.byteLength(text),
      sha256: crypto.createHash('sha256').update(text).digest('hex'),
      signer: { publicKeyHex: keys.deviceKeyHex(i.device), note: `test key: seed sha256("aa00059 device ${i.device}")` },
      signature,
    };
  });
  const base = valid[0].text;
  const L = base.split('\n');
  const swap = (k, v) => L.map((x, j) => (j === k ? v : x)).join('\n');
  const invalid = [
    ['CRLF line ends', base.replace(/\n/g, '\r\n')],
    ['trailing LF', `${base}\n`],
    ['origin with a trailing slash', swap(2, 'RPC http://127.0.0.1:18899/')],
    ['origin with the default port', swap(2, 'RPC http://h:80')],
    ['uppercase account hex', swap(5, `Account ${L[5].slice(8).toUpperCase()}`)],
    ['impossible date', swap(6, 'Expires 2026-02-30 12:00:00 UTC')],
    ['no UTC', swap(6, 'Expires 2026-10-05 12:34:56')],
    ['first line of a Passport arm message', swap(0, 'Site: Night Market - local   ')],
  ].map(([why, text]) => ({ why, text }));
  return { format: m.FORMAT, maxBytes: m.MAX_BYTES, firstLineBytes: Buffer.byteLength(m.FIRST_LINE), valid, invalid };
}

module.exports = { build };
if (require.main === module) process.stdout.write(`${JSON.stringify(build(), null, 2)}\n`);
