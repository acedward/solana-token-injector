'use strict';
// Serialised ledger-v9 EVENTS for the account-source tests (AA 00059): a contract-owned Zswap leaf
// (`zswapOutput`) and a contract's spend (`zswapInput`), byte for byte the layout Night Market's
// packages/core/test/fixtures/ledger-events.ts builds (Apache-2.0, acedward/solana-night-market
// 10b29b1), so the vendored decoder (ledger-v9's own Event.deserialize) reads them.

const TAG = '6d69646e696768743a6576656e745b7631345d3a'; // "midnight:event[v14]:"

const hex32 = (h) => {
  const x = String(h).replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(x)) throw new Error(`not 32 bytes of hex: ${h}`);
  return x;
};

/** SCALE compact encoding of a non-negative integer below 2^30, as hex. */
function compactHex(n) {
  const v = BigInt(n);
  const le = (x, bytes) => {
    let out = '';
    for (let i = 0; i < bytes; i++) out += Number((x >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, '0');
    return out;
  };
  if (v < 0n) throw new Error('negative');
  if (v < 1n << 6n) return le(v << 2n, 1);
  if (v < 1n << 14n) return le((v << 2n) | 1n, 2);
  if (v < 1n << 30n) return le((v << 2n) | 2n, 4);
  throw new Error('too large for this fixture');
}

function zswapOutputEventHex({ txHash, contract, commitment, mtIndex }) {
  const body = `${hex32(txHash)}00000000` + `01${hex32(commitment)}0200${compactHex(mtIndex)}`;
  return `${TAG}080080${hex32(contract)}0400${compactHex(body.length / 2)}${body}`;
}

function zswapInputEventHex({ txHash, contract, nullifier }) {
  const body = `${hex32(txHash)}00000000` + `00${hex32(nullifier)}00`;
  return `${TAG}080080${hex32(contract)}0400${compactHex(body.length / 2)}${body}`;
}

module.exports = { compactHex, zswapOutputEventHex, zswapInputEventHex };
