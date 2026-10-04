'use strict';
// Wires the pieces together: config -> TokenState -> RPC handler -> servers.

const path = require('path');
const spl = require('@solana/spl-token');
const log = require('./log');
const { loadConfig } = require('./config');
const { createTokenManager } = require('./tokens/manager');
const { midnightTokenSpecs } = require('./tokens/midnight');
const { registryLookup } = require('./tokens/registry');
const { watchConfig } = require('./config-watch');
const { uiAmountString } = require('./amounts');
const { createPlanner } = require('./rpc/planners');
const { createUpstream } = require('./rpc/upstream');
const { createRpcHandler } = require('./rpc/handler');
const { createWsProxy } = require('./ws-proxy');
const { createServers } = require('./server');
const { DecryptorClient } = require('./midnight/decryptor');
const { RegistryService } = require('./registry/service');
const { AccountService } = require('./accounts/service');
const { loadNightMarket } = require('./accounts/bundle');
const { createApiRoutes } = require('./api');

// Keys a running process cannot change (a restart applies them).
const RESTART_KEYS = ['upstream', 'upstreamWs', 'host', 'port', 'wsPort', 'publicUrl', 'dataDir'];
const MIDNIGHT_RESTART_KEYS = ['networkId', 'indexerHttp', 'indexerWs', 'decryptorBin', 'reconnectMinMs', 'reconnectMaxMs', 'decryptorTimeoutMs', 'syncMinMs', 'syncQuietMs'];

const accountsEnabled = (config) => !!(config.midnight && config.midnight.accounts && config.midnight.accounts.enabled);

/**
 * createApp(config, { configPath?, watch?, reloadIntervalMs?, nightMarket? })
 * With `watch` and a `configPath`, edits to the file are applied live. With the account source
 * enabled (midnight.accounts.enabled), `nightMarket` is the loaded vendored bundle (main loads it).
 */
