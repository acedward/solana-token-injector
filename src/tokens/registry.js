'use strict';
// Token registry file (master plan I-5): display metadata per Midnight token
// type. Midnight has no on-chain token metadata, so names, symbols, decimals
// and logos come from this file; unknown types get defaults
// (src/tokens/midnight.js defaultTokenInfo).
//
// {"network": "undeployed",
//  "tokens": {"<64 hex type>": {"name": "...", "symbol": "...", "decimals": 6,
//                               "image": "https://...", "description": "...", "uri": "https://..."}},
//  "unshielded": {"<64 hex type>": { same fields }}}          (optional; AA 00059 D6)
// `tokens` names shielded token types, `unshielded` the unshielded ones (a Passport account's public
// balances); lookup("u:<hex>") reads the second.

const fs = require('fs');

const TYPE_RE = /^[0-9a-f]{64}$/;

function parseTokenRegistry(raw, { networkId, source = 'token registry' } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${source}: must be a JSON object`);
  if (networkId && raw.network !== networkId) {
    throw new Error(`${source}: "network" is "${raw.network}" but the service runs on Midnight network "${networkId}" (this file is the injector's token registry, {"network", "tokens": {<type>: {...}}}; a journey token registry goes in midnight.journeyRegistry)`);
  }
  if (!raw.tokens || typeof raw.tokens !== 'object' || Array.isArray(raw.tokens)) throw new Error(`${source}: "tokens" must be an object keyed by token type`);
  const tokens = parseTokenMap(raw.tokens, `${source}: token`);
  let unshielded = new Map();
  if (raw.unshielded !== undefined) {
    if (!raw.unshielded || typeof raw.unshielded !== 'object' || Array.isArray(raw.unshielded)) throw new Error(`${source}: "unshielded" must be an object keyed by token type`);
    unshielded = parseTokenMap(raw.unshielded, `${source}: unshielded token`);
  }
  return { network: raw.network, tokens, unshielded };
}

function parseTokenMap(map, label) {
  const tokens = new Map();
  for (const [key, t] of Object.entries(map)) {
    const type = key.toLowerCase();
    const where = `${label} ${key}`;
    if (!TYPE_RE.test(type)) throw new Error(`${where}: the key must be a 64-hex token type`);
    if (tokens.has(type)) throw new Error(`${where}: listed twice`);
    if (!t || typeof t !== 'object') throw new Error(`${where}: must be an object`);
    const info = {};
    if (t.name !== undefined) {
      if (typeof t.name !== 'string' || !t.name || Buffer.byteLength(t.name) > 32) throw new Error(`${where}: name must be 1..32 bytes`);
      info.name = t.name;
    }
    if (t.symbol !== undefined) {
      if (typeof t.symbol !== 'string' || !t.symbol || Buffer.byteLength(t.symbol) > 10) throw new Error(`${where}: symbol must be 1..10 bytes`);
      info.symbol = t.symbol;
    }
    if (t.decimals !== undefined) {
      if (!Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 255) throw new Error(`${where}: decimals must be an integer 0..255`);
      info.decimals = t.decimals;
    }
    for (const k of ['image', 'description', 'uri']) {
      if (t[k] === undefined) continue;
      if (typeof t[k] !== 'string') throw new Error(`${where}: ${k} must be a string`);
      if (k === 'uri' && Buffer.byteLength(t[k]) > 200) throw new Error(`${where}: uri must be at most 200 bytes`);
      info[k] = t[k];
    }
    tokens.set(type, info);
  }
  return tokens;
}

function loadTokenRegistry(file, { networkId } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`cannot read token registry ${file}: ${e.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`token registry ${file} is not valid JSON: ${e.message}`);
  }
  return parseTokenRegistry(raw, { networkId, source: `token registry ${file}` });
}

/** lookup(key) -> info | null; key "<hex>" (shielded) or "u:<hex>" (unshielded). */
function registryLookup(registry) {
  return (key) => {
    if (!registry) return null;
    if (key.startsWith('u:')) return (registry.unshielded && registry.unshielded.get(key.slice(2))) || null;
    return registry.tokens.get(key) || null;
  };
}

module.exports = { parseTokenRegistry, loadTokenRegistry, registryLookup };
