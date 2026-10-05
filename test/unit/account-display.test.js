'use strict';
// AA 00059 P1 (T1.8): the display rule for bridged colours (plan I-4b, FROZEN at P1).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const d = require('../../src/tokens/display');

const COLOUR = 'abcdef0123456789'.repeat(4);
const bytes = (s) => Buffer.byteLength(s);

test('T1.8 display rule table', () => {
  assert.equal(d.bridgedName('X'), 'X (Midnight)');
  assert.equal(d.bridgedSymbol('X', COLOUR), 'mnX');
  // 21 bytes kept, 22 cut.
  assert.equal(d.bridgedName('A'.repeat(21)), `${'A'.repeat(21)} (Midnight)`);
  assert.equal(bytes(d.bridgedName('A'.repeat(21))), 32);
  assert.equal(d.bridgedName('B'.repeat(22)), `${'B'.repeat(21)} (Midnight)`);
  // A cut that lands on trailing spaces trims them.
  assert.equal(d.bridgedName(`${'C'.repeat(19)}   tail`), `${'C'.repeat(19)} (Midnight)`);
  // Multi-byte UTF-8: cut at a character boundary (é is 2 bytes; 10 x é = 20 bytes, the 11th would be 22).
  assert.equal(d.bridgedName('é'.repeat(11)), `${'é'.repeat(10)} (Midnight)`);
  assert.equal(d.bridgedName('€'.repeat(8)), `${'€'.repeat(7)} (Midnight)`); // 3 bytes each: 21
  assert.equal(d.bridgedName(`${'a'.repeat(20)}é`), `${'a'.repeat(20)} (Midnight)`); // é would end at byte 22
  // Symbols: 8 bytes -> 10; 10 cut to 8.
  assert.equal(d.bridgedSymbol('ABCDEFGH', COLOUR), 'mnABCDEFGH');
  assert.equal(d.bridgedSymbol('ABCDEFGHIJ', COLOUR), 'mnABCDEFGH');
  // "mn" + symbol equal to the SPL symbol ignoring case -> MN + 6 hex.
  assert.equal(d.bridgedSymbol('mnmnmnmnmn', COLOUR), 'MNABCDEF');
  assert.equal(d.bridgedSymbol('MNmnmnmnmn', COLOUR), 'MNABCDEF');
  const full = d.bridgedDisplay({ colour: COLOUR, splMint: 'So11111111111111111111111111111111111111112', bridgeContract: '12'.repeat(32), name: 'Test X', symbol: 'X', decimals: 6 });
  assert.deepEqual(full, {
    name: 'Test X (Midnight)',
    symbol: 'mnX',
    decimals: 6,
    description: 'Midnight half of Test X (SPL mint So11111111111111111111111111111111111111112), bridged by contract 1212121212121212; display only',
  });
});

test('T1.8 property: 1,000 random names/symbols stay within the limits and never equal the SPL symbol', () => {
  const pool = ['a', 'Z', '0', ' ', '-', 'é', '€', '😀', 'm', 'n', 'M', 'N'];
  const rnd = (max) => Array.from({ length: crypto.randomInt(1, max + 1) }, () => pool[crypto.randomInt(pool.length)]).join('');
  for (let i = 0; i < 1000; i++) {
    const name = rnd(40);
    const symbol = i % 3 === 0 ? `mn${rnd(8)}` : rnd(12);
    const colour = crypto.randomBytes(32).toString('hex');
    const n = d.bridgedName(name);
    const s = d.bridgedSymbol(symbol, colour);
    assert.ok(bytes(n) <= 32, n);
    assert.ok(n.endsWith('(Midnight)'));
    assert.ok(bytes(s) <= 10, s);
    assert.notEqual(s.toLowerCase(), symbol.toLowerCase(), `${symbol} -> ${s}`);
    // Never a broken character.
    assert.equal(Buffer.from(n, 'utf8').toString('utf8'), n);
    assert.equal(Buffer.from(s, 'utf8').toString('utf8'), s);
  }
});