function createApp(config, opts = {}) {
  log.configure(config.log);
  let current = config;
  let lookup = registryLookup(config.midnight && config.midnight.registry);
  // Registrations (with their per-key totals) are attached by the registry service.
  let registrations = () => [];
  const midnightSpecs = () =>
    config.midnight ? midnightTokenSpecs({ networkId: config.midnight.networkId, registrations: registrations(), lookup }) : [];
  const tokens = createTokenManager({ publicUrl: config.publicUrl, staticSpecs: config.tokens, midnightSpecs });
  const getState = tokens.getState;
  const stopWatching = [];

  // Midnight: decryptor child process + registrations with their watchers.
  let decryptor = null;
  let registry = null;
  let accounts = null;
  if (config.midnight) {
    decryptor = new DecryptorClient({ bin: config.midnight.decryptorBin, timeoutMs: config.midnight.decryptorTimeoutMs }).start();
    registry = new RegistryService({
      midnight: config.midnight,
      dataDir: config.dataDir,
      decryptor,
      onChange: () => tokens.invalidate(),
      onChangeNow: () => tokens.rebuildNow(),
      getLookup: () => lookup,
    });
    try {
      registry.start();
    } catch (err) {
      decryptor.stop();
      throw err;
    }
    registrations = () => registry.tokenInputs();
    // AA 00059: Passport accounts, a second balance source beside the viewing keys.
    if (accountsEnabled(config)) {
      if (!opts.nightMarket) {
        decryptor.stop();
        throw new Error('the account source needs the vendored Night Market bundle (createApp opts.nightMarket)');
      }
      accounts = new AccountService({
        midnight: config.midnight,
        publicUrl: config.publicUrl,
        dataDir: config.dataDir,
        nm: opts.nightMarket,
        onChange: () => tokens.invalidate(),
        onChangeNow: () => tokens.rebuildNow(),
        getLookup: () => lookup,
        getAllInputs: () => registrations(),
      });
      try {
        accounts.start();
      } catch (err) {
        decryptor.stop();
        registry.stop();
        throw err;
      }
      registrations = () => [...registry.tokenInputs(), ...accounts.tokenInputs()];
    }
    tokens.rebuildNow();
  }

  const upstream = createUpstream(config.upstream);
  const handleRpc = createRpcHandler({ plan: createPlanner(getState), upstream });
  const wsProxy = createWsProxy(config.upstreamWs);
  const routes = createApiRoutes({ config, registry, decryptor, upstream, accounts });
  const { server, wsServer } = createServers({ handleRpc, getState, acceptUpgrade: wsProxy.acceptUpgrade, routes });

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
    if (config.midnight) {
      const n = registry.store.list().length;
      console.log(`  Midnight   network ${config.midnight.networkId}, indexer ${config.midnight.indexerHttp}`);
      console.log(`             ${n} registration(s); token registry ${config.midnight.tokenRegistry || '(none: default names)'}`);
      if (accounts) console.log(`             ${accounts.store.list().length} account registration(s) (Passport accounts, ${config.midnight.accounts.pollMs} ms poll)`);
      console.log(`  Web page   ${config.publicUrl}/\n`);
    }
    console.log(`\nPoint your wallet's custom RPC at http://${host}:${port}\n`);
  }

  /**
   * Applies a reloaded config: static tokens, log level and the token registry
   * (names/decimals); warns about keys that need a restart.
   */
  function applyReload(next) {
    const needRestart = RESTART_KEYS.filter((k) => JSON.stringify(next[k]) !== JSON.stringify(current[k]));
    if (!!next.midnight !== !!current.midnight) needRestart.push('midnight');
    else if (next.midnight) {
      for (const k of MIDNIGHT_RESTART_KEYS) if (next.midnight[k] !== current.midnight[k]) needRestart.push(`midnight.${k}`);
    }
    log.configure(next.log);
    if (current.midnight && next.midnight) lookup = registryLookup(next.midnight.registry);
    tokens.setStaticSpecs(next.tokens);
    current = { ...current, log: next.log, tokens: next.tokens, midnight: current.midnight && next.midnight ? { ...current.midnight, registry: next.midnight.registry, tokenRegistry: next.midnight.tokenRegistry } : current.midnight };
    const reg = current.midnight && current.midnight.registry ? `, ${current.midnight.registry.tokens.size} registry token type(s)` : '';
    log.warn(`config reloaded: ${next.tokens.length} static token(s)${reg}${needRestart.length ? `; restart needed to apply: ${needRestart.join(', ')}` : ''}`);
  }

  if (opts.watch && opts.configPath) {
    const watchOpts = {
      load: () => loadConfig(opts.configPath),
      onReload: applyReload,
      onError: (err) => log.warn(`config reload failed, keeping the previous config: ${err.message}`),
      intervalMs: opts.reloadIntervalMs,
    };
    stopWatching.push(watchConfig(opts.configPath, watchOpts));
    // The token registry file is watched too: editing a name needs no restart.
    if (config.midnight && config.midnight.tokenRegistry) stopWatching.push(watchConfig(config.midnight.tokenRegistry, watchOpts));
  }

  async function close() {
    for (const stop of stopWatching) stop();
    if (accounts) await accounts.stop();
    if (registry) await registry.stop();
    if (decryptor) await decryptor.stop();
    tokens.stop();
    wsProxy.close();
    const closing = [server, wsServer].map((s) => new Promise((r) => (s.listening ? s.close(() => r()) : r())));
    server.closeAllConnections();
    wsServer.closeAllConnections();
    await Promise.all(closing);
  }

  return { config, getState, tokens, registry, accounts, decryptor, upstream, applyReload, server, wsServer, listen, banner, close };
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
  let nightMarket = null;
  if (accountsEnabled(config)) {
    try {
      nightMarket = await loadNightMarket();
    } catch (e) {
      console.error(`startup error: ${e.message}`);
      process.exit(1);
    }
  }
  let app;
  try {
    app = createApp(config, { configPath, watch: process.env.CONFIG_WATCH !== '0', nightMarket });
  } catch (e) {
    console.error(`startup error: ${e.message}`);
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
