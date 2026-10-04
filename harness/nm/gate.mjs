#!/usr/bin/env node
// AA 00059 gates on Night Market's own localnet (its test/stack/p6 compose file, read only).
//
//   --mode gbalance (default): G-BALANCE. The injector's account-balance tool (tools/account-balance.mjs:
//     the vendored page logic, run by the injector's Node image) must compute each account's per-colour
//     balance exactly as Night Market's page code does (harness/nm/page-balance.ts over
//     test/stack/p6/page.ts), after deposits, a swap and withdrawals; the unfiled change of a partial
//     withdrawal is measured; fixtures for P2 are written (test/fixtures/nm-localnet/).
//   --mode e2e (npm run e2e:accounts): P5, gates A1-A10 and A12. The injector itself runs in its image
//     inside the same compose project (harness/nm/compose.injector.yml) with a native
//     solana-test-validator as its upstream, an SPL mint X and a journey token registry (00057 I-1)
//     naming A's twUSDC as bridged from X; both accounts register through POST /api/accounts and the
//     RPC's amounts are compared with the page's at C1-C6, plus negatives, an indexer outage, a key
//     rotation, names, byte identity, restarts and logs.
//
//   NM_DIR=<night market checkout> node harness/nm/gate.mjs [--mode gbalance|e2e] [--out <dir>]
//
// Env (defaults in brackets): NM_DIR (required; read only), APP_VOLUME [s00059-nm-app] (the Night
// Market tree with node_modules and the light compile: vendor/night-market/build.sh shows how),
// KEYS_DIR [~/.cache/aa-00047/p10i-keys], RELAY_IMAGE [s00059/nm-relay:10b29b1],
// PS_PARAMS [~/.cache/aa-00047/ps-params], PS8_PARAMS [~/.cache/aa-00047/ps-params-rc8] (copied into
// the run dir: the proof servers may write), INDEXER_IMAGE [midnightntwrk/indexer-standalone:4.4.0-rc.1],
// BUN_IMAGE [oven/bun:1.3.11], WITHDRAW_AMOUNT [250000000] (C4, twUSDC base units).
//
// Rules (00057): the stack lock ~/.aa-00057-stack.lock is taken first and released last; one compose
// project `aa00059-nm-<random>` on random free ports >= 10000 bound to 127.0.0.1; nothing is pulled;
// everything (containers, volumes, network, the validator, the run dir, the per-run image tag, the lock)
// is removed in `finally`, also on SIGINT/SIGTERM. Secrets (device seeds, inbox secrets) stay in the
// run dir (0600) and are grepped for in every output before the run ends.

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pickPorts, startValidator, stopValidator, pidAlive, waitValidator } from '../lib/stack.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const require = createRequire(import.meta.url);
const HOME = os.homedir();
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const MODE = opt('mode', 'gbalance');
if (!['gbalance', 'e2e'].includes(MODE)) throw new Error('--mode must be gbalance or e2e');
const E2E = MODE === 'e2e';

const NM_DIR = process.env.NM_DIR;
if (!NM_DIR) throw new Error('NM_DIR is required (a solana-night-market checkout; read only)');
const APP_VOLUME = process.env.APP_VOLUME ?? 's00059-nm-app';
const KEYS_DIR = process.env.KEYS_DIR ?? path.join(HOME, '.cache/aa-00047/p10i-keys');
const RELAY_IMAGE = process.env.RELAY_IMAGE ?? 's00059/nm-relay:10b29b1';
const PS_SRC = process.env.PS_PARAMS ?? path.join(HOME, '.cache/aa-00047/ps-params');
const PS8_SRC = process.env.PS8_PARAMS ?? path.join(HOME, '.cache/aa-00047/ps-params-rc8');
const INDEXER_IMAGE = process.env.INDEXER_IMAGE ?? 'midnightntwrk/indexer-standalone:4.4.0-rc.1';
const BUN_IMAGE = process.env.BUN_IMAGE ?? 'oven/bun:1.3.11';
const NODE_IMAGE = 'midnightntwrk/midnight-node@sha256:caf93d6f9fb3630c906ef3e714c151655377f3d28f907d17545de1870514da2e';
const WITHDRAW_AMOUNT = process.env.WITHDRAW_AMOUNT ?? '250000000';
const KEYS_FINGERPRINT = '21493588f30536e0f409dcf79deea54878f0c2cf6fee601a2359e54a776d5c5e';
const LOCK = path.join(HOME, '.aa-00057-stack.lock');
const RUN_ID = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${Math.floor(Math.random() * 1e6)}`;
const PROJECT = `aa00059-nm-${RUN_ID.slice(-6)}${Math.floor(Math.random() * 100)}`;
const OUT = path.resolve(opt('out', path.join(REPO, '..', '..', 'evidence', '00059-injector-passport-accounts', E2E ? 'p5' : 'g-balance', `run-${RUN_ID}`)));
const FIXTURES = path.join(REPO, 'test', 'fixtures', 'nm-localnet');
const SERVICE_IMAGE = `s00059/service:${E2E ? 'e2e' : 'gb'}-${RUN_ID.toLowerCase()}`;
const COMPOSE_FILE = path.join(NM_DIR, 'test/stack/p6/compose.yml');
const INJECTOR_COMPOSE = path.join(HERE, 'compose.injector.yml');

mkdirSync(OUT, { recursive: true });
const logFile = path.join(OUT, 'gate.log');
const log = (s) => {
  const line = `${new Date().toISOString()} ${s}`;
  process.stdout.write(`${line}\n`);
  writeFileSync(logFile, `${line}\n`, { flag: 'a' });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sh(cmd, args, { allowFail = false, env, input, quiet = false } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...(env ?? {}) }, input, maxBuffer: 1 << 30 });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`${cmd} ${args.slice(0, 6).join(' ')} … exited ${r.status}: ${(r.stderr || r.stdout || '').slice(-2000)}`);
  }
  if (!quiet && r.status !== 0) log(`(allowed failure) ${cmd} ${args.slice(0, 4).join(' ')}: ${(r.stderr || '').trim().slice(-300)}`);
  return r;
}

/** A command whose output streams to a file; resolves with {status, stdout}. */
function run(cmd, args, { env, outFile, capture = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...(env ?? {}) } });
    current.add(child);
    let stdout = '';
    const sink = (d) => {
      if (outFile) writeFileSync(outFile, d, { flag: 'a' });
    };
    child.stdout.on('data', (d) => {
      if (capture) stdout += d;
      sink(d);
    });
    child.stderr.on('data', sink);
    child.on('close', (status) => {
      current.delete(child);
      resolve({ status, stdout });
    });
  });
}
const current = new Set();

const portFree = (port) =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
async function freePorts(n) {
  const out = [];
  while (out.length < n) {
    const p = 10000 + Math.floor(Math.random() * 50000);
    if (!out.includes(p) && (await portFree(p))) out.push(p);
  }
  return out;
}

// ── lock, run dir, teardown ─────────────────────────────────────────────────────────────────────
let holdLock = false;
let runDir = null;
let stackUp = false;
let memTimer = null;
let peakBytes = 0;
let validator = null;
const holderText = `00059 ${E2E ? 'P5 e2e' : 'G-BALANCE'} ${new Date().toISOString()} pid ${process.pid} project ${PROJECT}`;
function takeLock() {
  try {
    mkdirSync(LOCK);
  } catch {
    const holder = existsSync(path.join(LOCK, 'holder')) ? readFileSync(path.join(LOCK, 'holder'), 'utf8').trim() : '(no holder file)';
    log(`the stack lock is held: ${holder}`);
    process.exit(75);
  }
  writeFileSync(path.join(LOCK, 'holder'), `${holderText}\n`);
  holdLock = true;
  log(`stack lock taken: ${holderText}`);
}
function releaseLock() {
  if (!holdLock) return;
  const h = existsSync(path.join(LOCK, 'holder')) ? readFileSync(path.join(LOCK, 'holder'), 'utf8').trim() : '';
  if (h === holderText) {
    rmSync(LOCK, { recursive: true, force: true });
    log('stack lock released');
  } else log(`the lock's holder changed (${h}); not removed`);
  holdLock = false;
}

