'use strict';
// The display rule for bridged colours (plan I-4b, FROZEN at P1): a colour the journey token registry
// (I-1) lists as the Midnight half of an SPL token shows as "<name> (Midnight)", with a symbol that
// never equals the SPL token's, within the limits the injector enforces for Metaplex v1 / Token-2022
// metadata (name <= 32 bytes, symbol <= 10 bytes; src/tokens/registry.js).
//
//   name        = cut(name, 21 bytes at a UTF-8 character boundary), trailing spaces trimmed,
//                 + " (Midnight)"                                                (<= 32 bytes)
//   symbol      = "mn" + cut(symbol, 8 bytes); if that equals the SPL symbol ignoring case,
//                 "MN" + the colour's first 6 hex, uppercase                      (<= 10 bytes)
//   decimals    = the entry's decimals (= the SPL mint's on-chain decimals, FR-212)
//   description = "Midnight half of <name> (SPL mint <splMint>), bridged by contract
//                 <first 16 hex of bridgeContract>; display only"

const NAME_SUFFIX = ' (Midnight)';
const NAME_BASE_BYTES = 21;
const SYMBOL_PREFIX = 'mn';
const SYMBOL_BASE_BYTES = 8;

/** `s` cut to at most `max` UTF-8 bytes, never inside a character. */
function cutUtf8(s, max) {
  let out = '';
  let n = 0;
  for (const ch of String(s)) {
    const b = Buffer.byteLength(ch);
    if (n + b > max) break;
    out += ch;
    n += b;
  }
  return out;
}

function bridgedName(name) {
  const base = cutUtf8(name, NAME_BASE_BYTES).replace(/ +$/, '');
  return base ? `${base}${NAME_SUFFIX}` : NAME_SUFFIX.trim();
}

function bridgedSymbol(symbol, colour) {
  const s = `${SYMBOL_PREFIX}${cutUtf8(symbol, SYMBOL_BASE_BYTES)}`;
  if (s.toLowerCase() !== String(symbol).toLowerCase()) return s;
  return `MN${String(colour).slice(0, 6).toUpperCase()}`;
}

/** The synthetic token's display info for an I-1 entry {colour, splMint, bridgeContract, name, symbol, decimals}. */
function bridgedDisplay(entry) {
  const name = bridgedName(entry.name);
  return {
    name,
    symbol: bridgedSymbol(entry.symbol, entry.colour),
    decimals: entry.decimals,
    description: `Midnight half of ${entry.name} (SPL mint ${entry.splMint}), bridged by contract ${String(entry.bridgeContract || '').slice(0, 16)}; display only`,
  };
}

module.exports = { NAME_SUFFIX, NAME_BASE_BYTES, SYMBOL_BASE_BYTES, cutUtf8, bridgedName, bridgedSymbol, bridgedDisplay };
