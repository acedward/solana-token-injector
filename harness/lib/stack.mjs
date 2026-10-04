// Docker Compose Midnight stack + native solana-test-validator: ports, start, readiness, stop.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import dgram from 'node:dgram';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HARNESS_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REPO_DIR = path.dirname(HARNESS_DIR);
export const COMPOSE_FILE = path.join(HARNESS_DIR, 'compose.yml');
// The service (profile `service`) lives in a second file of the same compose project.
export const SERVICE_COMPOSE_FILE = path.join(HARNESS_DIR, 'compose.service.yml');
export const SERVICE_IMAGE_REPO = 's00056/service';
export const BASE_IMAGE = 'oven/bun:1.3.11';
export const ENV_FILE = path.join(HARNESS_DIR, '.env');
export const STATE_DIR = path.join(HARNESS_DIR, '.state');
export const STATE_FILE = path.join(STATE_DIR, 'run.json');
export const PROJECT_PREFIX = 's00056-';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- ports ----------------------------------------------------------------------------------

const tcpBindable = (port, host) =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen({ port, host, exclusive: true }, () => s.close(() => resolve(true)));
  });

const udpBindable = (port) =>
  new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.once('error', () => {
      s.close();
      resolve(false);
    });
    s.bind(port, '0.0.0.0', () => s.close(() => resolve(true)));
  });

const tcpConnectable = (port) =>
  new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(300, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });

/** True if nothing listens on `port` (TCP on 127.0.0.1 and 0.0.0.0; also UDP when `udp`). */
export async function portFree(port, { udp = false } = {}) {
  if (port < 10000 || port > 65535) return false;
  if (await tcpConnectable(port)) return false;
  if (!(await tcpBindable(port, '127.0.0.1'))) return false;
  if (!(await tcpBindable(port, '0.0.0.0'))) return false;
  if (udp && !(await udpBindable(port))) return false;
  return true;
}

/** Pick `count` consecutive free ports >= 10000 that are not in `taken`. */
export async function pickPorts(count, taken, { udp = false, lo = 10001, hi = 60000 } = {}) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const base = lo + Math.floor(Math.random() * (hi - lo - count));
    let ok = true;
    for (let p = base; p < base + count && ok; p++) {
      if (taken.has(p) || !(await portFree(p, { udp }))) ok = false;
    }
    if (ok) {
      for (let p = base; p < base + count; p++) taken.add(p);
      return base;
    }
  }
  throw new Error(`could not find ${count} consecutive free ports >= 10000`);
}

// ---- docker ---------------------------------------------------------------------------------

