#!/usr/bin/env node
'use strict';
/**
 * solana-token-injector
 *
 * A Solana JSON-RPC proxy. Every call is forwarded to a real upstream RPC,
 * except the handful a wallet uses to discover and display SPL tokens. Those
 * get extra, synthetic accounts merged in so a token defined in config.json
 * appears in the wallet as if it existed on chain.
 *
 * Display only: the token's accounts do not exist upstream, so any
 * transaction that touches them will fail simulation.
 *
 * Usage: node proxy.js [config.json]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { WebSocketServer, WebSocket } = require('ws');
const bs58 = require('bs58').default || require('bs58');
const JSONbig = require('json-bigint')({ useNativeBigInt: true });
const { PublicKey } = require('@solana/web3.js');
const spl = require('@solana/spl-token');
const { pack: packTokenMetadata } = require('@solana/spl-token-metadata');

// ---------------------------------------------------------------- constants

const MPL_TOKEN_METADATA = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const U64_MAX = 18446744073709551615n; // rentEpoch reported for rent-exempt accounts
const METAPLEX_METADATA_SIZE = 679;
const PASS = Symbol('pass');

// ---------------------------------------------------------------- config

const configPath = path.resolve(process.argv[2] || process.env.CONFIG || 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

if (!config.upstream) die('config.upstream is required (e.g. "https://api.devnet.solana.com")');
if (!Array.isArray(config.tokens) || config.tokens.length === 0) die('config.tokens must list at least one token');

const HOST = config.host || '127.0.0.1';
const PORT = Number(config.port || 8899);
const WS_PORT = Number(config.wsPort || PORT + 1); // web3.js expects ws on port+1 when the RPC URL has an explicit port
const UPSTREAM = config.upstream;
const UPSTREAM_WS = config.upstreamWs || deriveWsUrl(UPSTREAM);
const PUBLIC_URL = (config.publicUrl || `http://${HOST}:${PORT}`).replace(/\/$/, '');
const LOG = config.log !== false;
const LOG_PARAMS = config.log === 'verbose'; // also print each call's params (truncated)

function die(msg) {
  console.error(`config error: ${msg}`);
  process.exit(1);
}

function deriveWsUrl(httpUrl) {
  const u = new URL(httpUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  if (u.port) u.port = String(Number(u.port) + 1);
  return u.toString();
}

// ---------------------------------------------------------------- amounts

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

// ---------------------------------------------------------------- account builders

/** Fake addresses are sha256 hashes, so they can never collide with a real mint. */
function deriveKey(label) {
  return new PublicKey(crypto.createHash('sha256').update(`solana-token-injector:${label}`).digest());
}

function tlv(type, value) {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(type, 0);
  header.writeUInt16LE(value.length, 2);
  return Buffer.concat([header, value]);
}

function encodeMint({ supply, decimals, is2022, mint, authority, name, symbol, uri }) {
  const base = Buffer.alloc(spl.MINT_SIZE);
  spl.MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply,
      decimals,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    base,
  );
  if (!is2022) return base;

  // Token-2022: base mint padded to 165 bytes, account-type byte, then TLV extensions.
  const padded = Buffer.alloc(spl.ACCOUNT_SIZE);
  base.copy(padded);
  const pointer = Buffer.concat([authority.toBuffer(), mint.toBuffer()]);
  const metadata = Buffer.from(
    packTokenMetadata({ updateAuthority: authority, mint, name, symbol, uri, additionalMetadata: [] }),
  );
  return Buffer.concat([
    padded,
    Buffer.from([spl.AccountType.Mint]),
    tlv(spl.ExtensionType.MetadataPointer, pointer),
    tlv(spl.ExtensionType.TokenMetadata, metadata),
  ]);
}