let ports = null;
const env = () => ({
  COMPOSE_PROJECT_NAME: PROJECT,
  KEYS_DIR,
  RELAY_IMAGE,
  APP_VOLUME,
  BUN_IMAGE,
  PS_PARAMS: path.join(runDir, 'ps-params'),
  PS8_PARAMS: path.join(runDir, 'ps8-params'),
  INDEXER_IMAGE,
  RELAY_KEYS_FINGERPRINT: KEYS_FINGERPRINT,
  DEMO_TOKENS_PATH: 'direct',
  NODE_PORT: String(ports.node),
  INDEXER_PORT: String(ports.indexer),
  RELAY_PORT: String(ports.relay),
  RUN_DIR: runDir,
  ...(E2E
    ? {
        INJECTOR_IMAGE: SERVICE_IMAGE,
        INJECTOR_PORT: String(ports.injector),
        INJECTOR_WS_PORT: String(ports.injector + 1),
        VALIDATOR_RPC_PORT: String(ports.solanaRpc),
        VALIDATOR_WS_PORT: String(ports.solanaRpc + 1),
        JOURNEY_FILE: path.join(runDir, 'journey-tokens.undeployed.json'),
      }
    : {}),
});
const composeFiles = () => ['-f', COMPOSE_FILE, ...(E2E ? ['-f', INJECTOR_COMPOSE] : [])];
const profiles = ['--profile', 'relay', ...(E2E ? ['--profile', 'injector'] : [])];
const dc = (args, opts = {}) => sh('docker', ['compose', ...composeFiles(), '-p', PROJECT, ...args], { env: env(), ...opts });

const report = { mode: MODE, runId: RUN_ID, project: PROJECT, startedAt: new Date().toISOString(), inputs: {}, checkpoints: {}, gates: {}, a: {}, times: {} };
const saveReport = () => writeFileSync(path.join(OUT, 'report.json'), `${JSON.stringify(report, null, 1)}\n`);

let tornDown = false;
async function teardown(reason) {
  if (tornDown) return;
  tornDown = true;
  log(`teardown (${reason})`);
  for (const c of current) c.kill('SIGTERM');
  if (memTimer) clearInterval(memTimer);
  if (sampler) clearInterval(sampler);
  if (stackUp) {
    const svcs = [
      ['relay', 'relay.log', 0],
      ['kernel', 'mock-exchange.log', 0],
      ['proof-server-rc8', 'proof-server-rc8.tail.log', 200],
      ['proof-server', 'proof-server.tail.log', 100],
      ['indexer', 'indexer.tail.log', 300],
      ['node', 'node.tail.log', 200],
      ...(E2E ? [['injector', 'injector.log', 0]] : []),
    ];
    for (const [svc, file, tail] of svcs) {
      const r = dc([...profiles, 'logs', '--no-color', ...(tail ? ['--tail', String(tail)] : []), svc], { allowFail: true, quiet: true });
      writeFileSync(path.join(OUT, file), `${r.stdout ?? ''}${r.stderr ?? ''}`);
    }
    dc([...profiles, 'down', '-v', '--remove-orphans'], { allowFail: true });
  }
  if (validator) {
    await stopValidator(validator.pid, log);
    if (existsSync(validator.logFile)) writeFileSync(path.join(OUT, 'validator.tail.log'), readFileSync(validator.logFile, 'utf8').split('\n').slice(-200).join('\n'));
    rmSync(validator.dir, { recursive: true, force: true });
  }
  sh('docker', ['image', 'rm', SERVICE_IMAGE], { allowFail: true, quiet: true });
  // The secret scan over every output, the logs just collected included (the state is still in the run dir).
  if (runDir && existsSync(path.join(stateDir(), 'state.json'))) {
    try {
      const gx = secretScan();
      report.secretScan = gx;
      const g = E2E ? 'A10-files' : 'GB-X';
      report.gates[g] = gx.hits.length === 0 ? 'PASS' : 'FAIL';
      log(`${g} ${report.gates[g]}: ${JSON.stringify(gx)}`);
    } catch (e) {
      report.gates[E2E ? 'A10-files' : 'GB-X'] = 'FAIL';
      log(`secret scan could not run: ${e.message}`);
    }
  }
  if (runDir) rmSync(runDir, { recursive: true, force: true });
  const left = {
    containers: sh('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${PROJECT}`], { allowFail: true }).stdout.trim(),
    volumes: sh('docker', ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${PROJECT}`], { allowFail: true }).stdout.trim(),
    networks: sh('docker', ['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${PROJECT}`], { allowFail: true }).stdout.trim(),
    image: sh('docker', ['image', 'inspect', SERVICE_IMAGE], { allowFail: true, quiet: true }).status === 0,
    runDir: runDir ? existsSync(runDir) : false,
    validatorAlive: validator ? pidAlive(validator.pid) : false,
    validatorDir: validator ? existsSync(validator.dir) : false,
    portsFree: ports ? await Promise.all(Object.entries(ports).filter(([k]) => !/Dynamic|Faucet|Gossip/.test(k)).map(([, p]) => portFree(p))) : [],
  };
  releaseLock();
  left.lockHeldByUs = existsSync(LOCK) && existsSync(path.join(LOCK, 'holder')) && readFileSync(path.join(LOCK, 'holder'), 'utf8').trim() === holderText;
  report.teardown = left;
  const clean = !left.containers && !left.volumes && !left.networks && !left.image && !left.runDir && !left.validatorAlive && !left.validatorDir && !left.lockHeldByUs && left.portsFree.every(Boolean);
  report.gates[E2E ? 'A12' : 'GB-T'] = clean ? 'PASS' : 'FAIL';
  report.peakMemoryGiB = +(peakBytes / 2 ** 30).toFixed(2);
  report.finishedAt = new Date().toISOString();
  saveReport();
  log(`${E2E ? 'A12' : 'GB-T'} ${clean ? 'PASS' : 'FAIL'}: ${JSON.stringify(left)}`);
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    teardown(sig).finally(() => process.exit(130));
  });
}

// ── memory sampling (every 60 s) ────────────────────────────────────────────────────────────────
const UNITS = { B: 1, KiB: 2 ** 10, MiB: 2 ** 20, GiB: 2 ** 30, KB: 1e3, MB: 1e6, GB: 1e9 };
function sampleMemory() {
  const r = sh('docker', ['stats', '--no-stream', '--format', '{{.Name}} {{.MemUsage}}'], { allowFail: true, quiet: true });
  const lines = (r.stdout || '').split('\n').filter((l) => l.startsWith(PROJECT) || l.startsWith('s00059-gb-'));
  let sum = 0;
  for (const l of lines) {
    const m = /\s([\d.]+)(B|KiB|MiB|GiB|KB|MB|GB)\s*\//.exec(l);
    if (m) sum += Number(m[1]) * UNITS[m[2]];
  }
  peakBytes = Math.max(peakBytes, sum);
  writeFileSync(path.join(OUT, 'mem.log'), `${new Date().toISOString()} total ${(sum / 2 ** 30).toFixed(2)} GiB\n${lines.join('\n')}\n`, { flag: 'a' });
}

