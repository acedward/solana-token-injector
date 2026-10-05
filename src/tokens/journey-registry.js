'use strict';
// The journey token registry (AA 00057 interface I-1, read by 00059 P4): which Midnight colours are
// the Midnight half of an SPL token, and how they are named (plan I-4b, src/tokens/display.js).
//
//   journey-tokens.<midnight-network>.json:
//   {"midnightNetwork": "undeployed", "solanaGenesisHash": "<base58>",
//    "tokens": [{"colour": "<64 hex>", "splMint": "<base58>", "bridgeContract": "<64 hex>",
//                "bridgeProgram": "<base58>", "bridgeApi": "<origin>", "name": "X", "symbol": "X", "decimals": 6,
//                "image": "https://…/x-midnight.png", "splImage": "https://…/x.png"}]}       (images optional)
//
// AA 00059 P7 (owner, 00057 Q10): `image` is the icon of the Midnight half ("<name> (Midnight)"), used
// when the injector's own token registry gives that colour none; `splImage` is the icon of the REAL SPL
// token, which the RPC serves in a filled-in Metaplex metadata account when the upstream has none for
// that mint (src/tokens/state.js addFillIn). Both are https URLs of at most 200 bytes.
//
// Read from config midnight.journeyRegistry (env JOURNEY_REGISTRY), separate from the injector's own
// token registry (midnight.tokenRegistry, another schema). The injector reads midnightNetwork,
// solanaGenesisHash and each entry's colour, splMint, bridgeContract, name, symbol and decimals, and
// ignores the other fields. Refused (FR-212): another Midnight network; another Solana genesis hash
// than the upstream's; a duplicate splMint or colour; a malformed colour or mint; an splMint the
// upstream does not have, that is not a classic SPL Token mint, or whose decimals differ. At start a
// refusal exits 1; on a hot reload the previous registry is kept.

const fs = require('fs');
const { PublicKey } = require('@solana/web3.js');
const { bridgedDisplay } = require('./display');

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_IMAGE_BYTES = 200;

/** An optional icon URL: https, at most 200 bytes, printable ASCII. */
function checkImage(v) {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !v || Buffer.byteLength(v) > MAX_IMAGE_BYTES || !/^[\x21-\x7e]+$/.test(v)) return null;
  try {
    return new URL(v).protocol === 'https:' ? v : null;
  } catch {
    return null;
  }
}
const SHAPE = 'a journey token registry is {"midnightNetwork", "solanaGenesisHash", "tokens": [{"colour", "splMint", "bridgeContract", "name", "symbol", "decimals", ...}]}';

class JourneyRegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JourneyRegistryError';
  }
}

