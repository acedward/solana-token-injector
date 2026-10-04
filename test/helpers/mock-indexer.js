'use strict';
// In-process mock of the Midnight indexer's viewing-key API (v4 GraphQL):
//   POST /api/v4/graphql   connect(viewingKey) -> session id, disconnect(sessionId), { __typename }
//   WS   /api/v4/graphql/ws  hand-rolled `graphql-transport-ws` server for
//        shieldedTransactions(sessionId, index): replays the key's relevant
//        transactions from `index`, then a progress event, then live events.
// Like the real indexer, a new `connect` for a key replaces its session id.
// Controls: addTransaction, setProgress, dropSockets, setDown, rejectSessions.

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { freePort } = require('./ports');

const PATH = '/api/v4/graphql';

async function startMockIndexer({ port, progressEveryMs = 0 } = {}) {
  port = port || (await freePort());
  const keys = new Map(); // viewingKey -> { txs: [RelevantTransaction events], sessionId }
  const sessions = new Map(); // sessionId -> viewingKey
  const subs = new Set(); // { ws, id, key }
  const calls = { connect: 0, disconnect: [], subscribe: 0, queries: [], connectKeys: [] };
  let progress = { highestEndIndex: 10, highestCheckedEndIndex: 10, highestRelevantEndIndex: 10 };
  let down = false;
  let rejectSessions = false;
  const rejectedKeys = new Set(); // subscriptions for these keys fail
  let txSeq = 0;

  const keyState = (k) => {
    if (!keys.has(k)) keys.set(k, { txs: [], sessionId: null });
    return keys.get(k);
  };
  const progressEvent = () => ({ __typename: 'ShieldedTransactionsProgress', ...progress });
  const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
  const next = (sub, ev) => send(sub.ws, { id: sub.id, type: 'next', payload: { data: { shieldedTransactions: ev } } });

  const server = http.createServer((req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (down) return reply(503, { errors: [{ message: 'service unavailable' }] });
    if (req.method !== 'POST' || req.url !== PATH) return reply(404, { errors: [{ message: 'not found' }] });
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let q;
      try {
        q = JSON.parse(body);
      } catch {
        return reply(400, { errors: [{ message: 'bad json' }] });
      }
      calls.queries.push(q.query);
      if (/\bconnect\(viewingKey: \$viewingKey\)/.test(q.query)) {
        calls.connect++;
        const vk = q.variables && q.variables.viewingKey;
        calls.connectKeys.push(vk);
        if (typeof vk !== 'string' || !vk.startsWith('mn_shield-esk')) return reply(200, { data: null, errors: [{ message: 'invalid viewing key' }] });
        const st = keyState(vk);
        if (st.sessionId) sessions.delete(st.sessionId); // one session per key
        st.sessionId = crypto.randomBytes(32).toString('hex');
        sessions.set(st.sessionId, vk);
        return reply(200, { data: { connect: st.sessionId } });
      }
      if (/\bdisconnect\(sessionId: \$sessionId\)/.test(q.query)) {
        calls.disconnect.push(q.variables && q.variables.sessionId);
        sessions.delete(q.variables && q.variables.sessionId);
        return reply(200, { data: { disconnect: null } });
      }
      if (/__typename/.test(q.query)) return reply(200, { data: { __typename: 'Query' } });
      return reply(200, { errors: [{ message: 'unsupported query in mock' }] });
    });
  });

  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has('graphql-transport-ws') ? 'graphql-transport-ws' : false),
  });
  server.on('upgrade', (req, socket, head) => {
    if (down || req.url !== `${PATH}/ws`) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    let acked = false;
    ws.on('message', (raw) => {
      let m;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return ws.close(4400, 'Invalid message received');
      }
      if (m.type === 'connection_init') {
        acked = true;
        return send(ws, { type: 'connection_ack' });
      }
      if (m.type === 'ping') return send(ws, { type: 'pong' });
      if (m.type === 'pong') return undefined;
      if (m.type === 'complete') {
        for (const s of subs) if (s.ws === ws && s.id === m.id) subs.delete(s);
        return undefined;
      }
      if (m.type === 'subscribe') {
        if (!acked) return ws.close(4401, 'Unauthorized');
        calls.subscribe++;
        calls.queries.push(m.payload.query);
        const { sessionId, index = 0 } = m.payload.variables || {};
        const key = sessions.get(sessionId);
        if (rejectSessions || !key || rejectedKeys.has(key) || !/shieldedTransactions\(sessionId: \$sessionId, index: \$index\)/.test(m.payload.query)) {
          return send(ws, { id: m.id, type: 'error', payload: [{ message: 'unknown or expired session ID' }] });
        }
        const sub = { ws, id: m.id, key };
        subs.add(sub);
        for (const ev of keyState(key).txs.slice(index || 0)) next(sub, ev);
        next(sub, progressEvent());
        return undefined;
      }
      return undefined;
    });
    ws.on('close', () => {
      for (const s of subs) if (s.ws === ws) subs.delete(s);
    });
  });

  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  // Like the real indexer, progress events can also come on an interval.
  const ticker = progressEveryMs ? setInterval(() => {
    for (const s of subs) next(s, progressEvent());
  }, progressEveryMs) : null;

  const api = {
    port,
    httpUrl: `http://127.0.0.1:${port}${PATH}`,
    wsUrl: `ws://127.0.0.1:${port}${PATH}/ws`,
    calls,
    /** Number of live subscriptions (optionally for one key). */
    subscriptions: (key) => [...subs].filter((s) => !key || s.key === key).length,
    /**
     * Adds a relevant transaction for `viewingKey` and pushes it to its live
     * subscriptions. `tx`: { raw, status?, segments?, hash? }.
     */
    addTransaction(viewingKey, { raw, status = 'SUCCESS', segments = null, hash } = {}) {
      const id = ++txSeq;
      const ev = {
        __typename: 'RelevantTransaction',
        transaction: {
          id,
          raw,
          hash: hash || crypto.createHash('sha256').update(String(raw)).digest('hex'),
          protocolVersion: 1,
          identifiers: [crypto.randomBytes(8).toString('hex')],
          startIndex: id * 2,
          endIndex: id * 2 + 1,
          fees: { paidFees: '0', estimatedFees: '0' },
          transactionResult: { status, segments },
        },
        collapsedMerkleTree: null,
      };
      keyState(viewingKey).txs.push(ev);
      for (const s of subs) if (s.key === viewingKey) next(s, ev);
      return ev;
    },
    /** Re-sends an already delivered transaction (duplicate delivery). */
    redeliver(viewingKey, ev) {
      for (const s of subs) if (s.key === viewingKey) next(s, ev);
    },
    /** Sets the progress numbers (missing fields allowed) and pushes them to every subscription. */
    setProgress(p) {
      progress = p;
      for (const s of subs) next(s, progressEvent());
    },
    /** Terminates every websocket (an indexer restart from the client's point of view). */
    dropSockets() {
      for (const c of wss.clients) c.terminate();
      subs.clear();
    },
    /** down=true: HTTP answers 503 and websocket upgrades are refused; open sockets are dropped. */
    setDown(v) {
      down = v;
      if (v) api.dropSockets();
    },
    rejectSessions(v) {
      rejectSessions = v;
    },
    /** Subscriptions for this key fail with "unknown or expired session ID" (on=false lifts it). */
    rejectKey(key, on = true) {
      if (on) rejectedKeys.add(key);
      else rejectedKeys.delete(key);
      if (on) for (const s of [...subs]) if (s.key === key) {
        send(s.ws, { id: s.id, type: 'error', payload: [{ message: 'unknown or expired session ID' }] });
        subs.delete(s);
      }
    },
    async close() {
      if (ticker) clearInterval(ticker);
      for (const c of wss.clients) c.terminate();
      await new Promise((r) => wss.close(r));
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
  return api;
}

module.exports = { startMockIndexer };
