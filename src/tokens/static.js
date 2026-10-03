'use strict';
// Static tokens from config.json (phase 1): validate and turn them into token
// specs for buildTokenState. Throws an Error whose message is the user-facing
// config error.

const { PublicKey } = require('@solana/web3.js');
const { toBaseUnits } = require('../amounts');

function staticTokenSpecs(tokens) {
  if (tokens === undefined) return [];
  if (!Array.isArray(tokens)) throw new Error('config.tokens must be a list');
  const specs = [];
  for (const t of tokens) {
    const id = t && (t.id || t.symbol);
    if (!id) throw new Error('each token needs a symbol (or an id)');
    if (String(id).startsWith('midnight:')) throw new Error(`token "${id}": ids starting with "midnight:" are reserved for Midnight tokens`);
    if (!t.name || !t.symbol) throw new Error(`token "${id}" needs a name and a symbol`);
    if (!t.balances || Object.keys(t.balances).length === 0) throw new Error(`token "${id}" needs balances: { "<wallet address>": "<amount>" }`);

    const decimals = t.decimals ?? 6;
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error(`token "${id}": decimals must be an integer 0..255`);
    const program = t.program || 'token';
    if (!['token', 'token-2022'].includes(program)) throw new Error(`token "${id}": program must be "token" or "token-2022"`);

    const holders = [];
    for (const [wallet, value] of Object.entries(t.balances)) {
      try {
        new PublicKey(wallet); // eslint-disable-line no-new
      } catch {
        throw new Error(`token "${id}": "${wallet}" is not a valid wallet address`);
      }
      let amount;
      try {
        amount = toBaseUnits(value, decimals);
      } catch (e) {
        throw new Error(`token "${id}": ${e.message}`);
      }
      holders.push([wallet, amount]);
    }
    specs.push({
      id: String(id),
      name: t.name,
      symbol: t.symbol,
      decimals,
      program,
      uri: t.uri,
      image: t.image,
      description: t.description,
      holders,
      source: 'static',
    });
  }
  return specs;
}

module.exports = { staticTokenSpecs };
