'use strict';
// Wires the pieces together: config -> TokenState -> RPC handler -> servers.

const path = require('path');
const spl = require('@solana/spl-token');
const log = require('./log');
const { loadConfig } = require('./config');
const { buildTokenState } = require('./tokens/state');
const { uiAmountString } = require('./amounts');
const { createPlanner } = require('./rpc/planners');
const { createUpstream } = require('./rpc/upstream');
const { createRpcHandler } = require('./rpc/handler');
const { createWsProxy } = require('./ws-proxy');
const { createServers } = require('./server');

function createApp(config) {
  log.configure(config.log);
  let state = buildTokenState(config.tokens, { publicUrl: config.publicUrl });
  const getState = () => state;

  const upstream = createUpstream(config.upstream);
  const handleRpc = createRpcHandler({ plan: createPlanner(getState), upstream });
  const wsProxy = createWsProxy(config.upstreamWs);
  const { server, wsServer } = createServers({ handleRpc, getState, acceptUpgrade: wsProxy.acceptUpgrade });

  function listen() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        wsServer.once('error', reject);
        wsServer.listen(config.wsPort, config.host, resolve);
      });
    });
  }

  function banner() {
    const { host, port, wsPort } = config;
    console.log(`\nsolana-token-injector`);
    console.log(`  RPC        http://${host}:${port}   (websockets also on :${wsPort})`);
    console.log(`  upstream   ${config.upstream}`);
    console.log(`  upstream ws ${config.upstreamWs}\n`);
    for (const [mint, m] of state.mints) {
      console.log(`  ${m.symbol}  mint ${mint}  (${m.programId === spl.TOKEN_2022_PROGRAM_ID.toBase58() ? 'Token-2022' : 'Token'})`);
      console.log(`        metadata uri ${m.uri}`);
      for (const h of m.holders) console.log(`        token account ${h.address}  balance ${uiAmountString(h.amount, m.decimals)}`);
    }
    console.log(`\nPoint your wallet's custom RPC at http://${host}:${port}\n`);
  }

  async function close() {
    wsProxy.close();
    await Promise.all([server, wsServer].map((s) => new Promise((r) => (s.listening ? s.close(() => r()) : r()))));
    server.closeAllConnections?.();
    wsServer.closeAllConnections?.();
  }

  return { config, getState, server, wsServer, listen, banner, close };
}

async function main(configArg) {
  const configPath = path.resolve(configArg || process.env.CONFIG || 'config.json');
  let config;
  try {
    config = loadConfig(configPath);
  } catch (e) {
    console.error(`config error: ${e.message}`);
    process.exit(1);
  }
  let app;
  try {
    app = createApp(config);
  } catch (e) {
    console.error(`config error: ${e.message}`);
    process.exit(1);
  }
  await app.listen();
  app.banner();
  const shutdown = () => {
    app.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return app;
}

module.exports = { createApp, main };
