'use strict';
// Token amounts: whole-token strings <-> base units (bigint), and the
// `tokenAmount` object the RPC returns.

const U64_MAX = 18446744073709551615n;

function toBaseUnits(value, decimals) {
  const s = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`invalid amount "${value}"`);
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) throw new Error(`amount "${value}" has more than ${decimals} decimals`);
  return BigInt(whole + frac.padEnd(decimals, '0'));
}

function uiAmountString(amount, decimals) {
  if (decimals === 0) return amount.toString();
  const s = amount.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

function tokenAmount(amount, decimals) {
  const str = uiAmountString(amount, decimals);
  return { amount: amount.toString(), decimals, uiAmount: Number(str), uiAmountString: str };
}

/** SPL amounts are u64; Midnight values are u128 (Q11): clamp and say so. */
function clampU64(amount) {
  return amount > U64_MAX ? { amount: U64_MAX, clamped: true } : { amount, clamped: false };
}

module.exports = { U64_MAX, toBaseUnits, uiAmountString, tokenAmount, clampU64 };