const canonicalBase58 = (s, bytes = 32) => {
  if (typeof s !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try {
    const k = new PublicKey(s);
    return k.toBase58() === s && k.toBytes().length === bytes;
  } catch {
    return false;
  }
};

/** Parses and checks an I-1 object (shape, formats, uniqueness, network). Throws JourneyRegistryError. */
function parseJourneyRegistry(raw, { networkId, source = 'journey token registry' } = {}) {
  const fail = (why) => {
    throw new JourneyRegistryError(`${source}: ${why}`);
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`must be a JSON object (${SHAPE})`);
  if (raw.network !== undefined && raw.midnightNetwork === undefined) fail(`this looks like the injector's own token registry ("network"); ${SHAPE}`);
  if (typeof raw.midnightNetwork !== 'string') fail(`"midnightNetwork" is required (${SHAPE})`);
  if (networkId && raw.midnightNetwork !== networkId) fail(`"midnightNetwork" is "${raw.midnightNetwork}" but the service runs on Midnight network "${networkId}"`);
  if (!canonicalBase58(raw.solanaGenesisHash)) fail('"solanaGenesisHash" must be a canonical base58 hash');
  if (!Array.isArray(raw.tokens)) fail(`"tokens" must be a list (${SHAPE})`);
  const byColour = new Map();
  const byMint = new Map();
  raw.tokens.forEach((t, i) => {
    const where = `tokens[${i}]`;
    if (!t || typeof t !== 'object') fail(`${where} must be an object`);
    if (typeof t.colour !== 'string' || !HEX64.test(t.colour)) fail(`${where}.colour must be 64 lowercase hex`);
    if (!canonicalBase58(t.splMint)) fail(`${where}.splMint must be a canonical base58 address`);
    if (typeof t.bridgeContract !== 'string' || !HEX64.test(t.bridgeContract)) fail(`${where}.bridgeContract must be 64 lowercase hex`);
    if (typeof t.name !== 'string' || !t.name.trim()) fail(`${where}.name must be a non-empty string`);
    if (typeof t.symbol !== 'string' || !t.symbol) fail(`${where}.symbol must be a non-empty string`);
    if (!Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 255) fail(`${where}.decimals must be an integer 0..255`);
    const image = checkImage(t.image);
    const splImage = checkImage(t.splImage);
    if (image === null) fail(`${where}.image must be an https URL of at most ${MAX_IMAGE_BYTES} bytes`);
    if (splImage === null) fail(`${where}.splImage must be an https URL of at most ${MAX_IMAGE_BYTES} bytes`);
    if (byColour.has(t.colour)) fail(`${where}.colour ${t.colour} is listed twice`);
    if (byMint.has(t.splMint)) fail(`${where}.splMint ${t.splMint} is listed twice`);
    const entry = {
      colour: t.colour,
      splMint: t.splMint,
      bridgeContract: t.bridgeContract,
      name: t.name,
      symbol: t.symbol,
      decimals: t.decimals,
      ...(image ? { image } : {}),
      ...(splImage ? { splImage } : {}),
    };
    byColour.set(t.colour, entry);
    byMint.set(t.splMint, entry);
  });
  return { midnightNetwork: raw.midnightNetwork, solanaGenesisHash: raw.solanaGenesisHash, tokens: byColour, source };
}

function loadJourneyRegistry(file, { networkId } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new JourneyRegistryError(`cannot read the journey token registry ${file}: ${e.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new JourneyRegistryError(`the journey token registry ${file} is not valid JSON: ${e.message}`);
  }
  return parseJourneyRegistry(raw, { networkId, source: `journey token registry ${file}` });
}

class UpstreamUnreachable extends Error {}

async function rpcCall(upstream, method, params, timeoutMs) {
  let r;
  try {
    r = await upstream.post(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), { timeoutMs });
  } catch (e) {
    throw new UpstreamUnreachable(e && e.message ? e.message : String(e));
  }
  let body;
  try {
    body = JSON.parse(r.text);
  } catch {
    throw new UpstreamUnreachable(`HTTP ${r.status}`);
  }
  if (body.error) throw new UpstreamUnreachable(`${method}: ${body.error.message}`);
  return body.result;
}

/**
 * Checks the registry against the Solana upstream (FR-212): the genesis hash, and each splMint is a
 * classic SPL Token mint with the listed decimals. While the upstream is unreachable it retries every
 * `retryMs` for up to `deadlineMs` (60 s), then throws. A mismatch throws at once.
 */
async function checkJourneyRegistry(reg, upstream, { deadlineMs = 60_000, retryMs = 2_000, timeoutMs = 5_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    try {
      const genesis = await rpcCall(upstream, 'getGenesisHash', [], timeoutMs);
      if (genesis !== reg.solanaGenesisHash) {
        throw new JourneyRegistryError(`${reg.source}: "solanaGenesisHash" is ${reg.solanaGenesisHash} but the upstream's genesis hash is ${genesis}`);
      }
      for (const t of reg.tokens.values()) {
        const info = await rpcCall(upstream, 'getAccountInfo', [t.splMint, { encoding: 'jsonParsed', commitment: 'confirmed' }], timeoutMs);
        const v = info && info.value;
        if (!v) throw new JourneyRegistryError(`${reg.source}: splMint ${t.splMint} does not exist on the upstream`);
        if (v.owner !== TOKEN_PROGRAM) throw new JourneyRegistryError(`${reg.source}: splMint ${t.splMint} is owned by ${v.owner}, not the classic SPL Token program`);
        const parsed = v.data && v.data.parsed;
        if (!parsed || parsed.type !== 'mint') throw new JourneyRegistryError(`${reg.source}: splMint ${t.splMint} is not a mint account`);
        if (parsed.info.decimals !== t.decimals) throw new JourneyRegistryError(`${reg.source}: splMint ${t.splMint} has ${parsed.info.decimals} decimals on the upstream, the registry says ${t.decimals}`);
      }
      return reg;
    } catch (e) {
      if (!(e instanceof UpstreamUnreachable)) throw e;
      const left = until - Date.now();
      if (left <= 0) throw new JourneyRegistryError(`the Solana upstream did not answer for ${Math.round(deadlineMs / 1000)} s while checking the journey token registry (${e.message})`);
      await sleep(Math.min(retryMs, left));
    }
  }
}

/** lookup(key) for the colours I-1 lists (shielded keys only): the I-4b display, and the I-1 image. */
function journeyLookup(reg) {
  return (key) => {
    if (!reg || key.startsWith('u:')) return null;
    const e = reg.tokens.get(key);
    return e ? { ...bridgedDisplay(e), ...(e.image ? { image: e.image } : {}) } : null;
  };
}

/** I-1 over the injector's own registry for name, symbol, decimals, description; image and uri stay the
 *  registry's, and the I-1 image is used only when the registry gives none (P7.2). */
function combineLookups(journey, registry) {
  return (key) => {
    const base = registry(key);
    const j = journey(key);
    if (!j) return base;
    const out = { ...(base || {}), ...j };
    if (base && base.image) out.image = base.image;
    return out;
  };
}

/** The metadata fill-ins for the registry's real SPL mints (P7.1): {mint, name, symbol, image}. */
function journeyFillIns(reg) {
  if (!reg) return [];
  return [...reg.tokens.values()].map((e) => ({ mint: e.splMint, name: e.name, symbol: e.symbol, ...(e.splImage ? { image: e.splImage } : {}) }));
}

module.exports = { TOKEN_PROGRAM, MAX_IMAGE_BYTES, JourneyRegistryError, parseJourneyRegistry, loadJourneyRegistry, checkJourneyRegistry, journeyLookup, combineLookups, journeyFillIns };
