'use strict';
// Configuration (master plan I-4, FR-109): config.json plus environment
// overrides (env wins). Returns a plain, normalized object; throws an Error
// with a user-facing message on problems.
//
// Relative paths in the file resolve against the config file's directory;
// relative paths from the environment resolve against the working directory.

const fs = require('fs');
const path = require('path');
const { staticTokenSpecs } = require('./tokens/static');
const { loadTokenRegistry } = require('./tokens/registry');

const REPO_ROOT = path.join(__dirname, '..');
const NETWORK_ID_RE = /^[a-z0-9-]{1,32}$/;

function deriveWsUrl(httpUrl) {
  const u = new URL(httpUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  if (u.port) u.port = String(Number(u.port) + 1);
  return u.toString();
}

/** Indexer GraphQL HTTP URL -> its websocket URL (`…/graphql` -> `…/graphql/ws`). */
function deriveIndexerWs(httpUrl) {
  const u = new URL(httpUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = `${u.pathname.replace(/\/$/, '')}/ws`;
  return u.toString();
}

function readConfigFile(configPath) {
  let text;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch (e) {
    throw new Error(`cannot read ${configPath}: ${e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${configPath} is not valid JSON: ${e.message}`);
  }
}

function parseLog(v) {
  if (v === undefined || v === null) return undefined;
  if (v === true || v === false || v === 'verbose') return v;
  const s = String(v).toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(s)) return false;
  if (['1', 'true', 'on', 'yes'].includes(s)) return true;
  if (s === 'verbose') return 'verbose';
  throw new Error(`log must be true, false or "verbose" (got "${v}")`);
}

function parsePort(v, name) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name} must be a TCP port (got "${v}")`);
  return n;
}

function checkUrl(v, name, protocols) {
  let u;
  try {
    u = new URL(v);
  } catch {
    throw new Error(`${name} must be a URL (got "${v}")`);
  }
  if (!protocols.includes(u.protocol)) throw new Error(`${name} must use ${protocols.join(' or ')} (got "${v}")`);
  return v;
}

const MIDNIGHT_ENV = ['MIDNIGHT_NETWORK_ID', 'MIDNIGHT_INDEXER_HTTP', 'MIDNIGHT_INDEXER_WS', 'DECRYPTOR_BIN', 'TOKEN_REGISTRY'];

function normalizeMidnight(rawM, { env, fromFile, fromEnv }) {
  const m = rawM || {};
  if (typeof m !== 'object' || Array.isArray(m)) throw new Error('config.midnight must be an object');
  const networkId = env.MIDNIGHT_NETWORK_ID || m.networkId;
  if (!networkId) throw new Error('midnight.networkId is required (e.g. "undeployed")');
  if (!NETWORK_ID_RE.test(networkId)) throw new Error(`midnight.networkId "${networkId}" must be lowercase letters, digits or "-"`);

  const indexerHttp = env.MIDNIGHT_INDEXER_HTTP || m.indexerHttp;
  if (!indexerHttp) throw new Error('midnight.indexerHttp is required (e.g. "http://127.0.0.1:8088/api/v4/graphql")');
  checkUrl(indexerHttp, 'midnight.indexerHttp', ['http:', 'https:']);
  const indexerWs = env.MIDNIGHT_INDEXER_WS || m.indexerWs || deriveIndexerWs(indexerHttp);
  checkUrl(indexerWs, 'midnight.indexerWs', ['ws:', 'wss:']);

  const decryptorBin = env.DECRYPTOR_BIN ? fromEnv(env.DECRYPTOR_BIN) : m.decryptorBin ? fromFile(m.decryptorBin) : null;
  if (!decryptorBin) throw new Error('midnight.decryptorBin is required (path to midnight-esk-decrypt)');

  let tokenRegistry = env.TOKEN_REGISTRY ? fromEnv(env.TOKEN_REGISTRY) : m.tokenRegistry ? fromFile(m.tokenRegistry) : null;
  if (!tokenRegistry) {
    const bundled = path.join(REPO_ROOT, 'tokens', `tokens.${networkId}.json`);
    if (fs.existsSync(bundled)) tokenRegistry = bundled;
  }
  const registry = tokenRegistry ? loadTokenRegistry(tokenRegistry, { networkId }) : null;

  const num = (k, def, min) => {
    const v = m[k] === undefined ? def : Number(m[k]);
    if (!Number.isFinite(v) || v < min) throw new Error(`midnight.${k} must be a number >= ${min}`);
    return v;
  };
  const reconnectMinMs = num('reconnectMinMs', 1000, 10);
  const reconnectMaxMs = num('reconnectMaxMs', 30000, reconnectMinMs);
  return {
    networkId,
    indexerHttp,
    indexerWs,
    decryptorBin,
    tokenRegistry,
    registry,
    reconnectMinMs,
    reconnectMaxMs,
    decryptorTimeoutMs: num('decryptorTimeoutMs', 30000, 100),
  };
}

/**
 * Normalizes a raw config object (validation included).
 * opts: { env = {}, baseDir = cwd, cwd = process.cwd() }
 */
function normalizeConfig(raw, { env = {}, baseDir = process.cwd(), cwd = process.cwd() } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config must be a JSON object');
  const fromFile = (p) => path.resolve(baseDir, p);
  const fromEnv = (p) => path.resolve(cwd, p);

  const upstream = env.UPSTREAM || raw.upstream;
  if (!upstream) throw new Error('config.upstream is required (e.g. "https://api.devnet.solana.com")');
  checkUrl(upstream, 'upstream', ['http:', 'https:']);
  const upstreamWs = env.UPSTREAM_WS || raw.upstreamWs || deriveWsUrl(upstream);
  checkUrl(upstreamWs, 'upstreamWs', ['ws:', 'wss:']);

  const host = env.HOST || raw.host || '127.0.0.1';
  const port = parsePort(env.PORT || raw.port || 8899, 'port');
  const wsPort = parsePort(raw.wsPort || port + 1, 'wsPort'); // web3.js expects ws on port+1 when the RPC URL has an explicit port

  const hasMidnight = raw.midnight !== undefined || MIDNIGHT_ENV.some((k) => env[k]);
  const midnight = hasMidnight ? normalizeMidnight(raw.midnight, { env, fromFile, fromEnv }) : null;

  const tokens = staticTokenSpecs(raw.tokens);
  if (tokens.length === 0 && !midnight) throw new Error('config.tokens must list at least one token (or configure "midnight")');

  const dataDir = env.DATA_DIR ? fromEnv(env.DATA_DIR) : fromFile(raw.dataDir || './data');
  const logSetting = parseLog(env.LOG !== undefined && env.LOG !== '' ? env.LOG : raw.log);

  return {
    upstream,
    upstreamWs,
    host,
    port,
    wsPort,
    publicUrl: (env.PUBLIC_URL || raw.publicUrl || `http://${host}:${port}`).replace(/\/$/, ''),
    log: logSetting === undefined ? true : logSetting,
    tokens,
    dataDir,
    midnight,
    baseDir,
  };
}

function loadConfig(configPath, { env = process.env, cwd = process.cwd() } = {}) {
  const abs = path.resolve(configPath);
  return normalizeConfig(readConfigFile(abs), { env, baseDir: path.dirname(abs), cwd });
}

module.exports = { loadConfig, normalizeConfig, readConfigFile, deriveWsUrl, deriveIndexerWs, NETWORK_ID_RE };
