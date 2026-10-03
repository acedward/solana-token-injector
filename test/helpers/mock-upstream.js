'use strict';
// A minimal mock Solana RPC (HTTP + websocket on port + 1) for the service
// tests. It knows nothing about the injected tokens: anything the service
// adds must come from the service itself.

const http = require('http');
const { WebSocketServer } = require('ws');
const JSONbig = require('json-bigint')({ useNativeBigInt: true });
const { freePort } = require('./ports');

const ctx = { slot: 4242, apiVersion: '2.0.0' };

function answer(method, params) {
  switch (method) {
    case 'getSlot':
      return { result: ctx.slot };
    case 'getHealth':
      return { result: 'ok' };
    case 'getBalance':
      return { result: { context: ctx, value: 1000000000 } };
    case 'getAccountInfo':
      return { result: { context: ctx, value: null } };
    case 'getMultipleAccounts':
      return { result: { context: ctx, value: (params[0] || []).map(() => null) } };
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
  const server = http.createServer((req, res) => {
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
        return { jsonrpc: '2.0', id: r.id, ...answer(r.method, r.params || []) };
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
    async close() {
      for (const c of wss.clients) c.terminate();
      await new Promise((r) => wss.close(r));
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

module.exports = { startMockUpstream };