function encodeTokenAccount({ mint, owner, amount, is2022 }) {
  const base = Buffer.alloc(spl.ACCOUNT_SIZE);
  spl.AccountLayout.encode(
    {
      mint,
      owner,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: spl.AccountState.Initialized,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    base,
  );
  if (!is2022) return base;
  // Associated token accounts under Token-2022 carry the ImmutableOwner extension.
  return Buffer.concat([base, Buffer.from([spl.AccountType.Account]), tlv(spl.ExtensionType.ImmutableOwner, Buffer.alloc(0))]);
}

/** Metaplex Token Metadata v1 account (strings padded to their max length, as Metaplex does). */
function encodeMetaplexMetadata({ authority, mint, name, symbol, uri }) {
  const str = (s, max, field) => {
    const bytes = Buffer.from(s, 'utf8');
    if (bytes.length > max) throw new Error(`${field} "${s}" is longer than ${max} bytes`);
    const out = Buffer.alloc(4 + max);
    out.writeUInt32LE(max, 0);
    bytes.copy(out, 4);
    return out;
  };
  const body = Buffer.concat([
    Buffer.from([4]), // Key::MetadataV1
    authority.toBuffer(),
    mint.toBuffer(),
    str(name, 32, 'name'),
    str(symbol, 10, 'symbol'),
    str(uri, 200, 'uri'),
    Buffer.from([0, 0]), // seller_fee_basis_points
    Buffer.from([0]), // creators: None
    Buffer.from([0]), // primary_sale_happened
    Buffer.from([1]), // is_mutable
    Buffer.from([0]), // edition_nonce: None
    Buffer.from([1, 2]), // token_standard: Some(Fungible)
    Buffer.from([0, 0, 0, 0]), // collection, uses, collection_details, programmable_config: None
  ]);
  const out = Buffer.alloc(METAPLEX_METADATA_SIZE);
  body.copy(out);
  return out;
}

// ---------------------------------------------------------------- fake state

const fake = {
  accounts: new Map(), // pubkey -> { owner, data, parsed, isTokenAccount }
  byOwner: new Map(), // wallet -> [token account pubkeys]
  mints: new Map(), // mint -> token
  tokenAccounts: new Map(), // token account pubkey -> { mint, amount }
  metadataJson: new Map(), // id -> JSON served at /token-metadata/<id>.json
};

function addAccount(pubkey, acct) {
  fake.accounts.set(pubkey.toBase58(), acct);
}

for (const t of config.tokens) {
  const id = t.id || t.symbol;
  if (!id) die('each token needs a symbol (or an id)');
  if (!t.name || !t.symbol) die(`token "${id}" needs a name and a symbol`);
  if (!t.balances || Object.keys(t.balances).length === 0) die(`token "${id}" needs balances: { "<wallet address>": "<amount>" }`);

  const decimals = t.decimals ?? 6;
  const program = t.program || 'token';
  if (!['token', 'token-2022'].includes(program)) die(`token "${id}": program must be "token" or "token-2022"`);
  const is2022 = program === 'token-2022';
  const programId = is2022 ? spl.TOKEN_2022_PROGRAM_ID : spl.TOKEN_PROGRAM_ID;
  const programName = is2022 ? 'spl-token-2022' : 'spl-token';

  const mint = deriveKey(`mint:${id}`);
  const authority = deriveKey(`authority:${id}`);

  let uri = t.uri;
  if (!uri) {
    uri = `${PUBLIC_URL}/token-metadata/${encodeURIComponent(id)}.json`;
    fake.metadataJson.set(id, { name: t.name, symbol: t.symbol, description: t.description || '', image: t.image || '' });
  }

  // Token accounts, one ATA per wallet.
  let supply = 0n;
  const holders = [];
  for (const [wallet, value] of Object.entries(t.balances)) {
    let owner;
    try {
      owner = new PublicKey(wallet);
    } catch {
      die(`token "${id}": "${wallet}" is not a valid wallet address`);
    }
    let amount;
    try {
      amount = toBaseUnits(value, decimals);
    } catch (e) {
      die(`token "${id}": ${e.message}`);
    }
    supply += amount;
    const ata = spl.getAssociatedTokenAddressSync(mint, owner, false, programId);
    const data = encodeTokenAccount({ mint, owner, amount, is2022 });
    const info = {
      isNative: false,
      mint: mint.toBase58(),
      owner: owner.toBase58(),
      state: 'initialized',
      tokenAmount: tokenAmount(amount, decimals),
    };
    if (is2022) info.extensions = [{ extension: 'immutableOwner' }];
    addAccount(ata, {
      owner: programId.toBase58(),
      data,
      parsed: { program: programName, parsed: { info, type: 'account' }, space: data.length },
      isTokenAccount: true,
    });
    fake.tokenAccounts.set(ata.toBase58(), { mint: mint.toBase58(), amount, decimals });
    const list = fake.byOwner.get(owner.toBase58()) || [];
    list.push(ata.toBase58());
    fake.byOwner.set(owner.toBase58(), list);
    holders.push({ address: ata.toBase58(), amount });
  }

  // Mint.
  const mintData = encodeMint({ supply, decimals, is2022, mint, authority, name: t.name, symbol: t.symbol, uri });
  const mintInfo = { decimals, freezeAuthority: null, isInitialized: true, mintAuthority: null, supply: supply.toString() };
  if (is2022) {
    mintInfo.extensions = [
      { extension: 'metadataPointer', state: { authority: authority.toBase58(), metadataAddress: mint.toBase58() } },
      {
        extension: 'tokenMetadata',
        state: {
          additionalMetadata: [],
          mint: mint.toBase58(),
          name: t.name,
          symbol: t.symbol,
          updateAuthority: authority.toBase58(),
          uri,
        },
      },
    ];
  }
  addAccount(mint, {
    owner: programId.toBase58(),
    data: mintData,
    parsed: { program: programName, parsed: { info: mintInfo, type: 'mint' }, space: mintData.length },
  });

  // Metaplex metadata PDA (most wallets look here for name/symbol/logo, for both token programs).
  const [metadataPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), MPL_TOKEN_METADATA.toBuffer(), mint.toBuffer()],
    MPL_TOKEN_METADATA,
  );
  addAccount(metadataPda, {
    owner: MPL_TOKEN_METADATA.toBase58(),
    data: encodeMetaplexMetadata({ authority, mint, name: t.name, symbol: t.symbol, uri }),
    parsed: null,
  });

  fake.mints.set(mint.toBase58(), {
    id,
    symbol: t.symbol,
    decimals,
    supply,
    programId: programId.toBase58(),
    metadataPda: metadataPda.toBase58(),
    uri,
    holders: holders.sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0)),
  });
}

