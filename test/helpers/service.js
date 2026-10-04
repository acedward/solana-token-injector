'use strict';
// Spawns the real service (`node proxy.js <config>`) in a temp dir and gives
// tests small clients for its RPC and HTTP API. Everything it creates (temp
// dir, child process) is removed by stop().

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { freePort } = require('./ports');

const ROOT = path.join(__dirname, '..', '..');

// Config env overrides (master plan I-4) must not leak from the developer's shell into tests.
const CONFIG_ENV = ['CONFIG', 'HOST', 'PORT', 'PUBLIC_URL', 'UPSTREAM', 'UPSTREAM_WS', 'DATA_DIR', 'MIDNIGHT_NETWORK_ID',
  'MIDNIGHT_INDEXER_HTTP', 'MIDNIGHT_INDEXER_WS', 'DECRYPTOR_BIN', 'TOKEN_REGISTRY', 'LOG', 'CONFIG_WATCH',
  'ACCOUNTS_ENABLED', 'ACCOUNTS_POLL_MS', 'ACCOUNTS_MAX_CONCURRENT', 'ACCOUNTS_MAX_TTL_S', 'ACCOUNTS_KEY_SET_FILE', 'JOURNEY_REGISTRY'];
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of CONFIG_ENV) delete env[k];
  return { ...env, ...extra };
}

function makeTempDir(prefix = 'sti-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * startService({ config, dir?, env? }) — `config` without `port` gets a random
 * free port pair. Returns { url, port, dir, configPath, output(), rpc, api, stop, kill }.
 */
async function startService({ config, dir, env = {}, readyTimeoutMs = 15000 }) {
  const ownDir = !dir;
  dir = dir || makeTempDir();
  const port = config.port || (await freePort(2));
  const cfg = { log: false, ...config, port };
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));

  let out = '';
  const child = spawn(process.execPath, [path.join(ROOT, 'proxy.js'), configPath], {
    cwd: dir,
    env: cleanEnv(env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`service not ready in ${readyTimeoutMs} ms:\n${out}`)), readyTimeoutMs);
    const onData = () => {
      if (out.includes('Point your wallet')) {
        clearTimeout(t);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    exited.then(({ code }) => {
      clearTimeout(t);
      reject(new Error(`service exited with ${code} before ready:\n${out}`));
    });
  });

  const url = `http://127.0.0.1:${port}`;
  let rpcId = 0;
  async function rpc(method, params = []) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });
    return r.json();
  }
  async function api(method, p, body) {
    const r = await fetch(url + p, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, json, text, headers: r.headers };
  }

  async function kill(signal = 'SIGTERM') {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    const t = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(t);
  }

  async function stop({ keepDir = false } = {}) {
    await kill();
    if (ownDir && !keepDir) fs.rmSync(dir, { recursive: true, force: true });
  }

  return { url, port, dir, configPath, child, exited, output: () => out, rpc, api, kill, stop };
}

/** Polls `fn` until it returns a truthy value (or throws after `timeoutMs`). */
async function waitFor(fn, { timeoutMs = 5000, intervalMs = 50, what = 'condition' } = {}) {
  const until = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

module.exports = { startService, waitFor, makeTempDir, cleanEnv, ROOT };
