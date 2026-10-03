'use strict';
// Midnight tokens on the Solana side (FR-003, FR-107, Q6, Q11, Q12): one
// Token-2022 mint per (network, token type); every registered Solana address
// holds the sum of its registrations' totals for that type.

const { U64_MAX } = require('../amounts');

const TYPE_RE = /^[0-9a-f]{64}$/;

const midnightTokenId = (networkId, tokenType) => `midnight:${networkId}:${tokenType}`;

/** Display metadata for a token type when the registry does not name it. */
function defaultTokenInfo(tokenType) {
  return {
    name: `Midnight ${tokenType.slice(0, 8)}`,
    symbol: `MN${tokenType.slice(0, 4).toUpperCase()}`,
    decimals: 6,
  };
}

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
  for (const type of [...byType.keys()].sort()) {
    const info = { ...defaultTokenInfo(type), ...(lookup(type) || {}) };
    specs.push({
      id: midnightTokenId(networkId, type),
      name: info.name,
      symbol: info.symbol,
      decimals: info.decimals,
      program: 'token-2022',
      uri: info.uri,
      image: info.image,
      description: info.description || `Midnight shielded token ${type} (display only)`,
      holders: byType.get(type),
      source: 'midnight',
      tokenType: type,
    });
  }
  return specs;
}

const isClamped = (total) => total > U64_MAX;

module.exports = { TYPE_RE, midnightTokenId, defaultTokenInfo, totalsByAddress, midnightTokenSpecs, isClamped };