// ---------------------------------------------------------------- response encoding

function rentExemptLamports(len) {
  return (128 + len) * 6960; // 3480 lamports/byte-year * 2 years
}

function encodeData(acct, encoding, dataSlice) {
  if (encoding === 'jsonParsed' && acct.parsed && !dataSlice) return acct.parsed;
  let data = acct.data;
  if (dataSlice) data = data.subarray(dataSlice.offset, dataSlice.offset + dataSlice.length);
  switch (encoding) {
    case undefined:
    case 'binary':
      return bs58.encode(data); // legacy default: bare base58 string
    case 'base58':
      return [bs58.encode(data), 'base58'];
    case 'base64+zstd':
      if (zlib.zstdCompressSync) return [zlib.zstdCompressSync(data).toString('base64'), 'base64+zstd'];
      return [data.toString('base64'), 'base64'];
    default: // base64, or jsonParsed for accounts without a parser
      return [data.toString('base64'), 'base64'];
  }
}

function uiAccount(acct, cfg = {}) {
  return {
    data: encodeData(acct, cfg.encoding, cfg.dataSlice),
    executable: false,
    lamports: rentExemptLamports(acct.data.length),
    owner: acct.owner,
    rentEpoch: U64_MAX,
    space: acct.data.length,
  };
}

function keyedAccount(pubkey, cfg) {
  return { pubkey, account: uiAccount(fake.accounts.get(pubkey), cfg) };
}

function matchesFilters(acct, filters = []) {
  for (const f of filters) {
    if (f.dataSize !== undefined && acct.data.length !== Number(f.dataSize)) return false;
    if (f.memcmp) {
      const { offset, bytes, encoding } = f.memcmp;
      const want = encoding === 'base64' ? Buffer.from(bytes, 'base64') : Buffer.from(bs58.decode(bytes));
      const o = Number(offset);
      if (!acct.data.subarray(o, o + want.length).equals(want)) return false;
    }
    if (f.tokenAccountState !== undefined && !acct.isTokenAccount) return false;
  }
  return true;
}