// ── the stack (run-local.sh:56-199, re-implemented) ─────────────────────────────────────────────
async function waitFor(what, fn, { tries, everyMs }) {
  for (let i = 0; i < tries; i++) {
    try {
      if (await fn()) return true;
    } catch {
      /* not yet */
    }
    await sleep(everyMs);
  }
  throw new Error(`${what}: not ready after ${(tries * everyMs) / 1000} s`);
}
const indexerHttp = () => `http://127.0.0.1:${ports.indexer}/api/v4/graphql`;
const relayHealthy = async () => {
  const r = await fetch(`http://127.0.0.1:${ports.relay}/health`);
  return /"synced":true/.test(await r.text());
};

const bunRun = (extra, script, { outFile, capture = true, memory = '4g' } = {}) =>
  run('docker', [
    'run', '--rm', '--name', `s00059-gb-${Math.floor(Math.random() * 1e9)}`, '--network', `${PROJECT}_default`, '--memory', memory,
    '-v', `${APP_VOLUME}:/app:ro`, '-v', `${KEYS_DIR}:/app/vendor/passport/contract/contracts/managed:ro`, '-w', '/app',
    ...extra, BUN_IMAGE, ...script,
  ], { outFile, capture });

const stateDir = () => path.join(runDir, 'state');
const flowsEnv = (steps) => [
  '-v', `${runDir}:/run/nm:ro`, '-v', `${stateDir()}:/state`, '-v', `${OUT}:/out`,
  '-e', 'RELAY_URL=http://relay:8080', '-e', 'NETWORK=undeployed', '-e', 'TOKENS_FILE=/run/nm/tokens.json',
  '-e', 'STATE_DIR=/state', '-e', 'OUT=/out', '-e', 'KERNEL_URL=http://kernel:9999',
  '-e', 'INDEXER_URL=http://indexer:8088/api/v4/graphql', '-e', `STEPS=${steps}`, '-e', 'MAKE_LIFETIME=900',
  '-e', 'CAPS=2,3,2,1', '-e', 'THIRD_PARTY_SEED_FILE=/run/nm/third.seed', '-e', 'CAP_WITHDRAWS_PER_DAY=100',
];
async function flows(steps) {
  const t0 = Date.now();
  log(`flows ${steps}`);
  const r = await bunRun(flowsEnv(steps), ['bun', 'test/stack/p6/market-flows.ts'], { outFile: path.join(OUT, 'market-flows.log'), capture: false });
  report.times[`flows ${steps}`] = (Date.now() - t0) / 1000;
  if (r.status !== 0) throw new Error(`market flows FAILED (${steps}); see market-flows.log`);
  log(`flows ${steps}: PASS in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
async function probe(cmdArgs) {
  const r = await bunRun(
    [...flowsEnv(''), '-v', `${HERE}:/probe:ro`],
    ['bun', '/probe/page-balance.ts', ...cmdArgs],
    { outFile: path.join(OUT, 'page-probe.log') },
  );
  if (r.status !== 0) throw new Error(`page probe ${cmdArgs.join(' ')} failed; see page-probe.log`);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}
const readState = () => JSON.parse(readFileSync(path.join(stateDir(), 'state.json'), 'utf8'));
async function tool(who, cp) {
  const st = readState();
  const secretFile = path.join(runDir, 'secrets', `${who}.enc`);
  mkdirSync(path.dirname(secretFile), { recursive: true, mode: 0o700 });
  writeFileSync(secretFile, `${st[who].encSecret}\n`, { mode: 0o600 });
  const recDir = path.join(runDir, 'records');
  mkdirSync(recDir, { recursive: true });
  const t0 = Date.now();
  const r = await run('docker', [
    'run', '--rm', '--name', `s00059-gb-tool-${Math.floor(Math.random() * 1e9)}`, '--network', `${PROJECT}_default`, '--memory', '1g',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '-v', `${path.join(REPO, 'tools')}:/app/tools:ro`, '-v', `${secretFile}:/run/secret:ro`, '-v', `${recDir}:/rec`,
    '--entrypoint', 'node', SERVICE_IMAGE, '/app/tools/account-balance.mjs',
    '--indexer', 'http://indexer:8088/api/v4/graphql', '--network', 'undeployed', '--account', st[who].account,
    '--secret-file', '/run/secret', '--record', `/rec/${cp}-${who}.json`,
  ], { capture: true, outFile: path.join(OUT, 'tool.log') });
  if (r.status !== 0) throw new Error(`the tool failed for ${who} at ${cp}; see tool.log`);
  const out = JSON.parse(r.stdout.trim().split('\n').at(-1));
  out.seconds = (Date.now() - t0) / 1000;
  return { out, record: JSON.parse(readFileSync(path.join(recDir, `${cp}-${who}.json`), 'utf8')) };
}
async function freshProver(label) {
  log(`fresh contract prover (${label}): relay stopped, rc.8 restarted`);
  dc(['--profile', 'relay', 'stop', 'relay']);
  dc(['restart', 'proof-server-rc8']);
  await waitFor('proof-server-rc8', async () => {
    const r = await bunRun([], ['bun', '-e', "const r = await fetch('http://proof-server-rc8:6300/ready').catch(() => null); process.exit(r?.ok ? 0 : 1)"], { memory: '512m' });
    return r.status === 0;
  }, { tries: 60, everyMs: 2000 });
  dc(['--profile', 'relay', 'start', 'relay']);
  await waitFor('relay', relayHealthy, { tries: 100, everyMs: 3000 });
}

// ── comparison (page vs tool) ───────────────────────────────────────────────────────────────────
const totals = (holdings) => Object.fromEntries(holdings.map((h) => [h.colour, h.total]));
function diff(page, tool) {
  const out = {};
  for (const c of new Set([...Object.keys(page), ...Object.keys(tool)])) {
    const d = BigInt(page[c] ?? '0') - BigInt(tool[c] ?? '0');
    if (d !== 0n) out[c] = d.toString(10);
  }
  return out;
}
const fixtures = {};
const lastPage = {};
async function checkpoint(cp, expect = {}) {
  const t0 = Date.now();
  const row = { at: new Date().toISOString() };
  for (const who of ['A', 'B']) {
    const page = await probe(['balances', '--who', who]);
    lastPage[who] = page;
    const { out, record } = await tool(who, cp);
    const pt = totals(page.holdings);
    const tt = totals(out.holdings);
    row[who] = {
      page: { totals: pt, history: page.history, unconfirmedNotes: page.unconfirmedNotes, unconfirmed: page.unconfirmed, unreadable: page.unreadable, notInInbox: Object.fromEntries(page.holdings.map((h) => [h.colour, h.notInInbox])), unshielded: page.unshielded, seconds: page.seconds },
      tool: out,
      pageMinusTool: diff(pt, tt),
    };
    (fixtures[cp] ??= {})[who] = { record, page: { holdings: page.holdings, unshielded: page.unshielded, coins: page.coins, history: page.history } };
  }
  row.seconds = (Date.now() - t0) / 1000;
  const verdicts = expect.verdicts ? expect.verdicts(row) : { equal: ['A', 'B'].every((w) => Object.keys(row[w].pageMinusTool).length === 0) };
  row.verdicts = verdicts;
  row.complete = ['A', 'B'].every((w) => row[w].tool.history.complete && row[w].page.history.complete);
  row.pass = row.complete && Object.values(verdicts).every(Boolean);
  report.checkpoints[cp] = row;
  saveReport();
  log(`${cp}: ${row.pass ? 'PASS' : 'FAIL'} ${JSON.stringify({ verdicts, A: row.A.pageMinusTool, B: row.B.pageMinusTool, A_totals: row.A.page.totals, B_totals: row.B.page.totals, unseen: [row.A.tool.unseenCoins, row.B.tool.unseenCoins] })}`);
  if (!row.pass) throw new Error(`${cp}: the tool differs from the page; see report.json`);
  return row;
}

// ── secrets in outputs ──────────────────────────────────────────────────────────────────────────
function secretsOfRun() {
  const st = readState();
  const out = [st.A.seed, st.B.seed, st.A.encSecret, st.B.encSecret, st.recipientSeed];
  for (const f of ['rotated-A.secret', 'rotated-B.secret']) {
    const p = path.join(stateDir(), f);
    if (existsSync(p)) out.push(readFileSync(p, 'utf8').trim());
  }
  return out.filter(Boolean).map((s) => s.toLowerCase());
}
function secretScan() {
  const secrets = secretsOfRun();
  const hits = [];
  const scan = (file) => {
    const text = readFileSync(file, 'utf8').toLowerCase();
    for (const s of secrets) if (text.includes(s)) hits.push(path.relative(REPO, file));
  };
  const walk = (dir) => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else scan(p);
    }
  };
  walk(OUT);
  if (existsSync(path.join(runDir, 'records'))) walk(path.join(runDir, 'records'));
  if (!E2E && existsSync(FIXTURES)) walk(FIXTURES);
  return { secretsChecked: secrets.length, hits: [...new Set(hits)] };
}

// ── the stack itself ───────────────────────────────────────────────────────────────────────────
async function preflight() {
  const images = [NODE_IMAGE, INDEXER_IMAGE, 'midnightntwrk/proof-server@sha256:38a819eacde273f725551fdf90ca7c31ebf3c0ff145f3ed58ee35f92fb7ce95b', 'midnightntwrk/proof-server:9.0.0-rc.8', BUN_IMAGE, RELAY_IMAGE];
  for (const img of images) {
    const r = sh('docker', ['image', 'inspect', '--format', '{{.Id}}', img], { allowFail: true, quiet: true });
    if (r.status !== 0) throw new Error(`image ${img} is not present locally (never pulled)`);
    report.inputs[img] = r.stdout.trim();
  }
  if (sh('docker', ['volume', 'inspect', APP_VOLUME], { allowFail: true, quiet: true }).status !== 0) throw new Error(`no app volume ${APP_VOLUME}`);
  if (E2E) for (const bin of ['solana-test-validator', 'spl-token', 'solana']) if (sh('which', [bin], { allowFail: true, quiet: true }).status !== 0) throw new Error(`${bin} is not on PATH`);
  report.inputs.nmHead = sh('git', ['-C', NM_DIR, 'rev-parse', 'HEAD']).stdout.trim();
  report.inputs.repoHead = sh('git', ['-C', REPO, 'rev-parse', 'HEAD']).stdout.trim();
  report.inputs.repoDirty = sh('git', ['-C', REPO, 'status', '--porcelain']).stdout.trim().split('\n').filter(Boolean);
  report.inputs.dockerPsBefore = sh('docker', ['ps', '--format', '{{.Names}}']).stdout.trim().split('\n');
  log(`${MODE} ${RUN_ID}: project ${PROJECT}, out ${OUT}`);
}

/** The ports and the run dir (e2e chooses them first, before the validator starts). */
async function prepare() {
  if (!ports) {
    ports = {};
    const taken = new Set();
    for (const k of ['node', 'indexer', 'relay']) ports[k] = await pickPorts(1, taken);
    if (E2E) {
      ports.injector = await pickPorts(2, taken);
      ports.solanaRpc = await pickPorts(2, taken, { udp: true });
      ports.solanaFaucet = await pickPorts(1, taken, { udp: true });
      ports.solanaGossip = await pickPorts(1, taken, { udp: true });
      ports.solanaDynamicLo = await pickPorts(26, taken, { udp: true });
    }
  }
  report.ports = ports;
  if (!runDir) {
    runDir = mkdtempSync(path.join(os.tmpdir(), 's00059-gb-'));
    chmodSync(runDir, 0o700);
    mkdirSync(stateDir(), { mode: 0o700 });
  }
}

async function startStack() {
  await prepare();
  for (const [n, f] of [[1, 'sponsor.seed'], [2, 'batcher.seed'], [3, 'third.seed'], [1, 'funder.seed']]) {
    writeFileSync(path.join(runDir, f), `${n.toString(16).padStart(64, '0')}\n`, { mode: 0o600 });
  }
  cpSync(PS_SRC, path.join(runDir, 'ps-params'), { recursive: true });
  cpSync(PS8_SRC, path.join(runDir, 'ps8-params'), { recursive: true });

  log(`building ${SERVICE_IMAGE}`);
  sh('docker', ['build', '--pull=false', '-q', '-t', SERVICE_IMAGE, REPO]);

  const t0 = Date.now();
  stackUp = true;
  dc(['up', '-d', 'node', 'indexer', 'proof-server', 'proof-server-rc8']);
  memTimer = setInterval(sampleMemory, 60_000);
  sampleMemory();
  await waitFor('indexer', async () => {
    const r = await fetch(indexerHttp(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ block { height } }' }) });
    return /"height"/.test(await r.text());
  }, { tries: 120, everyMs: 3000 });
  report.times.stackUp = (Date.now() - t0) / 1000;
  log(`stack up in ${report.times.stackUp} s (ports ${JSON.stringify(ports)}; ${INDEXER_IMAGE})`);

  const tf = Date.now();
  const faucets = await bunRun(['-v', `${runDir}:/run/nm`, '-e', 'FUNDER_SEED_FILE=/run/nm/sponsor.seed'], ['bun', 'test/stack/b3/deploy-faucets.ts'], { outFile: path.join(OUT, 'deploy-faucets.log') });
  if (faucets.status !== 0) throw new Error('deploy-faucets failed; see deploy-faucets.log');
  writeFileSync(path.join(runDir, 'tokens.json'), faucets.stdout);
  writeFileSync(path.join(OUT, 'tokens.json'), faucets.stdout);
  report.times.faucets = (Date.now() - tf) / 1000;
  log(`faucets deployed in ${report.times.faucets} s`);

  dc(['--profile', 'relay', 'up', '-d', 'relay', 'kernel']);
  await waitFor('relay', relayHealthy, { tries: 100, everyMs: 3000 });
  writeFileSync(path.join(OUT, 'health.json'), await (await fetch(`http://127.0.0.1:${ports.relay}/health`)).text());
  log('relay up');
}

// ── G-BALANCE ──────────────────────────────────────────────────────────────────────────────────
async function gBalance() {
  await flows('open-a,open-b,demo-a,demo-b');
  await checkpoint('c1');
  await flows('make,take');
  await checkpoint('c2');
  await flows('withdraw');
  await checkpoint('c3');
  await freshProver('c4');
  const w = await probe(['withdraw-partial', '--who', 'A', '--amount', WITHDRAW_AMOUNT, '--symbol', 'twUSDC']);
  report.c4Withdrawal = { txId: w.txId, paid: w.paid, change: w.change, changeOutcome: w.changeOutcome, changeMismatch: w.changeMismatch, seconds: w.seconds };
  await checkpoint('c4', { verdicts: c4Verdicts(w) });
  const sec = await probe(['secure', '--who', 'A']);
  report.c5Secure = { txId: sec.txId, coin: sec.coin, seconds: sec.seconds };
  await checkpoint('c5', { verdicts: c5Verdicts });
  await freshProver('c6');
  await flows('make-x,plant');
  await checkpoint('c6', { verdicts: c6Verdicts });
  mkdirSync(FIXTURES, { recursive: true });
  for (const [cp, v] of Object.entries(fixtures)) writeFileSync(path.join(FIXTURES, `${cp}.json`), `${JSON.stringify({ checkpoint: cp, runId: RUN_ID, ...v }, null, 1)}\n`);
  writeFileSync(path.join(FIXTURES, 'tokens.json'), readFileSync(path.join(runDir, 'tokens.json')));
  for (const [i, cp] of ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].entries()) report.gates[`GB${i + 1}`] = report.checkpoints[cp]?.pass ? 'PASS' : 'FAIL';
}
const c4Verdicts = (w) => (row) => ({
  bEqual: Object.keys(row.B.pageMinusTool).length === 0,
  aGapIsTheChange: JSON.stringify(row.A.pageMinusTool) === JSON.stringify({ [w.change.colour]: w.change.value }),
  unseenCoinsIsOne: row.A.tool.unseenCoins === 1,
  pageShowsChangeNotInInbox: row.A.page.notInInbox[w.change.colour] === 1,
});
const c5Verdicts = (row) => ({ equal: ['A', 'B'].every((x) => Object.keys(row[x].pageMinusTool).length === 0), unseenCoinsIsZero: row.A.tool.unseenCoins === 0 });
const c6Verdicts = (row) => ({
  equal: ['A', 'B'].every((x) => Object.keys(row[x].pageMinusTool).length === 0),
  counterfeitUnconfirmed: row.A.tool.unconfirmedNotes >= 1 && row.A.tool.unconfirmedNotes === row.A.page.unconfirmedNotes,
});

