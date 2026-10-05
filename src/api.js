'use strict';
// Web page + JSON API on the RPC port (Q7, FR-101, FR-102):
//   GET    /                        web page
//   GET    /api/registrations       list (viewing keys masked, Q10)
//   POST   /api/registrations       {solanaAddress, viewingKey} -> 201 new / 200 exists / 400 invalid
//   GET    /api/registrations/:id   one registration
//   DELETE /api/registrations/:id   204 / 404
//   GET    /health                  {ok, upstream, indexer, decryptor, registrations, accounts?}
//   /api/accounts…                   Passport account registrations (AA 00059 I-4: src/accounts/api.js)
// POST / stays JSON-RPC (handled by server.js). Request bodies are never logged.

const fs = require('fs');
const path = require('path');
const { readBody, sendJson, CORS } = require('./server');
const log = require('./log');
const { createAccountRoutes } = require('./accounts/api');

const PAGE_FILE = path.join(__dirname, 'web', 'index.html');
const MAX_API_BODY = 16 * 1024;
const PROBE_TIMEOUT_MS = 3000;

async function probe(fn) {
  try {
    return await fn();
  } catch (err) {
    return { ok: false, error: log.redact(err.name === 'TimeoutError' ? 'timeout' : err.message) };
  }
}

function createApiRoutes({ config, registry, decryptor, upstream, accounts = null }) {
  const midnight = config.midnight;

  // The page is read once per process (no build step); placeholders filled per request.
  let pageTemplate = null;
  function page() {
    if (pageTemplate === null) pageTemplate = fs.readFileSync(PAGE_FILE, 'utf8');
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    return pageTemplate
      .replaceAll('{{RPC_URL}}', esc(config.publicUrl))
      .replaceAll('{{NETWORK_ID}}', esc(midnight ? midnight.networkId : 'not configured'))
      .replaceAll('{{KEY_PREFIX}}', esc(midnight ? (midnight.networkId === 'mainnet' ? 'mn_shield-esk1' : `mn_shield-esk_${midnight.networkId}1`) : 'mn_shield-esk_…1'));
  }

  async function health() {
    const up = probe(async () => {
      const { status, text } = await upstream.post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }), { timeoutMs: PROBE_TIMEOUT_MS });
      const body = JSON.parse(text);
      if (body.result === 'ok') return { ok: true };
      return { ok: false, error: body.error ? body.error.message : `HTTP ${status}` };
    });
    const idx = midnight
      ? probe(async () => {
          const res = await fetch(midnight.indexerHttp, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query: '{ __typename }' }),
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          });
          return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
        })
      : Promise.resolve({ ok: false, configured: false });
    const [u, i] = await Promise.all([up, idx]);
    const d = decryptor ? decryptor.status() : { ok: false, configured: false };
    const regs = registry ? registry.health() : { total: 0 };
    return {
      ok: u.ok && (!midnight || (i.ok && d.ok)),
      upstream: u,
      indexer: midnight ? { ...i, networkId: midnight.networkId } : i,
      decryptor: d,
      registrations: regs,
      // AA 00059: the Passport account registrations by status (absent when the source is off).
      ...(accounts ? { accounts: accounts.health() } : {}),
    };
  }

  const accountRoutes = createAccountRoutes({ accounts });

  const notConfigured = (res) => sendJson(res, 503, { error: 'Midnight is not configured on this service (no "midnight" block in config.json)' });

  return async function routes(req, res) {
    const url = req.url.split('?')[0];

    if (url === '/' && req.method === 'GET') {
      res.writeHead(200, { ...CORS, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page());
      return true;
    }

    if (url === '/health' && req.method === 'GET') {
      sendJson(res, 200, await health(), { 'cache-control': 'no-store' });
      return true;
    }

    if (url === '/api/registrations') {
      if (!registry) return notConfigured(res), true;
      if (req.method === 'GET') {
        sendJson(res, 200, registry.list(), { 'cache-control': 'no-store' });
        return true;
      }
      if (req.method === 'POST') {
        let body;
        try {
          body = JSON.parse(await readBody(req, MAX_API_BODY));
        } catch (err) {
          if (err.message === 'body too large') return true; // socket destroyed
          sendJson(res, 400, { error: 'request body must be JSON: {"solanaAddress": "...", "viewingKey": "..."}' });
          return true;
        }
        try {
          const { record, created } = await registry.register(body);
          sendJson(res, created ? 201 : 200, registry.view(record));
        } catch (err) {
          if (err.status) sendJson(res, err.status, { error: err.message });
          else throw err;
        }
        return true;
      }
      sendJson(res, 405, { error: 'use GET or POST' }, { allow: 'GET, POST, OPTIONS' });
      return true;
    }

    const m = /^\/api\/registrations\/([^/]+)$/.exec(url);
    if (m) {
      if (!registry) return notConfigured(res), true;
      const id = m[1];
      if (req.method === 'GET') {
        const v = /^[0-9a-f]{16}$/.test(id) && registry.get(id);
        if (v) sendJson(res, 200, v, { 'cache-control': 'no-store' });
        else sendJson(res, 404, { error: 'no such registration' });
        return true;
      }
      if (req.method === 'DELETE') {
        let removed = null;
        try {
          removed = /^[0-9a-f]{16}$/.test(id) ? registry.remove(id) : null;
        } catch (err) {
          if (err.status) return sendJson(res, err.status, { error: err.message }), true;
          throw err;
        }
        if (removed) {
          res.writeHead(204, CORS);
          res.end();
        } else sendJson(res, 404, { error: 'no such registration' });
        return true;
      }
      sendJson(res, 405, { error: 'use GET or DELETE' }, { allow: 'GET, DELETE, OPTIONS' });
      return true;
    }

    if (await accountRoutes(req, res, url)) return true;

    if (url.startsWith('/api/')) {
      sendJson(res, 404, { error: 'not found' });
      return true;
    }
    return false;
  };
}

module.exports = { createApiRoutes };