// ---------------------------------------------------------------- per-method plans
//
// plan(req) returns PASS (forward untouched), { local(ctx) } (answer here), or
// { patch(result, ctx) } (forward, then merge fake data into the result).

const withCtx = (ctx, value) => ({ context: ctx, value });

const planners = {
  getAccountInfo([pubkey, cfg]) {
    if (!fake.accounts.has(pubkey)) return PASS;
    return { local: (ctx) => withCtx(ctx, uiAccount(fake.accounts.get(pubkey), cfg)) };
  },

  getMultipleAccounts([pubkeys, cfg]) {
    if (!Array.isArray(pubkeys) || !pubkeys.some((k) => fake.accounts.has(k))) return PASS;
    return {
      patch(result) {
        pubkeys.forEach((k, i) => {
          if (fake.accounts.has(k)) result.value[i] = uiAccount(fake.accounts.get(k), cfg);
        });
        return result;
      },
    };
  },

  getTokenAccountsByOwner([owner, filter = {}, cfg]) {
    const mine = fake.byOwner.get(owner);
    if (filter.mint && fake.mints.has(filter.mint)) {
      // Upstream would reject an unknown mint, so answer entirely here.
      const keys = (mine || []).filter((k) => fake.tokenAccounts.get(k).mint === filter.mint);
      return { local: (ctx) => withCtx(ctx, keys.map((k) => keyedAccount(k, cfg))) };
    }
    if (!mine) return PASS;
    const extra = mine.filter((k) => filter.programId && fake.accounts.get(k).owner === filter.programId);
    if (extra.length === 0) return PASS;
    return {
      patch(result) {
        result.value.push(...extra.map((k) => keyedAccount(k, cfg)));
        return result;
      },
    };
  },

  getProgramAccounts([programId, cfg = {}]) {
    const extra = [...fake.accounts.keys()].filter((k) => {
      const a = fake.accounts.get(k);
      return a.owner === programId && matchesFilters(a, cfg.filters);
    });
    if (extra.length === 0) return PASS;
    return {
      patch(result) {
        const list = Array.isArray(result) ? result : result.value;
        list.push(...extra.map((k) => keyedAccount(k, cfg)));
        return result;
      },
    };
  },

  getTokenAccountBalance([pubkey]) {
    const ta = fake.tokenAccounts.get(pubkey);
    if (!ta) return PASS;
    return { local: (ctx) => withCtx(ctx, tokenAmount(ta.amount, ta.decimals)) };
  },

  getTokenSupply([mint]) {
    const m = fake.mints.get(mint);
    if (!m) return PASS;
    return { local: (ctx) => withCtx(ctx, tokenAmount(m.supply, m.decimals)) };
  },

  getTokenLargestAccounts([mint]) {
    const m = fake.mints.get(mint);
    if (!m) return PASS;
    return {
      local: (ctx) =>
        withCtx(
          ctx,
          m.holders.slice(0, 20).map((h) => ({ address: h.address, ...tokenAmount(h.amount, m.decimals) })),
        ),
    };
  },
};

function plan(req) {
  const p = planners[req && req.method];
  if (!p) return PASS;
  try {
    return p(Array.isArray(req.params) ? req.params : []);
  } catch {
    return PASS; // malformed params: let upstream produce the proper error
  }
}

// ---------------------------------------------------------------- upstream

async function upstreamPost(bodyText) {
  const res = await fetch(UPSTREAM, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: bodyText,
  });
  return { status: res.status, text: await res.text() };
}

let cachedCtx = null;
let cachedAt = 0;

function rememberContext(result) {
  if (result && typeof result === 'object' && result.context && result.context.slot !== undefined) {
    cachedCtx = result.context;
    cachedAt = Date.now();
  }
}

async function currentContext() {
  if (cachedCtx && Date.now() - cachedAt < 1000) return cachedCtx;
  try {
    const { text } = await upstreamPost(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [{ commitment: 'confirmed' }] }));
    const slot = JSONbig.parse(text).result;
    cachedCtx = { ...(cachedCtx || {}), slot };
    cachedAt = Date.now();
  } catch {
    cachedCtx = cachedCtx || { slot: 0 };
  }
  return cachedCtx;
}

