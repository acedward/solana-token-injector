'use strict';
// A minimal mock Solana RPC (HTTP + websocket on port + 1) for the service
// tests. It knows nothing about the injected tokens: anything the service
// adds must come from the service itself.
// AA 00059: getGenesisHash and SPL mints for getAccountInfo (jsonParsed), and a down switch, for the
// journey registry's start-up checks (setGenesisHash, setMint, setDown).

const http = require('http');
const { WebSocketServer } = require('ws');
const JSONbig = require('json-bigint')({ useNativeBigInt: true });
const { freePort } = require('./ports');

const ctx = { slot: 4242, apiVersion: '2.0.0' };

const GENESIS = 'GH7ome3EiwEr7tu9JuTh2dpYWBJK3z69Xm1ZE3MEE6JC';

function answer(method, params, extra) {
  switch (method) {
    case 'getGenesisHash':
      return { result: extra.genesisHash };
    case 'getAccountInfo': {
      if (extra.accounts.has(params[0])) return { result: { context: ctx, value: extra.accounts.get(params[0]) } };
      const m = extra.mints.get(params[0]);
      if (!m) return { result: { context: ctx, value: null } };
      return {
        result: {
          context: ctx,
          value: {
            owner: m.owner,
            lamports: 1461600,
            executable: false,
            rentEpoch: 0,
            space: 82,
            data: { program: m.owner === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' ? 'spl-token' : 'spl-token-2022', parsed: { type: 'mint', info: { decimals: m.decimals, freezeAuthority: null, isInitialized: true, mintAuthority: null, supply: '0' } }, space: 82 },
          },
        },
      };
    }
    case 'getSlot':
      return { result: ctx.slot };
    case 'getHealth':
      return { result: 'ok' };
    case 'getBalance':
      return { result: { context: ctx, value: 1000000000 } };
    case 'getMultipleAccounts':
      return { result: { context: ctx, value: (params[0] || []).map((k) => extra.accounts.get(k) ?? null) } };
    case 'getTokenAccountsByOwner': {
      const [, filter = {}] = params;
      if (filter.mint) return { error: { code: -32602, message: 'Invalid param: could not find mint' } };
      return { result: { context: ctx, value: [] } };
    }
    case 'getProgramAccounts':
      return { result: [] };
    default:
      return { error: { code: -32601, message: 'Method not found' } };
  }
}

async function startMockUpstream() {
  const port = await freePort(2);
  const calls = [];
  const extra = { genesisHash: GENESIS, mints: new Map(), accounts: new Map(), down: false };
  const server = http.createServer((req, res) => {
    if (extra.down) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      return res.end('down');
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed;
      try {
        parsed = JSONbig.parse(body);
      } catch {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      }
      const one = (r) => {
        calls.push(r.method);
        return { jsonrpc: '2.0', id: r.id, ...answer(r.method, r.params || [], extra) };
      };
      const out = Array.isArray(parsed) ? parsed.map(one) : one(parsed);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSONbig.stringify(out));
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const wss = new WebSocketServer({ port: port + 1, host: '127.0.0.1' });
  wss.on('connection', (ws) => ws.on('message', (m) => ws.send(JSON.stringify({ jsonrpc: '2.0', result: 42, id: JSON.parse(m).id }))));
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port + 1}`,
    calls,
    genesisHash: () => extra.genesisHash,
    setGenesisHash(h) {
      extra.genesisHash = h;
    },
    /** An SPL mint for getAccountInfo: owner = the token program id, decimals. */
    setMint(address, { owner = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', decimals = 6 } = {}) {
      extra.mints.set(address, { owner, decimals });
    },
    setDown(v) {
      extra.down = v;
    },
    /** AA 00059 P7: a raw account (base64 data) for getAccountInfo / getMultipleAccounts. */
    setAccount(pubkey, { owner, data, lamports = 5616720 }) {
      extra.accounts.set(pubkey, { data: [Buffer.from(data).toString('base64'), 'base64'], executable: false, lamports, owner, rentEpoch: 18446744073709551615n, space: data.length });
    },
    async close() {
      for (const c of wss.clients) c.terminate();
      await new Promise((r) => wss.close(r));
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

module.exports = { startMockUpstream };
