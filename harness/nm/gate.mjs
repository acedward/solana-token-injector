#!/usr/bin/env node
// G-BALANCE (AA 00059): on Night Market's own localnet (its test/stack/p6 compose file, read-only),
// the injector's account-balance tool (tools/account-balance.mjs: the vendored page logic, run by the
// injector's Node image) must compute each account's per-colour balance exactly as Night Market's page
// code does (harness/nm/page-balance.ts over test/stack/p6/page.ts), after deposits, a swap and
// withdrawals, and the unfiled change of a partial withdrawal is measured.
//
//   NM_DIR=<night market checkout> node harness/nm/gate.mjs [--out <dir>] [--keep-on-fail]
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
// everything (containers, volumes, network, the run dir, the per-run image tag, the lock) is removed in
// `finally`, also on SIGINT/SIGTERM. Secrets (device seeds, inbox secrets) stay in the run dir (0600)
// and are grepped for in every output before the run ends (GB-X).

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const HOME = os.homedir();
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);

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
const OUT = path.resolve(opt('out', path.join(REPO, '..', '..', 'evidence', '00059-injector-passport-accounts', 'g-balance', `run-${RUN_ID}`)));
const FIXTURES = path.join(REPO, 'test', 'fixtures', 'nm-localnet');
const SERVICE_IMAGE = `s00059/service:gb-${RUN_ID.toLowerCase()}`;
const COMPOSE_FILE = path.join(NM_DIR, 'test/stack/p6/compose.yml');

mkdirSync(OUT, { recursive: true });
const logFile = path.join(OUT, 'gate.log');
const log = (s) => {
  const line = `${new Date().toISOString()} ${s}`;
  process.stdout.write(`${line}\n`);
  writeFileSync(logFile, `${line}\n`, { flag: 'a' });
};

function sh(cmd, args, { allowFail = false, env, input, quiet = false } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...(env ?? {}) }, input, maxBuffer: 1 << 30 });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`${cmd} ${args.slice(0, 6).join(' ')} … exited ${r.status}: ${(r.stderr || '').slice(-2000)}`);
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
const holderText = `00059 G-BALANCE ${new Date().toISOString()} pid ${process.pid} project ${PROJECT}`;
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
});
const dc = (args, opts = {}) => sh('docker', ['compose', '-f', COMPOSE_FILE, '-p', PROJECT, ...args], { env: env(), ...opts });

