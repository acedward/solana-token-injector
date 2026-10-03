'use strict';
// Wires the pieces together: config -> TokenState -> RPC handler -> servers.

const path = require('path');
const spl = require('@solana/spl-token');
const log = require('./log');
const { loadConfig } = require('./config');
const { createTokenManager } = require('./tokens/manager');
const { watchConfig } = require('./config-watch');
const { uiAmountString } = require('./amounts');
const { createPlanner } = require('./rpc/planners');
const { createUpstream } = require('./rpc/upstream');
const { createRpcHandler } = require('./rpc/handler');
const { createWsProxy } = require('./ws-proxy');
const { createServers } = require('./server');

// Keys a running process cannot change (a restart applies them).
const RESTART_KEYS = ['upstream', 'upstreamWs', 'host', 'port', 'wsPort', 'publicUrl'];

/**
 * createApp(config, { configPath?, watch?, reloadIntervalMs? })
 * With `watch` and a `configPath`, edits to the file are applied live.
 */
function createApp(config, opts = {}) {
  log.configure(config.log);
  const tokens = createTokenManager({ publicUrl: config.publicUrl, staticSpecs: config.tokens });
  const getState = tokens.getState;
  let current = config;
  let stopWatching = () => {};

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
    for (const [mint, m] of getState().mints) {
      console.log(`  ${m.symbol}  mint ${mint}  (${m.programId === spl.TOKEN_2022_PROGRAM_ID.toBase58() ? 'Token-2022' : 'Token'})`);
      console.log(`        metadata uri ${m.uri}`);
      for (const h of m.holders) console.log(`        token account ${h.address}  balance ${uiAmountString(h.amount, m.decimals)}`);
    }
    console.log(`\nPoint your wallet's custom RPC at http://${host}:${port}\n`);
  }

  /** Applies a reloaded config: static tokens and log level; warns about the rest. */
  function applyReload(next) {
    const needRestart = RESTART_KEYS.filter((k) => JSON.stringify(next[k]) !== JSON.stringify(current[k]));
    log.configure(next.log);
    tokens.setStaticSpecs(next.tokens);
    current = { ...current, log: next.log, tokens: next.tokens };
    log.warn(`config reloaded: ${next.tokens.length} static token(s)${needRestart.length ? `; restart needed to apply: ${needRestart.join(', ')}` : ''}`);
  }

  if (opts.watch && opts.configPath) {
    stopWatching = watchConfig(opts.configPath, {
      load: () => loadConfig(opts.configPath),
      onReload: applyReload,
      onError: (err) => log.warn(`config reload failed, keeping the previous config: ${err.message}`),
      intervalMs: opts.reloadIntervalMs,
    });
  }

  async function close() {
    stopWatching();
    tokens.stop();
    wsProxy.close();
    const closing = [server, wsServer].map((s) => new Promise((r) => (s.listening ? s.close(() => r()) : r())));
    server.closeAllConnections();
    wsServer.closeAllConnections();
    await Promise.all(closing);
  }

  return { config, getState, tokens, applyReload, server, wsServer, listen, banner, close };
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
    app = createApp(config, { configPath, watch: process.env.CONFIG_WATCH !== '0' });
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
