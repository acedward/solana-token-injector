'use strict';
// Midnight tokens on the Solana side (FR-003, FR-107, Q6, Q11, Q12): one
// Token-2022 mint per (network, token type); every registered Solana address
// holds the sum of its registrations' totals for that type.
//
// AA 00059 (D6): a totals key is a shielded token type "<64 hex>" (viewing keys and Passport
// accounts) or an unshielded one "u:<64 hex>" (Passport accounts' public balances). The two spaces
// can hold equal bytes, so they get distinct ids: midnight:<net>:<hex> and midnight:<net>:u:<hex>.

const { U64_MAX } = require('../amounts');

const TYPE_RE = /^[0-9a-f]{64}$/;

const UNSHIELDED_PREFIX = 'u:';
const isUnshieldedKey = (key) => key.startsWith(UNSHIELDED_PREFIX);
const typeOfKey = (key) => (isUnshieldedKey(key) ? key.slice(UNSHIELDED_PREFIX.length) : key);

/** The token id of a totals key ("<hex>" shielded, "u:<hex>" unshielded). */
const midnightTokenId = (networkId, key) => `midnight:${networkId}:${key}`;

/** Display metadata for a totals key when no registry names it. */
function defaultTokenInfo(key) {
  const type = typeOfKey(key);
  if (isUnshieldedKey(key)) {
    return { name: `Midnight unshielded ${type.slice(0, 8)}`, symbol: `MU${type.slice(0, 4).toUpperCase()}`, decimals: 6 };
  }
  return {
    name: `Midnight ${type.slice(0, 8)}`,
    symbol: `MN${type.slice(0, 4).toUpperCase()}`,
    decimals: 6,
  };
}

/** The display info of a totals key: the defaults overlaid by `lookup(key)`. */
const tokenInfoFor = (key, lookup = () => null) => ({ ...defaultTokenInfo(key), ...(lookup(key) || {}) });

/**
 * Per-address totals: Map<solanaAddress, Map<tokenType, bigint>>, summed over
 * every registration of that address. `registrations` yields
 * { solanaAddress, totals: Map<tokenType, bigint> }.
 */
function totalsByAddress(registrations) {
  const out = new Map();
  for (const r of registrations) {
    if (!r.totals) continue;
    let m = out.get(r.solanaAddress);
    for (const [type, value] of r.totals) {
      if (!value) continue;
      if (!m) {
        m = new Map();
        out.set(r.solanaAddress, m);
      }
      m.set(type, (m.get(type) || 0n) + value);
    }
  }
  return out;
}

/**
 * Token specs for buildTokenState. `lookup(tokenType)` returns registry info
 * ({name, symbol, decimals, image?, description?, uri?}) or null.
 */
function midnightTokenSpecs({ networkId, registrations, lookup = () => null }) {
  const byType = new Map(); // tokenType -> [[address, total]]
  for (const [address, totals] of totalsByAddress(registrations)) {
    for (const [type, total] of totals) {
      if (total <= 0n) continue;
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type).push([address, total]);
    }
  }
  const specs = [];
  for (const key of [...byType.keys()].sort()) {
    const info = tokenInfoFor(key, lookup);
    const type = typeOfKey(key);
    const unshielded = isUnshieldedKey(key);
    specs.push({
      id: midnightTokenId(networkId, key),
      name: info.name,
      symbol: info.symbol,
      decimals: info.decimals,
      program: 'token-2022',
      uri: info.uri,
      image: info.image,
      description: info.description || `Midnight ${unshielded ? 'unshielded' : 'shielded'} token ${type} (display only)`,
      holders: byType.get(key),
      source: 'midnight',
      tokenType: type,
      privacy: unshielded ? 'unshielded' : 'shielded',
    });
  }
  return specs;
}

const isClamped = (total) => total > U64_MAX;

module.exports = { TYPE_RE, UNSHIELDED_PREFIX, isUnshieldedKey, typeOfKey, midnightTokenId, defaultTokenInfo, tokenInfoFor, totalsByAddress, midnightTokenSpecs, isClamped };