let tornDown = false;
async function teardown(reason) {
  if (tornDown) return;
  tornDown = true;
  log(`teardown (${reason})`);
  for (const c of current) c.kill('SIGTERM');
  if (memTimer) clearInterval(memTimer);
  if (stackUp) {
    for (const [svc, file, tail] of [
      ['relay', 'relay.log', 0],
      ['kernel', 'mock-exchange.log', 0],
      ['proof-server-rc8', 'proof-server-rc8.tail.log', 200],
      ['proof-server', 'proof-server.tail.log', 100],
      ['indexer', 'indexer.tail.log', 300],
      ['node', 'node.tail.log', 200],
    ]) {
      const r = dc(['--profile', 'relay', 'logs', '--no-color', ...(tail ? ['--tail', String(tail)] : []), svc], { allowFail: true, quiet: true });
      writeFileSync(path.join(OUT, file), `${r.stdout ?? ''}${r.stderr ?? ''}`);
    }
    dc(['--profile', 'relay', 'down', '-v', '--remove-orphans'], { allowFail: true });
  }
  sh('docker', ['image', 'rm', SERVICE_IMAGE], { allowFail: true, quiet: true });
  // GB-X over every output, the logs just collected included (the state is still in the run dir).
  if (runDir && existsSync(path.join(stateDir(), 'state.json'))) {
    try {
      const gx = secretScan();
      report.secretScan = gx;
      report.gates['GB-X'] = gx.hits.length === 0 ? 'PASS' : 'FAIL';
      log(`GB-X ${report.gates['GB-X']}: ${JSON.stringify(gx)}`);
    } catch (e) {
      report.gates['GB-X'] = 'FAIL';
      log(`GB-X could not run: ${e.message}`);
    }
  }
  if (runDir) rmSync(runDir, { recursive: true, force: true });
  // GB-T: nothing of the project left.
  const left = {
    containers: sh('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${PROJECT}`], { allowFail: true }).stdout.trim(),
    volumes: sh('docker', ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${PROJECT}`], { allowFail: true }).stdout.trim(),
    networks: sh('docker', ['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${PROJECT}`], { allowFail: true }).stdout.trim(),
    image: sh('docker', ['image', 'inspect', SERVICE_IMAGE], { allowFail: true, quiet: true }).status === 0,
    runDir: runDir ? existsSync(runDir) : false,
    portsFree: ports ? await Promise.all(Object.values(ports).map(portFree)) : [],
  };
  releaseLock();
  left.lockHeldByUs = existsSync(LOCK) && existsSync(path.join(LOCK, 'holder')) && readFileSync(path.join(LOCK, 'holder'), 'utf8').trim() === holderText;
  report.teardown = left;
  report.gates['GB-T'] = !left.containers && !left.volumes && !left.networks && !left.image && !left.runDir && !left.lockHeldByUs && left.portsFree.every(Boolean) ? 'PASS' : 'FAIL';
  report.peakMemoryGiB = +(peakBytes / 2 ** 30).toFixed(2);
  report.finishedAt = new Date().toISOString();
  writeFileSync(path.join(OUT, 'report.json'), `${JSON.stringify(report, null, 1)}\n`);
  log(`GB-T ${report.gates['GB-T']}: ${JSON.stringify(left)}`);
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
let ports = null;
const report = { runId: RUN_ID, project: PROJECT, startedAt: new Date().toISOString(), inputs: {}, checkpoints: {}, gates: {}, times: {} };

async function waitFor(what, fn, { tries, everyMs }) {
  for (let i = 0; i < tries; i++) {
    try {
      if (await fn()) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, everyMs));
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
async function tool(who, cp) {
  const st = JSON.parse(readFileSync(path.join(stateDir(), 'state.json'), 'utf8'));
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

// ── comparison ─────────────────────────────────────────────────────────────────────────────────
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
async function checkpoint(cp, expect = {}) {
  const t0 = Date.now();
  const row = { at: new Date().toISOString() };
  for (const who of ['A', 'B']) {
    const page = await probe(['balances', '--who', who]);
    const { out, record } = await tool(who, cp);
    const pt = totals(page.holdings);
    const tt = totals(out.holdings);
    const d = diff(pt, tt);
    row[who] = {
      page: { totals: pt, history: page.history, unconfirmedNotes: page.unconfirmedNotes, unconfirmed: page.unconfirmed, unreadable: page.unreadable, notInInbox: Object.fromEntries(page.holdings.map((h) => [h.colour, h.notInInbox])), unshielded: page.unshielded, seconds: page.seconds },
      tool: out,
      pageMinusTool: d,
    };
    (fixtures[cp] ??= {})[who] = { record, page: { holdings: page.holdings, unshielded: page.unshielded, coins: page.coins, history: page.history } };
  }
  row.seconds = (Date.now() - t0) / 1000;
  const verdicts = expect.verdicts ? expect.verdicts(row) : { equal: ['A', 'B'].every((w) => Object.keys(row[w].pageMinusTool).length === 0) };
  row.verdicts = verdicts;
  row.complete = ['A', 'B'].every((w) => row[w].tool.history.complete && row[w].page.history.complete);
  row.pass = row.complete && Object.values(verdicts).every(Boolean);
  report.checkpoints[cp] = row;
  writeFileSync(path.join(OUT, 'report.json'), `${JSON.stringify(report, null, 1)}\n`);
  log(`${cp}: ${row.pass ? 'PASS' : 'FAIL'} ${JSON.stringify({ verdicts, A: row.A.pageMinusTool, B: row.B.pageMinusTool, A_totals: row.A.page.totals, B_totals: row.B.page.totals, unseen: [row.A.tool.unseenCoins, row.B.tool.unseenCoins] })}`);
  return row;
}

// ── GB-X: no secret in any output ──────────────────────────────────────────────────────────────
function secretScan() {
  const st = JSON.parse(readFileSync(path.join(stateDir(), 'state.json'), 'utf8'));
  const secrets = [st.A.seed, st.B.seed, st.A.encSecret, st.B.encSecret, st.recipientSeed].filter(Boolean).map((s) => s.toLowerCase());
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
  if (existsSync(FIXTURES)) walk(FIXTURES);
  return { secretsChecked: secrets.length, hits };
}

// ── main ───────────────────────────────────────────────────────────────────────────────────────
async function main() {
  // Preflight: images present (never pulled), the key volume's fingerprint pinned by the relay.
  for (const img of [NODE_IMAGE, INDEXER_IMAGE, 'midnightntwrk/proof-server@sha256:38a819eacde273f725551fdf90ca7c31ebf3c0ff145f3ed58ee35f92fb7ce95b', 'midnightntwrk/proof-server:9.0.0-rc.8', BUN_IMAGE, RELAY_IMAGE]) {
    const r = sh('docker', ['image', 'inspect', '--format', '{{.Id}}', img], { allowFail: true, quiet: true });
    if (r.status !== 0) throw new Error(`image ${img} is not present locally (never pulled)`);
    report.inputs[img] = r.stdout.trim();
  }
  if (sh('docker', ['volume', 'inspect', APP_VOLUME], { allowFail: true, quiet: true }).status !== 0) throw new Error(`no app volume ${APP_VOLUME}`);
  report.inputs.nmHead = sh('git', ['-C', NM_DIR, 'rev-parse', 'HEAD']).stdout.trim();
  report.inputs.repoHead = sh('git', ['-C', REPO, 'rev-parse', 'HEAD']).stdout.trim();
  report.inputs.dockerPsBefore = sh('docker', ['ps', '--format', '{{.Names}}']).stdout.trim().split('\n');
  log(`G-BALANCE ${RUN_ID}: project ${PROJECT}, out ${OUT}`);

  takeLock();
  ports = Object.fromEntries((await freePorts(3)).map((p, i) => [['node', 'indexer', 'relay'][i], p]));
  report.ports = ports;
  runDir = mkdtempSync(path.join(os.tmpdir(), 's00059-gb-'));
  chmodSync(runDir, 0o700);
  mkdirSync(stateDir(), { mode: 0o700 });
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
  log(`stack up in ${report.times.stackUp} s (node :${ports.node}, indexer :${ports.indexer}, relay :${ports.relay}; ${INDEXER_IMAGE})`);

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

  // C1: faucet deposits (DEMO_TOKENS_PATH=direct: mint + deposit_shielded in one transaction).
  await flows('open-a,open-b,demo-a,demo-b');
  await checkpoint('c1');
  // C2: a swap (A's change and wanted coin, B's change and wanted coin, filed by the swap itself).
  await flows('make,take');
  await checkpoint('c2');
  // C3: a whole-coin withdrawal (no change).
  await flows('withdraw');
  await checkpoint('c3');
  // C4: a partial withdrawal: its change is the page's (browser-local) until filed.
  await freshProver('c4');
  const w = await probe(['withdraw-partial', '--who', 'A', '--amount', WITHDRAW_AMOUNT, '--symbol', 'twUSDC']);
  report.c4Withdrawal = { txId: w.txId, paid: w.paid, change: w.change, changeOutcome: w.changeOutcome, changeMismatch: w.changeMismatch, seconds: w.seconds };
  log(`C4 withdrawal: ${JSON.stringify(report.c4Withdrawal)}`);
  await checkpoint('c4', {
    verdicts: (row) => ({
      bEqual: Object.keys(row.B.pageMinusTool).length === 0,
      aGapIsTheChange: JSON.stringify(row.A.pageMinusTool) === JSON.stringify({ [w.change.colour]: w.change.value }),
      unseenCoinsIsOne: row.A.tool.unseenCoins === 1,
      pageShowsChangeNotInInbox: row.A.page.notInInbox[w.change.colour] === 1,
    }),
  });
  // C5: Night Market files the change (append_inbox): equal again.
  const sec = await probe(['secure', '--who', 'A']);
  report.c5Secure = { txId: sec.txId, coin: sec.coin, seconds: sec.seconds };
  await checkpoint('c5', {
    verdicts: (row) => ({
      equal: ['A', 'B'].every((x) => Object.keys(row[x].pageMinusTool).length === 0),
      unseenCoinsIsZero: row.A.tool.unseenCoins === 0,
    }),
  });
  // C6: a third party's counterfeit note on a 1-unit coin, and X's real wanted coin.
  await freshProver('c6');
  await flows('make-x,plant');
  await checkpoint('c6', {
    verdicts: (row) => ({
      equal: ['A', 'B'].every((x) => Object.keys(row[x].pageMinusTool).length === 0),
      counterfeitUnconfirmed: row.A.tool.unconfirmedNotes >= 1 && row.A.tool.unconfirmedNotes === row.A.page.unconfirmedNotes,
    }),
  });

  // G.5: fixtures for P2 (public chain data and opened plaintexts only).
  mkdirSync(FIXTURES, { recursive: true });
  for (const [cp, v] of Object.entries(fixtures)) writeFileSync(path.join(FIXTURES, `${cp}.json`), `${JSON.stringify({ checkpoint: cp, runId: RUN_ID, ...v }, null, 1)}\n`);
  writeFileSync(path.join(FIXTURES, 'tokens.json'), readFileSync(path.join(runDir, 'tokens.json')));

  for (const [i, cp] of ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].entries()) report.gates[`GB${i + 1}`] = report.checkpoints[cp]?.pass ? 'PASS' : 'FAIL';
  log(`gates: ${JSON.stringify(report.gates)}`);
}

let failed = false;
try {
  await main();
} catch (e) {
  failed = true;
  report.error = String(e?.stack ?? e);
  log(`FAILED: ${e?.message ?? e}`);
} finally {
  await teardown(failed ? 'failure' : 'done');
}
const allPass = !failed && Object.values(report.gates).every((g) => g === 'PASS') && Object.keys(report.gates).length >= 8;
log(`G-BALANCE ${allPass ? 'PASS' : 'FAIL'}; report ${path.join(OUT, 'report.json')}`);
process.exit(allPass ? 0 : 1);
