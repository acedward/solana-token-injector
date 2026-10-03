'use strict';
// Configuration: config.json plus environment overrides. Returns a plain,
// normalized object; throws an Error with a user-facing message on problems.

const fs = require('fs');
const path = require('path');
const { staticTokenSpecs } = require('./tokens/static');

function deriveWsUrl(httpUrl) {
  const u = new URL(httpUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  if (u.port) u.port = String(Number(u.port) + 1);
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

/** Normalizes a raw config object (validation included). */
function normalizeConfig(raw, { baseDir = process.cwd() } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config must be a JSON object');
  const upstream = raw.upstream;
  if (!upstream) throw new Error('config.upstream is required (e.g. "https://api.devnet.solana.com")');
  const host = raw.host || '127.0.0.1';
  const port = Number(raw.port || 8899);
  const tokens = staticTokenSpecs(raw.tokens);
  if (tokens.length === 0) throw new Error('config.tokens must list at least one token');
  return {
    upstream,
    upstreamWs: raw.upstreamWs || deriveWsUrl(upstream),
    host,
    port,
    wsPort: Number(raw.wsPort || port + 1), // web3.js expects ws on port+1 when the RPC URL has an explicit port
    publicUrl: (raw.publicUrl || `http://${host}:${port}`).replace(/\/$/, ''),
    log: raw.log === undefined ? true : raw.log,
    tokens,
    baseDir,
  };
}

function loadConfig(configPath) {
  const abs = path.resolve(configPath);
  return normalizeConfig(readConfigFile(abs), { baseDir: path.dirname(abs) });
}

module.exports = { loadConfig, normalizeConfig, readConfigFile, deriveWsUrl };
