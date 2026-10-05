'use strict';
// Throwaway test keys, derived from fixed labels exactly as harness/nm/export-vectors.ts derives them
// (sha256("aa00059 <kind> <label>")), so the committed fixtures (test/fixtures/nm/vectors.json) hold
// only public keys and the tests recompute the secrets. Never use these anywhere but tests.
// Ed25519 through node:crypto (RFC 8032, the same keys and signatures as tweetnacl's), so the helper
// also runs in the service image, which has no dev dependencies.

const crypto = require('crypto');

const det = (kind, label) => crypto.createHash('sha256').update(`aa00059 ${kind} ${label}`).digest();
const detHex = (kind, label) => det(kind, label).toString('hex');

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');

/** An Ed25519 key from a 32-byte seed: { publicKey (32 bytes), sign(message) -> 64 bytes }. */
function ed25519FromSeed(seed) {
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
  const spki = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  const publicKey = Uint8Array.from(spki.subarray(spki.length - 32));
  return { publicKey, sign: (message) => Uint8Array.from(crypto.sign(null, Buffer.from(message), privateKey)) };
}

/** The device key of a label. */
const deviceKey = (label) => ed25519FromSeed(det('device', label));
const deviceKeyHex = (label) => Buffer.from(deviceKey(label).publicKey).toString('hex');

/** The account inbox (X25519) secret of a label, 64 hex. */
const encSecretHex = (label) => detHex('enc', label);
const accountHex = (label) => detHex('account', label);

module.exports = { det, detHex, ed25519FromSeed, deviceKey, deviceKeyHex, encSecretHex, accountHex };
