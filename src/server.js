'use strict';
// The HTTP server: JSON-RPC on POST /, token metadata JSON, CORS, and the
// websocket upgrade (on the RPC port and on a second port, port + 1).

const http = require('http');
const log = require('./log');

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, DELETE, OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-max-age': '86400',
};

const MAX_BODY = 10 * 1024 * 1024;

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        req.destroy();
        reject(new Error('body too large'));
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { ...CORS, 'content-type': 'application/json', ...extraHeaders });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function serveMetadata(getState, req, res) {
  const m = /^\/token-metadata\/([^/]+)\.json$/.exec(req.url.split('?')[0]);
  let id = null;
  try {
    id = m && decodeURIComponent(m[1]);
  } catch {}
  const json = id !== null && getState().metadataJson.get(id);
  if (!json) return false;
  sendJson(res, 200, json);
  return true;
}

async function handleRpcPost(handleRpc, req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    return; // oversized: socket already destroyed
  }
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
    sendJson(res, 502, { jsonrpc: '2.0', id, error: { code: -32603, message: `proxy: upstream unreachable (${err.message})` } });
  }
}

/**
 * createServers({ handleRpc, getState, acceptUpgrade, routes? })
 * `routes(req, res)` may handle a request (return true) before the defaults.
 */
function createServers({ handleRpc, getState, acceptUpgrade, routes }) {
  const server = http.createServer(async (req, res) => {
    log.client(req.method, req);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return res.end();
    }
    if (routes) {
      try {
        if (await routes(req, res)) return;
      } catch (err) {
        log.warn(`route error ${req.method} ${req.url.split('?')[0]}: ${err.message}`);
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
        else res.end();
        return;
      }
    }
    if (req.method === 'GET') {
      if (serveMetadata(getState, req, res)) return;
      res.writeHead(200, { ...CORS, 'content-type': 'text/plain' });
      return res.end('ok');
    }
    if (req.method !== 'POST') {
      res.writeHead(405, CORS);
      return res.end();
    }
    return handleRpcPost(handleRpc, req, res);
  });
  server.on('upgrade', acceptUpgrade);

  const wsServer = http.createServer((_, res) => {
    res.writeHead(426, CORS);
    res.end('websocket only');
  });
  wsServer.on('upgrade', acceptUpgrade);

  return { server, wsServer };
}

module.exports = { createServers, CORS, readBody, sendJson };
