'use strict';
// Test-only Midnight-style keys: random 32-byte values serialized like the ledger
// does (SCALE compact big integer: header byte 0x73 = 33 bytes in total),
// bech32m-encoded with the viewing-key HRP. They pass the format checks; they are
// not real keys. `bytes` gives a raw (non-SCALE) payload of that length instead.

const crypto = require('crypto');
const { bech32, bech32m } = require('bech32');

const hrpFor = (networkId) => (networkId === 'mainnet' ? 'mn_shield-esk' : `mn_shield-esk_${networkId}`);

function testViewingKey(networkId = 'undeployed', { bytes, hrp, checksum = 'bech32m' } = {}) {
  const enc = checksum === 'bech32' ? bech32 : bech32m;
  const payload = bytes === undefined ? Buffer.concat([Buffer.from([0x73]), crypto.randomBytes(32)]) : crypto.randomBytes(bytes);
  return enc.encode(hrp || hrpFor(networkId), enc.toWords(payload), 1000);
}

/** Toolkit/harness answers for the dev seeds on `undeployed`: 00..02 and 00..03 have 33-byte payloads. */
const GENESIS_2_KEY = 'mn_shield-esk_undeployed1w0dctw9zhe2ffqw4s5qks7rnl29wy5mhl957fv9nnhtxulent80q5t9mydg';
const GENESIS_3_KEY = 'mn_shield-esk_undeployed1wvd5v04ykt59gglxknsdxpwwkhhhj8d6h3ghpkgdhdsszap2p53qkzr6qn2';

/** Toolkit known answer: seed 00..01 on `undeployed` (midnight-node util/toolkit show_viewing_key.rs). */
const KNOWN_KEY = 'mn_shield-esk_undeployed1dlyj7u8juj68fd4psnkqhjxh32sec0q480vzswg8kd485e2kljcs9ete5h';

module.exports = { testViewingKey, KNOWN_KEY, GENESIS_2_KEY, GENESIS_3_KEY, hrpFor };
