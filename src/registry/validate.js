'use strict';
// Registration validation (FR-103). Errors carry a human message for the page
// and an HTTP status; messages never echo the viewing key.
//
// 1. Solana address: base58 that decodes to a 32-byte public key.
// 2. Viewing key: bech32m, HRP `mn_shield-esk_<networkId>` (`mn_shield-esk`
//    on mainnet); the payload is the ledger's serialized encryption secret key,
//    a SCALE compact big integer of 1..33 bytes whose first byte gives its length
//    (midnight-serialize `ScaleBigInt`). The indexer deserializes it the same way
//    (`SecretKey::deserialize`); its VIEWING_KEY_LEN = 32 is the length of the
//    key's `repr()`, not of this payload (P2 finding, 2026-10-03: the dev seeds
//    00..02 / 00..03 give 33-byte payloads, 00..01 a 32-byte one).
// 3. The decryptor's `validateKey` (master plan I-1) has the final word: it
//    checks that the payload deserializes as an encryption secret key.

const { PublicKey } = require('@solana/web3.js');
const { bech32, bech32m } = require('bech32');
const { redact } = require('../log');

// Serialized encryption secret key: at most 1 header byte + 32 value bytes.
const VIEWING_KEY_MAX_BYTES = 33;

/** Total length of a SCALE compact big integer given its first byte (midnight-serialize util.rs ScaleBigInt). */
function scaleCompactLength(b0) {
  switch (b0 & 0b11) {
    case 0b00:
      return 1;
    case 0b01:
      return 2;
    case 0b10:
      return 4;
    default:
      return (b0 >> 2) + 5;
  }
}
const BECH32_LIMIT = 1000;

class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const viewingKeyHrp = (networkId) => (networkId === 'mainnet' ? 'mn_shield-esk' : `mn_shield-esk_${networkId}`);

function validateSolanaAddress(input) {
  if (typeof input !== 'string' || !input.trim()) throw new ValidationError('Solana address is required');
  const s = input.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(s)) throw new ValidationError('Solana address must be base58 (letters and digits, no 0, O, I or l)');
  let pk;
  try {
    pk = new PublicKey(s);
  } catch {
    throw new ValidationError('Solana address must decode to a 32-byte public key');
  }
  if (pk.toBase58() !== s) throw new ValidationError('Solana address is not in canonical base58 form');
  return s;
}

/** Network id named by a Midnight bech32 HRP like `mn_shield-esk_preprod` (mainnet has no suffix). */
function hrpNetwork(hrp, kind) {
  if (hrp === `mn_${kind}`) return 'mainnet';
  if (hrp.startsWith(`mn_${kind}_`)) return hrp.slice(`mn_${kind}_`.length);
  return null;
}

function validateViewingKeyFormat(input, networkId) {
  if (typeof input !== 'string' || !input.trim()) throw new ValidationError('Midnight viewing key is required');
  const s = input.trim();
  const expected = viewingKeyHrp(networkId);
  const example = `${expected}1…`;
  let decoded;
  try {
    decoded = bech32m.decode(s, BECH32_LIMIT);
  } catch {
    let isBech32 = false;
    try {
      bech32.decode(s, BECH32_LIMIT);
      isBech32 = true;
    } catch {}
    if (isBech32) throw new ValidationError(`viewing key uses a bech32 checksum, Midnight keys use bech32m (expected ${example})`);
    throw new ValidationError(`viewing key is not a valid bech32m string (expected ${example}); check for typos or missing characters`);
  }
  const hrp = decoded.prefix;
  if (hrp !== expected) {
    const net = hrpNetwork(hrp, 'shield-esk');
    if (net !== null) {
      throw new ValidationError(`viewing key is for Midnight network "${net}", this service runs on "${networkId}"`);
    }
    if (hrp.startsWith('mn_shield-addr')) {
      throw new ValidationError(`this is a shielded address (${hrp}…), not a viewing key; a viewing key starts with ${expected}1`);
    }
    if (hrp.startsWith('mn_')) {
      throw new ValidationError(`this is a Midnight "${hrp}" string, not a viewing key; a viewing key starts with ${expected}1`);
    }
    throw new ValidationError(`viewing key must start with ${expected}1 (got prefix "${hrp}")`);
  }
  let bytes;
  try {
    bytes = bech32m.fromWords(decoded.words);
  } catch {
    throw new ValidationError('viewing key payload is not decodable (bad padding)');
  }
  if (bytes.length === 0 || bytes.length > VIEWING_KEY_MAX_BYTES || scaleCompactLength(bytes[0]) !== bytes.length) {
    throw new ValidationError(`viewing key payload (${bytes.length} bytes) is not a serialized encryption secret key; check that you copied the whole key`);
  }
  return s.toLowerCase(); // bech32 allows an all-uppercase form; store one canonical spelling
}

/**
 * Full validation of a registration request body.
 * decryptor: { validateKey(networkId, viewingKey) -> Promise<{ok, error?}> } or null.
 * Returns { solanaAddress, viewingKey }.
 */
async function validateRegistration(body, { networkId, decryptor }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('request body must be a JSON object {"solanaAddress": "...", "viewingKey": "..."}');
  }
  const solanaAddress = validateSolanaAddress(body.solanaAddress);
  const viewingKey = validateViewingKeyFormat(body.viewingKey, networkId);
  if (decryptor) {
    let res;
    try {
      res = await decryptor.validateKey(networkId, viewingKey);
    } catch (e) {
      throw new ValidationError(`cannot check the viewing key right now (decryptor unavailable: ${redact(e.message)})`, 503);
    }
    if (!res || !res.ok) throw new ValidationError(`viewing key rejected: ${redact((res && res.error) || 'not a valid encryption secret key')}`);
  }
  return { solanaAddress, viewingKey };
}

module.exports = {
  ValidationError,
  viewingKeyHrp,
  validateSolanaAddress,
  validateViewingKeyFormat,
  validateRegistration,
  VIEWING_KEY_MAX_BYTES,
  scaleCompactLength,
};
