'use strict';
// Test-only Midnight-style keys: random 32-byte payloads, bech32m-encoded with
// the viewing-key HRP. They pass the format checks; they are not real keys.

const crypto = require('crypto');
const { bech32, bech32m } = require('bech32');

const hrpFor = (networkId) => (networkId === 'mainnet' ? 'mn_shield-esk' : `mn_shield-esk_${networkId}`);

function testViewingKey(networkId = 'undeployed', { bytes = 32, hrp, checksum = 'bech32m' } = {}) {
  const enc = checksum === 'bech32' ? bech32 : bech32m;
  return enc.encode(hrp || hrpFor(networkId), enc.toWords(crypto.randomBytes(bytes)), 1000);
}

/** Toolkit known answer: seed 00..01 on `undeployed` (midnight-node util/toolkit show_viewing_key.rs). */
const KNOWN_KEY = 'mn_shield-esk_undeployed1dlyj7u8juj68fd4psnkqhjxh32sec0q480vzswg8kd485e2kljcs9ete5h';

module.exports = { testViewingKey, KNOWN_KEY, hrpFor };
