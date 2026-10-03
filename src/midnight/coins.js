'use strict';
// Runtime coin book for one viewing key: received coins de-duplicated by
// commitment (the indexer re-delivers after a reconnect), and totals per
// token type (u128 values as bigint). Totals are "received", not balances
// (Q3): a viewing key cannot see spends.

const HEX64 = /^[0-9a-f]{64}$/;

class CoinBook {
  constructor() {
    this.coins = new Map(); // commitment -> { tokenType, value }
    this.totals = new Map(); // tokenType -> bigint
  }

  /** Adds a decrypted coin; returns true if it was new. Throws on malformed input. */
  add({ commitment, tokenType, value }) {
    const c = String(commitment).toLowerCase();
    const t = String(tokenType).toLowerCase();
    if (!HEX64.test(c)) throw new Error(`bad commitment "${commitment}"`);
    if (!HEX64.test(t)) throw new Error(`bad tokenType "${tokenType}"`);
    if (!/^\d+$/.test(String(value))) throw new Error(`bad value "${value}"`);
    if (this.coins.has(c)) return false;
    const v = BigInt(value);
    this.coins.set(c, { tokenType: t, value: v });
    this.totals.set(t, (this.totals.get(t) || 0n) + v);
    return true;
  }

  get size() {
    return this.coins.size;
  }
}

module.exports = { CoinBook };