export function run(cmd, args, { allowFail = false, quiet = false, env } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env, maxBuffer: 64 << 20 });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${(r.stderr || r.stdout || '').trim().slice(-2000)}`);
  }
  if (!quiet && r.stderr && r.status !== 0) process.stderr.write(r.stderr);
  return r;
}

/** Running containers that look like a Midnight stack (any project), plus any 00056 project. */
export function otherStacks() {
  const r = run('docker', ['ps', '-a', '--format', '{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Label "com.docker.compose.project"}}'], {
    allowFail: true,
  });
  if (r.status !== 0) throw new Error(`docker ps failed: ${r.stderr}`);
  const rows = r.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [name, image, state, project] = l.split('\t');
      return { name, image, state, project };
    });
  const ours = rows.filter((x) => x.project?.startsWith(PROJECT_PREFIX));
  const midnight = rows.filter(
    (x) => x.state === 'running' && /midnight-node|indexer-standalone/.test(x.image) && !x.project?.startsWith(PROJECT_PREFIX),
  );
  return { ours, midnight };
}

/**
 * `docker compose` on the harness project. Both files are always passed, so `down` sees every
 * service; `opts.profile` activates a profile (the service runs under profile `service`).
 */
export const compose = (project, args, opts = {}) =>
  run(
    'docker',
    [
      'compose', '-p', project, '-f', COMPOSE_FILE, '-f', SERVICE_COMPOSE_FILE, '--env-file', ENV_FILE,
      ...(opts.profile ? ['--profile', opts.profile] : []),
      ...args,
    ],
    opts,
  );

export function newProjectName() {
  return PROJECT_PREFIX + randomBytes(4).toString('hex');
}

export function writeEnv(ports, { serviceImage } = {}) {
  const lines = [
    `PORT_NODE_RPC=${ports.node}`,
    `PORT_INDEXER=${ports.indexer}`,
    `PORT_PROOF_SERVER=${ports.proofServer}`,
    `APP_INFRA_SECRET=${randomBytes(32).toString('hex')}`,
  ];
  // compose.service.yml (profile `service`); written in full before the first `compose up`, so the
  // project's configuration never changes between the Midnight `up` and the service's `up`.
  if (ports.service) lines.push(`PORT_SERVICE=${ports.service}`, `PORT_SERVICE_WS=${ports.serviceWs}`);
  if (ports.solanaRpc) lines.push(`PORT_SOLANA_RPC=${ports.solanaRpc}`, `PORT_SOLANA_WS=${ports.solanaWs}`);
  if (serviceImage) lines.push(`SERVICE_IMAGE=${serviceImage}`);
  fs.writeFileSync(ENV_FILE, lines.join('\n') + '\n', { mode: 0o600 });
}

/** Fail early (before starting anything) if a required image or binary is missing. */
export const REQUIRED_IMAGES = [
  'midnightntwrk/midnight-node@sha256:caf93d6f9fb3630c906ef3e714c151655377f3d28f907d17545de1870514da2e',
  'midnightntwrk/indexer-standalone@sha256:5d79f3a20da9ed86236c7f7dc9d93b1beeb0b0c47c9c43a791041322eb80b74e',
  'midnightntwrk/proof-server:9.0.0-rc.6',
];

export const imageExists = (img) => run('docker', ['image', 'inspect', img], { allowFail: true, quiet: true }).status === 0;

export function preflight({ withService = false } = {}) {
  const required = withService ? [...REQUIRED_IMAGES, BASE_IMAGE] : REQUIRED_IMAGES;
  const missing = required.filter((img) => !imageExists(img));
  if (missing.length) throw new Error(`missing local Docker images (this harness never pulls): ${missing.join(', ')}`);
  const v = spawnSync('solana-test-validator', ['--version'], { encoding: 'utf8' });
  if (v.status !== 0) throw new Error(`solana-test-validator not runnable: ${v.error?.message ?? v.stderr}`);
  return { solanaTestValidator: v.stdout.trim() };
}

// ---- readiness ------------------------------------------------------------------------------

async function poll(what, fn, { timeoutMs, intervalMs = 1000, log }) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await fn();
      if (v) {
        log?.(`[up] ${what} ready after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
        return v;
      }
    } catch (e) {
      last = e;
    }
    await sleep(intervalMs);
  }
  throw new Error(`${what} not ready after ${timeoutMs} ms${last ? `: ${last.message}` : ''}`);
}

async function httpOk(url, init) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(3000) });
  return r.status === 200 ? r : null;
}

export async function rpc(url, method, params = []) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(5000),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

export async function waitMidnight(urls, log) {
  const out = {};
  out.block1 = await poll('node (block #1)', () => rpc(urls.nodeHttp, 'chain_getBlockHash', [1]), { timeoutMs: 240_000, log });
  await poll('indexer GET /ready', () => httpOk(urls.indexerHttp.replace(/\/api\/v4\/graphql$/, '/ready')), { timeoutMs: 240_000, log });
  // The indexer follows FINALIZED blocks (~2 behind best, 6 s blocks). Until it has indexed block #1,
  // its latest block is genesis (timestamp 2025-08-05), and wallets value DUST at that block time
  // (zero generated), so fee balancing fails. Wait for a post-genesis block.
  out.indexerBlock = await poll(
    'indexer block height >= 1',
    async () => {
      const r = await fetch(urls.indexerHttp, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ block { height timestamp } }' }),
        signal: AbortSignal.timeout(5000),
      });
      const b = (await r.json())?.data?.block;
      return b && b.height >= 1 ? b : null;
    },
    { timeoutMs: 240_000, log },
  );
  const ps = await poll('proof server GET /version', () => httpOk(urls.proofServer + '/version'), { timeoutMs: 240_000, log });
  out.proofServerVersion = (await ps.text()).trim();
  out.nodeVersion = await rpc(urls.nodeHttp, 'system_version');
  return out;
}

// ---- solana-test-validator (native, Q2) ----------------------------------------------------------

