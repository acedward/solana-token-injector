'use strict';
// Websocket pass-through (FR-007): every client socket gets its own upstream
// socket; messages are relayed both ways untouched.

const { WebSocketServer, WebSocket } = require('ws');
const log = require('./log');

function createWsProxy(upstreamWsUrl) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (client, req) => {
    if (log.isVerbose()) log.client('WS', req);
    const upstream = new WebSocket(upstreamWsUrl);
    const queue = [];
    upstream.on('open', () => {
      for (const [m, binary] of queue) upstream.send(m, { binary });
      queue.length = 0;
    });
    client.on('message', (m, binary) => {
      if (log.isVerbose()) {
        try {
          const msg = JSON.parse(m.toString());
          log.line(`ws        ${msg.method}  ${JSON.stringify(msg.params ?? []).slice(0, 200)}`);
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

  function close() {
    for (const c of wss.clients) c.terminate();
    wss.close();
  }

  return { wss, acceptUpgrade, close };
}

module.exports = { createWsProxy };