// ---------------------------------------------------------------- request handling

function logLine(text) {
  if (LOG) console.log(`${new Date().toISOString().slice(11, 23)}  ${text}`);
}

// Verbose mode: who is calling (first time per origin + user agent), and every
// preflight, GET and websocket message, since a blocked preflight never reaches POST.
const seenClients = new Set();
function logClient(kind, req) {
  if (!LOG_PARAMS) return;
  const origin = req.headers.origin || '-';
  const ua = (req.headers['user-agent'] || '-').slice(0, 80);
  const ip = req.headers['cf-connecting-ip'] || 'local'; // set when the request came through a Cloudflare tunnel
  if (kind === 'POST') {
    const key = `${origin}|${ua}|${ip}`;
    if (seenClients.has(key)) return;
    seenClients.add(key);
  }
  let line = `client    ${kind} ${req.url}  ip=${ip}  origin=${origin}  ua=${ua}`;
  if (kind === 'OPTIONS') {
    const h = (n) => req.headers[n] || '-';
    line += `  acr-method=${h('access-control-request-method')} acr-headers=${h('access-control-request-headers')} acr-private-network=${h('access-control-request-private-network')}`;
  }
  logLine(line);
}

function log(req, how) {
  if (!LOG) return;
  let line = `${new Date().toISOString().slice(11, 23)}  ${how.padEnd(9)} ${req && req.method}`;
  if (LOG_PARAMS && req && req.params !== undefined) {
    const p = JSONbig.stringify(req.params);
    line += `  ${p.length > 300 ? `${p.slice(0, 300)}…` : p}`;
  }
  console.log(line);
}

async function handleRpc(bodyText) {
  let parsed;
  try {
    parsed = JSONbig.parse(bodyText);
  } catch {
    return upstreamPost(bodyText); // not JSON: upstream returns the parse error
  }

  const isBatch = Array.isArray(parsed);
  const reqs = isBatch ? parsed : [parsed];
  const plans = reqs.map(plan);

  // Fast path: a single request we don't touch is piped straight through.
  if (!isBatch && plans[0] === PASS) {
    log(parsed, 'pass');
    const up = await upstreamPost(bodyText);
    if (LOG_PARAMS && (up.status !== 200 || up.text.includes('"error"'))) logLine(`  upstream HTTP ${up.status}  ${up.text.slice(0, 200)}`);
    return up;
  }

  // Forward everything that isn't answered locally, in one upstream batch,
  // with internal ids so responses can be matched back regardless of order.
  const forwardIdx = reqs.map((_, i) => i).filter((i) => !plans[i] || !plans[i].local);
  const responses = new Array(reqs.length);
  if (forwardIdx.length) {
    const upBody = JSONbig.stringify(forwardIdx.map((i) => ({ ...reqs[i], id: i })));
    const up = await upstreamPost(upBody);
    let upParsed;
    try {
      upParsed = JSONbig.parse(up.text);
    } catch {
      return up; // upstream sent something odd (rate-limit page, etc.): hand it back as-is
    }
    if (!Array.isArray(upParsed)) {
      if (!isBatch) return up; // single request answered with an error object
      upParsed = forwardIdx.map((i) => ({ ...upParsed, id: i }));
    }
    for (const r of upParsed) {
      const i = Number(r.id);
      if (LOG_PARAMS && r.error) logLine(`  upstream error for ${reqs[i] && reqs[i].method}: ${JSONbig.stringify(r.error).slice(0, 200)}`);
      rememberContext(r.result);
      const p = plans[i];
      if (p !== PASS && p.patch && r.result !== undefined && r.result !== null) {
        try {
          r.result = p.patch(r.result);
          log(reqs[i], 'patched');
        } catch {
          log(reqs[i], 'pass');
        }
      } else {
        log(reqs[i], 'pass');
      }
      responses[i] = { ...r, id: reqs[i].id };
    }
  }

  const localIdx = reqs.map((_, i) => i).filter((i) => plans[i] && plans[i].local);
  if (localIdx.length) {
    const ctx = await currentContext();
    for (const i of localIdx) {
      responses[i] = { jsonrpc: '2.0', id: reqs[i].id, result: plans[i].local(ctx) };
      log(reqs[i], 'local');
    }
  }

  const out = isBatch ? responses.filter(Boolean) : responses[0];
  return { status: 200, text: JSONbig.stringify(out) };
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-max-age': '86400',
};