// ── e2e: the injector, the validator and the gates ─────────────────────────────────────────────
const { renderRegistrationText } = require('../../src/accounts/message.js');
const { ed25519FromSeed } = require('../../test/helpers/nm-keys.js');
const { deriveKey } = require('../../src/tokens/accounts.js');
const { midnightTokenId } = require('../../src/tokens/midnight.js');
const { PublicKey, Keypair, Connection, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const injUrl = () => `http://127.0.0.1:${ports.injector}`;
const valUrl = () => `http://127.0.0.1:${ports.solanaRpc}`;
const mintOf = (key) => deriveKey(`mint:${midnightTokenId('undeployed', key)}`).toBase58();
const walletOf = (who) => new PublicKey(ed25519FromSeed(Buffer.from(readState()[who].seed, 'hex')).publicKey).toBase58();
const maskSlot = (t) => t.replace(/"slot":\d+/g, '"slot":<slot>');
const sortObj = (o) => Object.fromEntries(Object.entries(o ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const same = (a, b) => JSON.stringify(sortObj(a)) === JSON.stringify(sortObj(b));

async function rpcRaw(url, method, params) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
  return r.text();
}
async function api(method, p, body) {
  const r = await fetch(injUrl() + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, json, text };
}
/** The RPC's Midnight amounts for a wallet: mint -> base units (Token-2022, jsonParsed). */
async function rpcAmounts(wallet) {
  const j = JSON.parse(await rpcRaw(injUrl(), 'getTokenAccountsByOwner', [wallet, { programId: TOKEN_2022_PROGRAM }, { encoding: 'jsonParsed' }]));
  if (j.error) throw new Error(JSON.stringify(j.error));
  return Object.fromEntries(j.result.value.map((a) => [a.account.data.parsed.info.mint, a.account.data.parsed.info.tokenAmount.amount]));
}
/** What the RPC must show for a page view (C4 A: minus the change the page holds locally). */
function expectedRpc(page, { minusLocalChange = false } = {}) {
  const out = {};
  for (const h of page.holdings) out[mintOf(h.colour)] = h.total;
  for (const u of page.unshielded || []) if (BigInt(u.amount) > 0n) out[mintOf(`u:${u.colour}`)] = u.amount;
  if (minusLocalChange) {
    for (const c of page.coins.filter((x) => x.origin === 'change' && !x.inInbox && !x.spent && x.mtIndex !== null)) {
      const m = mintOf(c.colour);
      const v = BigInt(out[m]) - BigInt(c.value);
      if (v === 0n) delete out[m];
      else out[m] = v.toString(10);
    }
  }
  return out;
}

/** An I-4 body for `who`'s wallet (overrides for the negatives). */
function regBody(who, o = {}) {
  const st = readState();
  const solanaAddress = o.solanaAddress ?? walletOf(who);
  const accountAddress = o.accountAddress ?? st[who].account;
  const message =
    o.message ??
    renderRegistrationText({
      origin: o.origin ?? injUrl(),
      networkId: o.networkId ?? 'undeployed',
      solanaAddress,
      accountAddress: /^[0-9a-f]{64}$/.test(accountAddress) ? accountAddress : st[who].account,
      expiresAt: o.expiresAt ?? Math.floor(Date.now() / 1000) + 300,
    });
  const signer = ed25519FromSeed(Buffer.from(st[o.signer ?? who].seed, 'hex'));
  return {
    solanaAddress,
    accountAddress,
    accountViewingKey: o.viewingKey ?? st[who].encSecret,
    message,
    signature: Buffer.from(signer.sign(Buffer.from(message, 'utf8'))).toString('hex'),
  };
}
const regIds = {};
const viewOf = async (who) => (await api('GET', `/api/accounts/${regIds[who]}`)).json;
const accountsFileHash = () => {
  const id = dc([...profiles, 'ps', '-q', 'injector']).stdout.trim();
  const r = sh('docker', ['exec', id, 'sha256sum', '/data/accounts.json'], { allowFail: true, quiet: true });
  return r.status === 0 ? r.stdout.split(' ')[0] : null;
};

/** Gate bookkeeping: a gate fails the run at once (stop, record, report: the coordinator's rule). */
async function gate(name, what, fn) {
  const t0 = Date.now();
  const g = { what };
  report.a[name] = g;
  log(`${name}: ${what}`);
  try {
    const ok = await fn(g);
    g.seconds = (Date.now() - t0) / 1000;
    report.gates[name] = ok ? 'PASS' : 'FAIL';
  } catch (e) {
    g.error = String(e?.stack ?? e);
    g.seconds = (Date.now() - t0) / 1000;
    report.gates[name] = 'FAIL';
  }
  saveReport();
  log(`${name} ${report.gates[name]} (${g.seconds.toFixed(1)} s)${report.gates[name] === 'FAIL' ? `: ${JSON.stringify(g).slice(0, 1500)}` : ''}`);
  if (report.gates[name] !== 'PASS') throw new Error(`${name} FAILED`);
}

/** Polls the RPC until it shows `want` for the wallet (or the deadline); returns {ok, ms, got}. */
async function rpcUntil(wallet, want, timeoutMs = 90_000) {
  const t0 = Date.now();
  let got = null;
  for (;;) {
    try {
      got = await rpcAmounts(wallet);
      if (same(got, want)) return { ok: true, ms: Date.now() - t0, got };
    } catch (e) {
      got = { error: e.message };
    }
    if (Date.now() - t0 > timeoutMs) return { ok: false, ms: Date.now() - t0, got, want };
    await sleep(1000);
  }
}
async function statusUntil(who, pred, timeoutMs) {
  const t0 = Date.now();
  let v = null;
  for (;;) {
    v = await viewOf(who).catch(() => null);
    if (v && pred(v)) return { ok: true, ms: Date.now() - t0, status: v.status };
    if (Date.now() - t0 > timeoutMs) return { ok: false, ms: Date.now() - t0, status: v?.status, error: v?.error };
    await sleep(1000);
  }
}

// A3: the RPC sampled every second (the time each wallet's answer first takes a new value).
let sampler = null;
const samples = [];
function startSampler() {
  const wallets = { A: walletOf('A'), B: walletOf('B') };
  sampler = setInterval(async () => {
    const t = Date.now();
    const s = { t };
    for (const [w, a] of Object.entries(wallets)) s[w] = await rpcAmounts(a).catch(() => null);
    samples.push(s);
  }, 1000);
}
async function newestActionTime(account) {
  const q = `query { contract(address: "${account}") { actions(limit: 1) { transaction { hash block { height timestamp } } } } }`;
  const r = await fetch(indexerHttp(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q }) });
  const tx = (await r.json()).data.contract.actions[0].transaction;
  const ts = Number(tx.block.timestamp);
  return { hash: tx.hash, height: tx.block.height, ms: ts < 1e11 ? ts * 1000 : ts };
}
function firstSeen(who, want, afterMs) {
  const s = samples.find((x) => x.t >= afterMs && x[who] && same(x[who], want));
  return s ? s.t : null;
}