export function startValidator({ rpcPort, faucetPort, gossipPort, dynamicLo, dynamicHi }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's00056-solana-'));
  const ledgerDir = path.join(dir, 'ledger');
  const logFile = path.join(dir, 'validator.log');
  const fd = fs.openSync(logFile, 'a');
  const args = [
    '--ledger', ledgerDir,
    '--reset',
    '--quiet',
    '--bind-address', '127.0.0.1',
    '--rpc-port', String(rpcPort),
    '--faucet-port', String(faucetPort),
    '--gossip-port', String(gossipPort),
    '--dynamic-port-range', `${dynamicLo}-${dynamicHi}`,
  ];
  const child = spawn('solana-test-validator', args, {
    cwd: dir,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  child.on('error', (e) => fs.appendFileSync(logFile, `spawn error: ${e.message}\n`)); // never an uncaught 'error'
  child.unref();
  fs.closeSync(fd);
  if (!child.pid) throw new Error(`could not start solana-test-validator (see ${logFile})`);
  return { pid: child.pid, dir, ledgerDir, logFile, args };
}

export async function waitValidator(rpcUrl, log) {
  await poll(
    'solana-test-validator GET /health',
    async () => {
      const r = await fetch(rpcUrl + '/health', { signal: AbortSignal.timeout(3000) });
      return (await r.text()).trim() === 'ok';
    },
    { timeoutMs: 120_000, log },
  );
  return {
    version: await rpc(rpcUrl, 'getVersion'),
    slot: await rpc(rpcUrl, 'getSlot'),
  };
}

/** Open the PubSub websocket and call `slotSubscribe`; resolves with the subscription id. */
export async function checkSolanaWs(wsUrl) {
  const { WebSocket } = await import('ws');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`no slotSubscribe answer from ${wsUrl}`));
    }, 10_000);
    ws.on('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'slotSubscribe' })));
    ws.on('message', (m) => {
      const j = JSON.parse(m.toString());
      if (j.id === 1) {
        clearTimeout(timer);
        ws.close();
        j.error ? reject(new Error(JSON.stringify(j.error))) : resolve(j.result);
      }
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

export const pidAlive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export async function stopValidator(pid, log) {
  if (!pidAlive(pid)) return true;
  // The validator was started detached: it leads its own process group.
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
  for (let i = 0; i < 30 && pidAlive(pid); i++) await sleep(500);
  if (pidAlive(pid)) {
    log?.(`[down] validator ${pid} still alive after SIGTERM, sending SIGKILL`);
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    for (let i = 0; i < 20 && pidAlive(pid); i++) await sleep(250);
  }
  return !pidAlive(pid);
}

// ---- the service (Dockerfile at the repo root, compose.service.yml) -----------------------------

/**
 * `docker build --pull=false -t <tag> <repo>`: only the local base image, never a pull (Q8).
 * The full build log goes to `logFile`; returns the build time in seconds.
 */
export function buildServiceImage(tag, logFile) {
  const t0 = Date.now();
  const r = spawnSync('docker', ['build', '--pull=false', '--progress=plain', '-t', tag, REPO_DIR], {
    encoding: 'utf8',
    maxBuffer: 256 << 20,
  });
  if (logFile) fs.writeFileSync(logFile, `${r.stdout || ''}${r.stderr || ''}`);
  if (r.status !== 0) {
    throw new Error(`docker build ${tag} failed (${r.status}): ${(r.stderr || r.stdout || '').trim().slice(-2000)}`);
  }
  return Math.round((Date.now() - t0) / 100) / 10;
}

/** Remove one image tag (the per-run service tag). Build cache layers stay. */
export function removeImage(tag) {
  if (!tag || !imageExists(tag)) return true;
  run('docker', ['rmi', tag], { allowFail: true, quiet: true });
  return !imageExists(tag);
}

/** GET <service>/health until HTTP 200 with ok: true (upstream, indexer and decryptor reachable). */
export async function waitService(serviceUrl, log, { timeoutMs = 120_000 } = {}) {
  return poll(
    'service GET /health ok',
    async () => {
      const r = await fetch(serviceUrl + '/health', { signal: AbortSignal.timeout(5000) });
      if (r.status !== 200) return null;
      const j = await r.json();
      return j.ok === true ? j : null;
    },
    { timeoutMs, log },
  );
}

/** The service container of a project (id), or null. */
export function serviceContainer(project) {
  const r = run(
    'docker',
    ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`, '--filter', 'label=com.docker.compose.service=service'],
    { allowFail: true },
  );
  return r.stdout.trim().split('\n').filter(Boolean)[0] ?? null;
}

// ---- state ------------------------------------------------------------------------------------

export const readState = () => (fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : null);

export function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE);
}

export function urlsFor(ports) {
  return {
    nodeWs: `ws://127.0.0.1:${ports.node}`,
    nodeHttp: `http://127.0.0.1:${ports.node}`,
    indexerHttp: `http://127.0.0.1:${ports.indexer}/api/v4/graphql`,
    indexerWs: `ws://127.0.0.1:${ports.indexer}/api/v4/graphql/ws`,
    proofServer: `http://127.0.0.1:${ports.proofServer}`,
    solanaRpc: `http://127.0.0.1:${ports.solanaRpc}`,
    solanaWs: `ws://127.0.0.1:${ports.solanaWs}`,
    service: `http://127.0.0.1:${ports.service}`,
    serviceWs: `ws://127.0.0.1:${ports.serviceWs ?? ports.service + 1}`,
  };
}