function serveMetadata(req, res) {
  const m = /^\/token-metadata\/([^/]+)\.json$/.exec(req.url.split('?')[0]);
  const json = m && fake.metadataJson.get(decodeURIComponent(m[1]));
  if (!json) return false;
  res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
  res.end(JSON.stringify(json));
  return true;
}

const server = http.createServer((req, res) => {
  logClient(req.method, req);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (req.method === 'GET') {
    if (serveMetadata(req, res)) return;
    res.writeHead(200, { ...CORS, 'content-type': 'text/plain' });
    return res.end('ok');
  }
  if (req.method !== 'POST') {
    res.writeHead(405, CORS);
    return res.end();
  }
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 10 * 1024 * 1024) req.destroy();
    else chunks.push(c);
  });
  req.on('end', async () => {
    const body = Buffer.concat(chunks).toString('utf8');
    try {
      const { status, text } = await handleRpc(body);
      res.writeHead(status, { ...CORS, 'content-type': 'application/json' });
      res.end(text);
    } catch (err) {
      console.error('upstream error:', err.message);
      let id = null;
      try {
        id = JSON.parse(body).id ?? null;
      } catch {}
      res.writeHead(502, { ...CORS, 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: `proxy: upstream unreachable (${err.message})` } }));
    }
  });
});

// ---------------------------------------------------------------- websockets (pass-through)

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (client, req) => {
  if (LOG_PARAMS) logClient('WS', req);
  const upstream = new WebSocket(UPSTREAM_WS);
  const queue = [];
  upstream.on('open', () => {
    for (const [m, binary] of queue) upstream.send(m, { binary });
    queue.length = 0;
  });
  client.on('message', (m, binary) => {
    if (LOG_PARAMS) {
      try {
        const msg = JSON.parse(m.toString());
        logLine(`ws        ${msg.method}  ${JSON.stringify(msg.params ?? []).slice(0, 200)}`);
      } catch {}
    }
    if (upstream.readyState === WebSocket.OPEN) upstream.send(m, { binary });
    else queue.push([m, binary]);
  });
  upstream.on('message', (m, binary) => {
    if (client.readyState === WebSocket.OPEN) client.send(m, { binary });
  });
  const closeBoth = () => {
    if (client.readyState <= WebSocket.OPEN) client.close();
    if (upstream.readyState <= WebSocket.OPEN) upstream.terminate();
  };
  client.on('close', closeBoth);
  upstream.on('close', closeBoth);
  client.on('error', closeBoth);
  upstream.on('error', (e) => {
    console.error('upstream websocket error:', e.message);
    closeBoth();
  });
});

function acceptUpgrade(req, socket, head) {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
}

server.on('upgrade', acceptUpgrade);

const wsServer = http.createServer((_, res) => {
  res.writeHead(426, CORS);
  res.end('websocket only');
});
wsServer.on('upgrade', acceptUpgrade);

// ---------------------------------------------------------------- start

server.listen(PORT, HOST, () => {
  wsServer.listen(WS_PORT, HOST, () => {
    console.log(`\nsolana-token-injector`);
    console.log(`  RPC        http://${HOST}:${PORT}   (websockets also on :${WS_PORT})`);
    console.log(`  upstream   ${UPSTREAM}`);
    console.log(`  upstream ws ${UPSTREAM_WS}\n`);
    for (const [mint, m] of fake.mints) {
      console.log(`  ${m.symbol}  mint ${mint}  (${m.programId === spl.TOKEN_2022_PROGRAM_ID.toBase58() ? 'Token-2022' : 'Token'})`);
      console.log(`        metadata uri ${m.uri}`);
      for (const h of m.holders) console.log(`        token account ${h.address}  balance ${uiAmountString(h.amount, m.decimals)}`);
    }
    console.log(`\nPoint your wallet's custom RPC at http://${HOST}:${PORT}\n`);
  });
});

module.exports = { server, wsServer, fake };