async function a2(cp, { minusChangeFor = null } = {}) {
  const res = {};
  for (const who of ['A', 'B']) {
    const want = expectedRpc(lastPage[who], { minusLocalChange: minusChangeFor === who });
    res[who] = await rpcUntil(walletOf(who), want);
  }
  report.a.A2 ??= { what: 'the RPC amounts equal the page\'s holdings at C1-C6 (C4 A: minus the unfiled change)', checkpoints: {} };
  report.a.A2.checkpoints[cp] = res;
  const ok = res.A.ok && res.B.ok;
  log(`A2 ${cp}: ${ok ? 'PASS' : 'FAIL'} ${JSON.stringify({ A: res.A.ms, B: res.B.ms, ...(ok ? {} : { res }) })}`);
  if (!ok) {
    report.gates.A2 = 'FAIL';
    saveReport();
    throw new Error(`A2 FAILED at ${cp}`);
  }
}

async function e2e() {
  // The validator, the SPL mint X (classic Token program, 6 decimals).
  const tv = Date.now();
  validator = startValidator({ rpcPort: ports.solanaRpc, faucetPort: ports.solanaFaucet, gossipPort: ports.solanaGossip, dynamicLo: ports.solanaDynamicLo, dynamicHi: ports.solanaDynamicLo + 25 });
  const vinfo = await waitValidator(valUrl(), (s) => log(s));
  const genesis = JSON.parse(await rpcRaw(valUrl(), 'getGenesisHash', [])).result;
  report.validator = { version: vinfo.version, genesis, seconds: (Date.now() - tv) / 1000 };
  const splDir = path.join(runDir, 'spl');
  mkdirSync(splDir, { mode: 0o700 });
  const payer = Keypair.generate();
  writeFileSync(path.join(splDir, 'payer.json'), JSON.stringify([...payer.secretKey]), { mode: 0o600 });
  writeFileSync(path.join(splDir, 'cli.yml'), `json_rpc_url: "${valUrl()}"\nwebsocket_url: "ws://127.0.0.1:${ports.solanaRpc + 1}"\nkeypair_path: ${path.join(splDir, 'payer.json')}\ncommitment: confirmed\n`);
  // The airdrop, confirmed over HTTP (getSignatureStatuses), not the PubSub websocket.
  const conn = new Connection(valUrl(), 'confirmed');
  const sig = await conn.requestAirdrop(payer.publicKey, 10 * LAMPORTS_PER_SOL);
  await waitFor('airdrop', async () => {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    return st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized');
  }, { tries: 60, everyMs: 1000 });
  const spl = (...args) => sh('spl-token', ['-C', path.join(splDir, 'cli.yml'), '--url', valUrl(), ...args]);
  const created = JSON.parse(spl('create-token', '--decimals', '6', '--output', 'json').stdout);
  const mintX = created.commandOutput?.address ?? created.address;
  report.mintX = mintX;
  log(`validator ${genesis}; SPL mint X ${mintX} (6 decimals)`);

  await startStack();

  // The journey token registry (00057 I-1): A's demo-token colour (twUSDC) as bridged from X.
  const tokens = JSON.parse(readFileSync(path.join(runDir, 'tokens.json'), 'utf8')).tokens;
  const usdc = tokens.find((t) => t.symbol === 'twUSDC');
  const journey = {
    midnightNetwork: 'undeployed',
    solanaGenesisHash: genesis,
    tokens: [{ colour: usdc.midnightColour, splMint: mintX, bridgeContract: usdc.contract, bridgeProgram: TOKEN_PROGRAM, bridgeApi: 'http://127.0.0.1:1', name: 'Test X', symbol: 'X', decimals: 6 }],
  };
  writeFileSync(path.join(runDir, 'journey-tokens.undeployed.json'), JSON.stringify(journey, null, 1));
  writeFileSync(path.join(OUT, 'journey-tokens.undeployed.json'), JSON.stringify(journey, null, 1));
  report.journey = { colour: usdc.midnightColour, splMint: mintX };

  // The injector in its image, in the same compose project.
  const ti = Date.now();
  dc([...profiles, 'up', '-d', '--no-deps', 'injector']);
  await waitFor('injector', async () => (await fetch(`${injUrl()}/health`)).ok, { tries: 60, everyMs: 2000 });
  report.times.injectorUp = (Date.now() - ti) / 1000;
  log(`injector up in ${report.times.injectorUp} s on :${ports.injector}`);

  // C1 and A1: the accounts open and get their demo tokens, then register through the injector.
  await flows('open-a,open-b,demo-a,demo-b');
  await gate('A1', 'A and B register through POST /api/accounts (201), again (200, the same id)', async (g) => {
    for (const who of ['A', 'B']) {
      const r1 = await api('POST', '/api/accounts', regBody(who));
      const r2 = await api('POST', '/api/accounts', regBody(who));
      g[who] = { first: r1.status, second: r2.status, id: r1.json?.id, sameId: r1.json?.id === r2.json?.id, code: r1.json?.code ?? r2.json?.code };
      regIds[who] = r1.json?.id;
    }
    return ['A', 'B'].every((w) => g[w].first === 201 && g[w].second === 200 && g[w].sameId);
  });
  // A's real X: 100 X in its associated token account.
  const ata = JSON.parse(spl('create-account', mintX, '--owner', walletOf('A'), '--fee-payer', path.join(splDir, 'payer.json'), '--output', 'json').stdout);
  report.ataX = ata.commandOutput?.address ?? ata.address ?? null;
  spl('mint', mintX, '100', '--recipient-owner', walletOf('A'));
  await checkpoint('c1');
  await a2('c1');
  startSampler();

  // C2 (and A3 for the take).
  const tTake = Date.now();
  await flows('make,take');
  await checkpoint('c2');
  await a2('c2');
  const takeTx = await newestActionTime(readState().B.account);
  const a3 = { take: { tx: takeTx } };
  for (const who of ['A', 'B']) {
    const seen = firstSeen(who, expectedRpc(lastPage[who]), tTake);
    a3.take[who] = { firstSeenMs: seen, latencyS: seen === null ? null : (seen - takeTx.ms) / 1000 };
  }
  report.a.A3 = { what: 'from the block of the take (C2) and of the change filing (C5) to the RPC showing it: <= 60 s', ...a3 };
  saveReport();

  // C3.
  await flows('withdraw');
  await checkpoint('c3');
  await a2('c3');

  // C4: the unfiled change; the view says unseenCoins 1.
  await freshProver('c4');
  const w = await probe(['withdraw-partial', '--who', 'A', '--amount', WITHDRAW_AMOUNT, '--symbol', 'twUSDC']);
  report.c4Withdrawal = { txId: w.txId, paid: w.paid, change: w.change, changeOutcome: w.changeOutcome, seconds: w.seconds };
  await checkpoint('c4', { verdicts: c4Verdicts(w) });
  await a2('c4', { minusChangeFor: 'A' });
  const v4 = await statusUntil('A', (v) => v.unseenCoins === 1 && v.status === 'synced', 60_000);
  report.a.A2.c4UnseenCoins = v4;
  if (!v4.ok) throw new Error(`A2 FAILED: the view does not say unseenCoins 1 at C4 (${JSON.stringify(v4)})`);

  // C5 (and A3 for the filing).
  const tFile = Date.now();
  const sec = await probe(['secure', '--who', 'A']);
  report.c5Secure = { txId: sec.txId, seconds: sec.seconds };
  await checkpoint('c5', { verdicts: c5Verdicts });
  await a2('c5');
  const fileTx = await newestActionTime(readState().A.account);
  const seenFile = firstSeen('A', expectedRpc(lastPage.A), tFile);
  report.a.A3.filing = { tx: fileTx, A: { firstSeenMs: seenFile, latencyS: seenFile === null ? null : (seenFile - fileTx.ms) / 1000 } };
  const lat = [report.a.A3.take.A.latencyS, report.a.A3.take.B.latencyS, report.a.A3.filing.A.latencyS];
  report.gates.A3 = lat.every((x) => x !== null && x <= 60) ? 'PASS' : 'FAIL';
  log(`A3 ${report.gates.A3}: latencies ${JSON.stringify(lat)} s`);
  saveReport();
  if (report.gates.A3 !== 'PASS') throw new Error('A3 FAILED');

  // C6.
  await freshProver('c6');
  await flows('make-x,plant');
  await checkpoint('c6', { verdicts: c6Verdicts });
  await a2('c6');
  clearInterval(sampler);
  sampler = null;
  report.gates.A2 = 'PASS';
  const pageAfterC6 = { A: lastPage.A, B: lastPage.B };

  // A4: negatives on the live chain, each with its code and nothing stored.
  await gate('A4', 'negatives on the live chain: each refused with its code; the count and accounts.json unchanged', async (g) => {
    const st = readState();
    const faucet = tokens[0].contract;
    const cases = [
      ['forged signature', regBody('A', { signer: 'B' }), 401, 'bad-signature'],
      ['B\'s key for A\'s account', regBody('A', { solanaAddress: walletOf('B'), signer: 'B' }), 403, 'not-a-device'],
      ['malformed account address', regBody('A', { accountAddress: `${st.A.account.slice(1)}z` }), 400, 'bad-account-address'],
      ['another network in the text', regBody('A', { networkId: 'stagenet' }), 400, 'wrong-network'],
      ['another origin', regBody('A', { origin: 'http://127.0.0.1:1' }), 400, 'wrong-origin'],
      ['expired', regBody('A', { expiresAt: Math.floor(Date.now() / 1000) - 10 }), 400, 'expired'],
      ['B\'s secret for A\'s account', regBody('A', { viewingKey: st.B.encSecret }), 403, 'enc-key-mismatch'],
      ['a random 64-hex address', regBody('A', { accountAddress: [...Array(64)].map(() => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('') }), 404, 'account-not-found'],
      ['the faucet contract', regBody('A', { accountAddress: faucet }), 403, 'not-passport-account'],
    ];
    const before = { count: (await api('GET', '/api/accounts')).json.length, hash: accountsFileHash() };
    g.before = before;
    g.cases = [];
    let ok = true;
    for (const [name, body, status, code] of cases) {
      const r = await api('POST', '/api/accounts', body);
      const after = { count: (await api('GET', '/api/accounts')).json.length, hash: accountsFileHash() };
      const pass = r.status === status && r.json?.code === code && after.count === before.count && after.hash === before.hash;
      g.cases.push({ name, status: r.status, code: r.json?.code, detail: r.json?.detail, pass });
      ok &&= pass;
    }
    return ok && before.count === 2 && !!before.hash;
  });

  // A7: names through the spl-token CLI pointed at the injector.
  await gate('A7', 'spl-token: the real X (100) and "Test X (Midnight)" with A\'s twUSDC amount; display shows the I-4b metadata; the real X account bytes are the validator\'s', async (g) => {
    const cliDir = path.join(runDir, 'spl-inj');
    mkdirSync(cliDir, { mode: 0o700 });
    writeFileSync(path.join(cliDir, 'cli.yml'), `json_rpc_url: "${injUrl()}"\nwebsocket_url: "ws://127.0.0.1:${ports.injector + 1}"\nkeypair_path: ${path.join(splDir, 'payer.json')}\ncommitment: confirmed\n`);
    const cli = (...args) => sh('spl-token', ['-C', path.join(cliDir, 'cli.yml'), '--url', injUrl(), ...args], { allowFail: true });
    const classic = JSON.parse(cli('accounts', '--owner', walletOf('A'), '--output', 'json').stdout || '{}');
    const t22 = JSON.parse(cli('accounts', '--owner', walletOf('A'), '--program-2022', '--output', 'json').stdout || '{}');
    const synth = mintOf(usdc.midnightColour);
    const listX = (classic.accounts || []).find((a) => a.mint === mintX);
    const listSynth = (t22.accounts || []).find((a) => a.mint === synth);
    const display = JSON.parse(cli('display', synth, '--output', 'json').stdout || '{}');
    const pageUsdc = pageAfterC6.A.holdings.find((h) => h.colour === usdc.midnightColour)?.total;
    g.listX = listX ? { amount: listX.tokenAmount?.amount, uiAmountString: listX.tokenAmount?.uiAmountString } : null;
    g.listSynth = listSynth ? { amount: listSynth.tokenAmount?.amount } : null;
    g.pageUsdc = pageUsdc;
    const meta = display.commandOutput ?? display;
    const metaText = JSON.stringify(meta);
    g.display = { name: metaText.match(/"name":"([^"]*)"/)?.[1], symbol: metaText.match(/"symbol":"([^"]*)"/)?.[1], decimals: metaText.match(/"decimals":(\d+)/)?.[1] };
    // The real X token account: the injector's answer equals the validator's (bytes; slot masked when it moved).
    const ataAddr = listX?.address;
    let bytesEqual = false;
    for (let i = 0; i < 10 && ataAddr; i++) {
      const [a, b] = await Promise.all([rpcRaw(injUrl(), 'getAccountInfo', [ataAddr, { encoding: 'base64' }]), rpcRaw(valUrl(), 'getAccountInfo', [ataAddr, { encoding: 'base64' }])]);
      if (a === b) {
        bytesEqual = true;
        break;
      }
      g.lastMasked = maskSlot(a) === maskSlot(b);
    }
    g.realXBytesEqual = bytesEqual;
    return g.listX?.amount === '100000000' && g.listSynth?.amount === pageUsdc && g.display.name === 'Test X (Midnight)' && g.display.symbol === 'mnX' && Number(g.display.decimals) === 6 && bytesEqual;
  });

  // A8: an unregistered address: byte-identical answers.
  await gate('A8', 'unregistered address: getTokenAccountsByOwner (both programs), getBalance and getAccountInfo byte-identical to the validator\'s', async (g) => {
    const addr = Keypair.generate().publicKey.toBase58();
    g.address = addr;
    const calls = [
      ['getTokenAccountsByOwner', [addr, { programId: TOKEN_PROGRAM }, { encoding: 'jsonParsed' }]],
      ['getTokenAccountsByOwner', [addr, { programId: TOKEN_2022_PROGRAM }, { encoding: 'jsonParsed' }]],
      ['getBalance', [addr]],
      ['getAccountInfo', [addr, { encoding: 'base64' }]],
    ];
    g.calls = [];
    for (const [m, p] of calls) {
      let exact = false;
      let masked = true;
      let n = 0;
      for (; n < 10 && !exact; n++) {
        const [a, b] = await Promise.all([rpcRaw(injUrl(), m, p), rpcRaw(valUrl(), m, p)]);
        exact = a === b;
        masked &&= maskSlot(a) === maskSlot(b);
      }
      g.calls.push({ method: m, program: p[1]?.programId ?? null, exact, maskedEqualEveryTry: masked, attempts: n });
    }
    return g.calls.every((c) => c.exact && c.maskedEqualEveryTry);
  });

  // A5: an indexer outage.
  await gate('A5', 'indexer stopped: a registration gets 503 indexer-unavailable, A\'s RPC answer is unchanged and its status error; restarted: synced within 120 s, amounts = the page\'s', async (g) => {
    const before = await rpcAmounts(walletOf('A'));
    dc(['stop', 'indexer']);
    const r = await api('POST', '/api/accounts', regBody('A'));
    g.registration = { status: r.status, code: r.json?.code };
    g.error = await statusUntil('A', (v) => v.status === 'error', 60_000);
    const during = await rpcAmounts(walletOf('A'));
    g.unchanged = same(during, before);
    dc(['start', 'indexer']);
    g.synced = { A: await statusUntil('A', (v) => v.status === 'synced', 120_000), B: await statusUntil('B', (v) => v.status === 'synced', 120_000) };
    const pa = await probe(['balances', '--who', 'A']);
    const pb = await probe(['balances', '--who', 'B']);
    lastPage.A = pa;
    lastPage.B = pb;
    g.after = { A: await rpcUntil(walletOf('A'), expectedRpc(pa), 30_000), B: await rpcUntil(walletOf('B'), expectedRpc(pb), 30_000) };
    return r.status === 503 && r.json?.code === 'indexer-unavailable' && g.error.ok && g.unchanged && g.synced.A.ok && g.synced.B.ok && g.after.A.ok && g.after.B.ok;
  });

  // A6: a key rotation to a key the injector does not hold, the re-registration, the restore, a cancel.
  await gate('A6', 'stale key: rotation to K2 -> stale-key within 60 s, amounts unchanged; re-registered with K2 -> synced, amounts = the page\'s; restored to the opening key -> synced without re-registering; a same-key cancel never stale', async (g) => {
    await freshProver('a6');
    const before = await rpcAmounts(walletOf('A'));
    const rot = await probe(['rotate', '--who', 'A', '--to', 'fresh']);
    g.rotate = { txId: rot.txId, chainShowsNewKey: rot.chainShowsNewKey, seconds: rot.seconds };
    const tRot = Date.now();
    g.stale = await statusUntil('A', (v) => v.status === 'stale-key', 60_000);
    g.staleWithinS = (Date.now() - tRot) / 1000;
    g.amountsFrozen = same(await rpcAmounts(walletOf('A')), before);
    const k2 = readFileSync(path.join(stateDir(), 'rotated-A.secret'), 'utf8').trim();
    const rr = await api('POST', '/api/accounts', regBody('A', { viewingKey: k2 }));
    g.reregister = { status: rr.status, replacedKey: rr.json?.replacedKey, heldKeys: rr.json?.heldKeys, code: rr.json?.code };
    g.syncedK2 = await statusUntil('A', (v) => v.status === 'synced', 60_000);
    const pa = await probe(['balances', '--who', 'A']);
    lastPage.A = pa;
    g.amountsK2 = await rpcUntil(walletOf('A'), expectedRpc(pa), 30_000);
    const back = await probe(['rotate', '--who', 'A', '--to', 'opening']);
    g.restore = { txId: back.txId, chainShowsNewKey: back.chainShowsNewKey, seconds: back.seconds };
    g.syncedOpening = await statusUntil('A', (v) => v.status === 'synced' && v.heldKeys === 2, 60_000);
    // A same-key rotation ("Cancel all open offers"): the status is sampled every 2 s throughout.
    const seen = new Set();
    let watching = true;
    const watcher = (async () => {
      while (watching) {
        const v = await viewOf('A').catch(() => null);
        if (v) seen.add(v.status);
        await sleep(2000);
      }
    })();
    const c = await probe(['cancel', '--who', 'A']);
    await sleep(15_000);
    watching = false;
    await watcher;
    g.cancel = { txId: c.txId, keyUnchanged: c.keyUnchanged, authNonceBefore: c.authNonceBefore, authNonce: c.authNonce, statusesSeen: [...seen] };
    const pa2 = await probe(['balances', '--who', 'A']);
    lastPage.A = pa2;
    g.final = await rpcUntil(walletOf('A'), expectedRpc(pa2), 30_000);
    return (
      g.rotate.chainShowsNewKey && g.stale.ok && g.staleWithinS <= 60 && g.amountsFrozen &&
      rr.status === 200 && rr.json?.replacedKey === true && rr.json?.heldKeys === 2 && g.syncedK2.ok && g.amountsK2.ok &&
      g.restore.chainShowsNewKey && g.syncedOpening.ok &&
      c.keyUnchanged && !seen.has('stale-key') && g.final.ok
    );
  });

  // A9: restarts.
  await gate('A9', 'injector restart: the same ids, the amounts rebuilt; with the indexer stopped across a restart, the persisted amounts are served', async (g) => {
    const ids = (await api('GET', '/api/accounts')).json.map((v) => v.id).sort();
    const amounts = { A: await rpcAmounts(walletOf('A')), B: await rpcAmounts(walletOf('B')) };
    dc([...profiles, 'restart', 'injector']);
    await waitFor('injector', async () => (await fetch(`${injUrl()}/health`)).ok, { tries: 60, everyMs: 2000 });
    g.idsSame = same(Object.fromEntries((await api('GET', '/api/accounts')).json.map((v) => [v.id, 1])), Object.fromEntries(ids.map((i) => [i, 1])));
    g.rebuilt = { A: await rpcUntil(walletOf('A'), amounts.A, 60_000), B: await rpcUntil(walletOf('B'), amounts.B, 60_000) };
    g.syncedAfterRestart = await statusUntil('A', (v) => v.status === 'synced', 60_000);
    await sleep(2000); // the debounced save of the amounts (1 s)
    dc(['stop', 'indexer']);
    dc([...profiles, 'restart', 'injector']);
    await waitFor('injector', async () => (await fetch(`${injUrl()}/health`)).ok, { tries: 60, everyMs: 2000 });
    g.persisted = { A: same(await rpcAmounts(walletOf('A')), amounts.A), B: same(await rpcAmounts(walletOf('B')), amounts.B) };
    g.errorStatus = await statusUntil('A', (v) => v.status === 'error', 60_000);
    dc(['start', 'indexer']);
    g.syncedAgain = await statusUntil('A', (v) => v.status === 'synced', 120_000);
    return g.idsSame && g.rebuilt.A.ok && g.rebuilt.B.ok && g.syncedAfterRestart.ok && g.persisted.A && g.persisted.B && g.errorStatus.ok && g.syncedAgain.ok;
  });

  // A10: the injector's log holds no X25519 secret and no device seed.
  await gate('A10', 'the injector\'s log holds no X25519 secret (the opening keys, K2) and no device seed', async (g) => {
    const logs = dc([...profiles, 'logs', '--no-color', 'injector'], { allowFail: true, quiet: true }).stdout.toLowerCase();
    const secrets = secretsOfRun();
    g.secretsChecked = secrets.length;
    g.logBytes = logs.length;
    g.hits = secrets.filter((s) => logs.includes(s)).length;
    g.registrationLines = (logs.match(/account registration [0-9a-f]{16}/g) || []).length;
    return g.hits === 0 && g.logBytes > 0 && g.registrationLines >= 2;
  });
}

// ── main ───────────────────────────────────────────────────────────────────────────────────────
let failed = false;
try {
  await preflight();
  takeLock();
  await prepare();
  if (E2E) await e2e();
  else {
    await startStack();
    await gBalance();
  }
} catch (e) {
  failed = true;
  report.error = String(e?.stack ?? e);
  log(`FAILED: ${e?.message ?? e}`);
} finally {
  await teardown(failed ? 'failure' : 'done');
}
const need = E2E ? ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A10-files', 'A12'] : ['GB1', 'GB2', 'GB3', 'GB4', 'GB5', 'GB6', 'GB-X', 'GB-T'];
const allPass = !failed && need.every((g) => report.gates[g] === 'PASS');
report.verdict = allPass ? 'PASS' : 'FAIL';
saveReport();
log(`${E2E ? 'P5 e2e' : 'G-BALANCE'} ${allPass ? 'PASS' : 'FAIL'}; report ${path.join(OUT, 'report.json')}`);
process.exit(allPass ? 0 : 1);
