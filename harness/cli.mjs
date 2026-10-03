#!/usr/bin/env node
// 00056 harness CLI: local Midnight 2.x stack (Docker) + native Solana test validator.
//
//   node harness/cli.mjs up [--allow-other-midnight]   start everything, derive wallets, write .state/run.json
//   node harness/cli.mjs status                        print the state file and liveness
//   node harness/cli.mjs balances [--wallet <name>]     re-query SDK balances, update the state file
//   node harness/cli.mjs transfer --from <w> --to <w> --token <64 hex> --amount <n>
//   node harness/cli.mjs fixtures [--wallet <name>]     capture indexer fixtures -> fixtures/undeployed/<wallet>.json
//   node harness/cli.mjs down [--all]                  tear everything down and check nothing is left (gate A5)
//   node harness/cli.mjs wallets [--seed <hex>]        offline: derive viewing keys / addresses (no stack)
//   node harness/cli.mjs check-vk                      offline: gate A2 known-answer check
//
// Logs go to stderr; each command prints one JSON result to stdout.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  HARNESS_DIR, ENV_FILE, STATE_DIR, STATE_FILE, PROJECT_PREFIX,
  pickPorts, portFree, otherStacks, compose, run, newProjectName, writeEnv, waitMidnight,
  startValidator, waitValidator, checkSolanaWs, stopValidator, pidAlive, readState, writeState, urlsFor,
} from './lib/stack.mjs';
import {
  NETWORK_ID, FIXED_WALLETS, newFreshSeedHex, describeWallet, sdkBalances, shieldedAddressObjOf, shieldedTransfer,
  viewingKeyOf, buildFacade, waitFacadeSynced, facadeSummary,
} from './lib/wallets.mjs';
import { captureShieldedTransactions, connect, disconnect } from './lib/indexer.mjs';

const log = (...a) => console.error(...a);
const out = (obj) => process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
const FIXTURES_DIR = path.join(HARNESS_DIR, 'fixtures', NETWORK_ID);

// Known answers: midnight-node 2.0.0-rc.4 toolkit `show-viewing-key` tests
// (util/toolkit/src/commands/show_viewing_key.rs:28-45; the toolkit HD-derives m/44'/2400'/0'/3/0 from --seed).
export const KNOWN_VKS = [
  { networkId: 'undeployed', seedHex: '00'.repeat(31) + '01', viewingKey: 'mn_shield-esk_undeployed1dlyj7u8juj68fd4psnkqhjxh32sec0q480vzswg8kd485e2kljcs9ete5h' },
  { networkId: 'devnet', seedHex: '00'.repeat(31) + '02', viewingKey: 'mn_shield-esk_devnet1w0dctw9zhe2ffqw4s5qks7rnl29wy5mhl957fv9nnhtxulent80q5dejklr' },
  { networkId: 'testnet', seedHex: '00'.repeat(31) + '03', viewingKey: 'mn_shield-esk_testnet1wvd5v04ykt59gglxknsdxpwwkhhhj8d6h3ghpkgdhdsszap2p53qkprdkd8' },
];

function needState() {
  const s = readState();
  if (!s) throw new Error(`no harness state (${STATE_FILE}); run \`node harness/cli.mjs up\` first`);
  return s;
}

const walletByName = (state, name) => {
  const w = state.wallets.find((x) => x.name === name);
  if (!w) throw new Error(`unknown wallet ${name}; known: ${state.wallets.map((x) => x.name).join(', ')}`);
  return w;
};

// ---- up ---------------------------------------------------------------------------------------

async function cmdUp(opts) {
  if (readState()) throw new Error(`state file exists (${STATE_FILE}): a stack is up; run \`down\` first`);
  const { ours, midnight } = otherStacks();
  if (ours.length) {
    throw new Error(`another 00056 harness stack exists: ${ours.map((c) => `${c.name} (${c.project}, ${c.state})`).join(', ')}; run \`down --all\``);
  }
  if (midnight.length && !opts['allow-other-midnight']) {
    throw new Error(
      `another Midnight stack is running (one at a time on this host): ${midnight.map((c) => `${c.name} [${c.image}]`).join(', ')}. ` +
        'Pass --allow-other-midnight to override.',
    );
  }

  const t0 = Date.now();
  const taken = new Set();
  const ports = {};
  ports.node = await pickPorts(1, taken);
  ports.indexer = await pickPorts(1, taken);
  ports.proofServer = await pickPorts(1, taken);
  ports.solanaRpc = await pickPorts(2, taken, { udp: true }); // rpc + websocket (rpc + 1)
  ports.solanaWs = ports.solanaRpc + 1;
  ports.solanaFaucet = await pickPorts(1, taken, { udp: true });
  ports.solanaGossip = await pickPorts(1, taken, { udp: true });
  ports.solanaDynamicLo = await pickPorts(26, taken, { udp: true });
  ports.solanaDynamicHi = ports.solanaDynamicLo + 25;
  ports.service = await pickPorts(1, taken);

  const project = newProjectName();
  writeEnv(ports);
  const state = {
    project,
    networkId: NETWORK_ID,
    createdAt: new Date().toISOString(),
    ports,
    urls: urlsFor(ports),
    validator: null,
    wallets: [],
  };
  writeState(state); // written first, so `down` can clean up a partial `up`
  log(`[up] project ${project}, ports ${JSON.stringify(ports)}`);

  try {
    log('[up] docker compose up -d (node, indexer, proof server)...');
    compose(project, ['up', '-d', '--pull', 'never'], { quiet: true });
    const midnightInfo = await waitMidnight(state.urls, log);
    state.midnight = midnightInfo;
    writeState(state);

    log('[up] starting solana-test-validator...');
    const v = startValidator({
      rpcPort: ports.solanaRpc,
      faucetPort: ports.solanaFaucet,
      gossipPort: ports.solanaGossip,
      dynamicLo: ports.solanaDynamicLo,
      dynamicHi: ports.solanaDynamicHi,
    });
    state.validator = { pid: v.pid, ledgerDir: v.ledgerDir, dir: v.dir, logFile: v.logFile, args: v.args };
    writeState(state);
    const sol = await waitValidator(state.urls.solanaRpc, log);
    state.validator.version = sol.version;
    state.validator.wsSubscriptionId = await checkSolanaWs(state.urls.solanaWs);
    log(`[up] solana websocket on rpc+1 answered slotSubscribe (id ${state.validator.wsSubscriptionId})`);
    writeState(state);

    log('[up] deriving wallets and querying SDK balances...');
    const wallets = [...FIXED_WALLETS, { name: 'fresh-1', seedHex: newFreshSeedHex() }];
    for (const w of wallets) {
      const d = describeWallet(w);
      const sessionId = await connect(state.urls.indexerHttp, d.viewingKey); // the indexer must accept the key
      await disconnect(state.urls.indexerHttp, sessionId);
      d.indexerAcceptsViewingKey = /^[0-9a-f]{64}$/.test(sessionId);
      d.sdkBalances = await sdkBalances(w.seedHex, state.urls);
      d.spentAnything = false;
      state.wallets.push(d);
      writeState(state);
      log(`[up] ${d.name}: ${JSON.stringify(d.sdkBalances)}`);
    }
    state.upSeconds = Math.round((Date.now() - t0) / 1000);
    writeState(state);
  } catch (e) {
    log(`[up] FAILED: ${e.stack || e.message}`);
    if (!opts['keep-on-failure']) {
      log('[up] tearing down the partial stack...');
      await cmdDown({});
    }
    throw e;
  }

  log('');
  log(`Midnight node   ${state.urls.nodeHttp}  (${state.midnight.nodeVersion})`);
  log(`Indexer         ${state.urls.indexerHttp}`);
  log(`Proof server    ${state.urls.proofServer}  (${state.midnight.proofServerVersion})`);
  log(`Solana RPC      ${state.urls.solanaRpc}  ws ${state.urls.solanaWs}  (solana-core ${state.validator.version['solana-core']})`);
  log(`Service port    ${state.ports.service} (reserved for P2)`);
  for (const w of state.wallets) {
    log(`\n${w.name}  seed ${w.seedHex}\n  viewing key ${w.viewingKey}\n  address     ${w.shieldedAddress}\n  balances    ${JSON.stringify(w.sdkBalances)}`);
  }
  log(`\nup in ${state.upSeconds} s; state: ${STATE_FILE}`);
  out(state);
}

// ---- down -------------------------------------------------------------------------------------

async function cmdDown(opts) {
  const state = readState();
  const projects = new Set();
  if (state?.project) projects.add(state.project);
  if (opts.all) for (const c of otherStacks().ours) projects.add(c.project);
  const result = { projects: [...projects], steps: [] };

  for (const p of projects) {
    // compose needs the env file to parse the file; recreate a dummy one if it is gone.
    if (!fs.existsSync(ENV_FILE)) writeEnv({ node: 10000, indexer: 10000, proofServer: 10000 });
    const r = compose(p, ['down', '-v', '--remove-orphans', '--timeout', '20'], { allowFail: true, quiet: true });
    result.steps.push({ step: `compose down ${p}`, status: r.status });
    log(`[down] compose down -v --remove-orphans ${p}: exit ${r.status}`);
  }

  const pid = state?.validator?.pid;
  if (pid) {
    const ok = await stopValidator(pid, log);
    result.steps.push({ step: `kill validator ${pid}`, ok });
    log(`[down] validator ${pid} stopped: ${ok}`);
  }
  const vdir = state?.validator?.dir;
  if (vdir && path.basename(vdir).startsWith('s00056-solana-')) {
    fs.rmSync(vdir, { recursive: true, force: true });
    result.steps.push({ step: `rm ${vdir}`, ok: !fs.existsSync(vdir) });
  }
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
  fs.rmSync(ENV_FILE, { force: true });

  // Gate A5 checks.
  const residual = {};
  for (const p of projects) {
    const r = run('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${p}`], { allowFail: true });
    const v = run('docker', ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${p}`], { allowFail: true });
    const n = run('docker', ['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${p}`], { allowFail: true });
    residual[p] = {
      containers: r.stdout.trim().split('\n').filter(Boolean).length,
      volumes: v.stdout.trim().split('\n').filter(Boolean).length,
      networks: n.stdout.trim().split('\n').filter(Boolean).length,
    };
  }
  const portsLeft = [];
  if (state?.ports) {
    const list = Object.entries(state.ports).filter(([k]) => !k.startsWith('solanaDynamic'));
    for (let p = state.ports.solanaDynamicLo; p && p <= state.ports.solanaDynamicHi; p++) list.push([`dyn${p}`, p]);
    for (const [k, p] of list) if (!(await portFree(p, { udp: k.startsWith('solana') || k.startsWith('dyn') }))) portsLeft.push(`${k}:${p}`);
  }
  result.checks = {
    residual,
    validatorAlive: pid ? pidAlive(pid) : false,
    validatorDirExists: vdir ? fs.existsSync(vdir) : false,
    stateDirExists: fs.existsSync(STATE_DIR),
    envFileExists: fs.existsSync(ENV_FILE),
    portsStillInUse: portsLeft,
  };
  result.clean =
    Object.values(residual).every((x) => x.containers === 0 && x.volumes === 0 && x.networks === 0) &&
    !result.checks.validatorAlive &&
    !result.checks.validatorDirExists &&
    !result.checks.stateDirExists &&
    !result.checks.envFileExists &&
    portsLeft.length === 0;
  if (!state && !opts.all) result.note = 'no state file: nothing recorded to tear down (use --all to remove every s00056-* project)';
  log(`[down] clean: ${result.clean}`);
  out(result);
  return result;
}

// ---- status / balances --------------------------------------------------------------------------

async function cmdStatus() {
  const s = needState();
  const ps = run('docker', ['ps', '-a', '--filter', `label=com.docker.compose.project=${s.project}`, '--format', '{{.Names}} {{.State}} {{.Status}}'], {
    allowFail: true,
  });
  out({ ...s, live: { containers: ps.stdout.trim().split('\n').filter(Boolean), validatorAlive: pidAlive(s.validator?.pid) } });
}

async function cmdBalances(opts) {
  const s = needState();
  for (const w of s.wallets) {
    if (opts.wallet && w.name !== opts.wallet) continue;
    w.sdkBalances = await sdkBalances(w.seedHex, s.urls);
    log(`[balances] ${w.name}: ${JSON.stringify(w.sdkBalances)}`);
  }
  writeState(s);
  out(Object.fromEntries(s.wallets.map((w) => [w.name, w.sdkBalances])));
}

async function cmdDust(opts) {
  const s = needState();
  const w = walletByName(s, opts.wallet ?? 'genesis-1');
  const f = await buildFacade(w.seedHex, s.urls);
  try {
    const st = await waitFacadeSynced(f.wallet);
    const summary = facadeSummary(st);
    log(`[dust] ${w.name}: ${JSON.stringify(summary)}`);
    out({ wallet: w.name, ...summary });
  } finally {
    await f.wallet.stop().catch(() => {});
  }
}

// ---- transfer -----------------------------------------------------------------------------------

async function cmdTransfer(opts) {
  const s = needState();
  for (const k of ['from', 'to', 'token', 'amount']) if (!opts[k]) throw new Error(`--${k} is required`);
  if (!/^[0-9a-f]{64}$/.test(opts.token)) throw new Error('--token must be 64 lowercase hex');
  const amount = BigInt(opts.amount);
  const from = walletByName(s, opts.from);
  const to = walletByName(s, opts.to);
  const t0 = Date.now();
  const toBefore = await sdkBalances(to.seedHex, s.urls);
  const fromBefore = await sdkBalances(from.seedHex, s.urls);
  log(`[transfer] before: ${from.name} ${JSON.stringify(fromBefore)}; ${to.name} ${JSON.stringify(toBefore)}`);
  const res = await shieldedTransfer({
    fromSeedHex: from.seedHex,
    toAddressObj: shieldedAddressObjOf(to.seedHex),
    tokenHex: opts.token,
    amount,
    urls: s.urls,
    log,
  });
  const expected = BigInt(toBefore[opts.token] ?? '0') + amount;
  log(`[transfer] waiting for ${to.name}'s SDK balance of ${opts.token.slice(0, 8)}… to reach ${expected}...`);
  const toAfter = await sdkBalances(to.seedHex, s.urls, {
    timeoutMs: 300_000,
    until: (b) => BigInt(b[opts.token] ?? '0') >= expected,
  });
  const fromAfter = await sdkBalances(from.seedHex, s.urls);
  from.spentAnything = true;
  from.sdkBalances = fromAfter;
  to.sdkBalances = toAfter;
  (s.transfers ??= []).push({ from: from.name, to: to.name, token: opts.token, amount: amount.toString(), txId: res.txId, at: new Date().toISOString() });
  writeState(s);
  const result = {
    txId: res.txId,
    from: from.name,
    to: to.name,
    token: opts.token,
    amount: amount.toString(),
    seconds: Math.round((Date.now() - t0) / 1000),
    sender: { sdkBefore: fromBefore, facadeBefore: res.before, facadeAfter: res.after, sdkAfter: fromAfter },
    receiver: { sdkBefore: toBefore, sdkAfter: toAfter },
    receiverGotAmount: BigInt(toAfter[opts.token] ?? '0') - BigInt(toBefore[opts.token] ?? '0') === amount,
  };
  log(`[transfer] receiver got exactly ${amount}: ${result.receiverGotAmount}`);
  out(result);
}

// ---- fixtures -----------------------------------------------------------------------------------

async function cmdFixtures(opts) {
  const s = needState();
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  const summary = [];
  for (const w of s.wallets) {
    if (opts.wallet && w.name !== opts.wallet) continue;
    log(`[fixtures] ${w.name}: connect + shieldedTransactions from index 0...`);
    const cap = await captureShieldedTransactions({ indexerHttp: s.urls.indexerHttp, indexerWs: s.urls.indexerWs, viewingKey: w.viewingKey, log });
    const balances = await sdkBalances(w.seedHex, s.urls);
    w.sdkBalances = balances;
    const fixture = {
      wallet: w.name,
      networkId: s.networkId,
      seedHex: w.seedHex,
      viewingKey: w.viewingKey,
      shieldedAddress: w.shieldedAddress,
      sdkBalances: balances,
      spentAnything: !!w.spentAnything,
      capturedAt: new Date().toISOString(),
      stack: {
        node: s.midnight?.nodeVersion,
        indexerImage: 'midnightntwrk/indexer-standalone@sha256:5d79f3a20da9ed86236c7f7dc9d93b1beeb0b0c47c9c43a791041322eb80b74e (4.4.0-rc.1)',
        proofServer: s.midnight?.proofServerVersion,
      },
      finalProgress: cap.progress.at(-1) ?? null,
      transactions: cap.transactions.map((ev) => ({
        id: ev.transaction.id,
        hash: ev.transaction.hash,
        protocolVersion: ev.transaction.protocolVersion,
        identifiers: ev.transaction.identifiers,
        startIndex: ev.transaction.startIndex,
        endIndex: ev.transaction.endIndex,
        fees: ev.transaction.fees,
        transactionResult: ev.transaction.transactionResult,
        raw: ev.transaction.raw,
      })),
    };
    const file = path.join(FIXTURES_DIR, `${w.name}.json`);
    fs.writeFileSync(file, JSON.stringify(fixture, null, 2) + '\n');
    const row = {
      wallet: w.name,
      file: path.relative(HARNESS_DIR, file),
      transactions: fixture.transactions.length,
      statuses: fixture.transactions.map((t) => t.transactionResult?.status),
      sdkBalances: balances,
      spentAnything: fixture.spentAnything,
      finalProgress: fixture.finalProgress,
    };
    summary.push(row);
    log(`[fixtures] ${w.name}: ${row.transactions} txs -> ${row.file}`);
  }
  writeState(s);
  out(summary);
}

// ---- offline ------------------------------------------------------------------------------------

function cmdWallets(opts) {
  const list = opts.seed ? [{ name: 'custom', seedHex: opts.seed }] : FIXED_WALLETS;
  out(list.map((w) => describeWallet(w)));
}

function cmdCheckVk() {
  const rows = KNOWN_VKS.map((k) => {
    const derived = viewingKeyOf(k.seedHex, k.networkId);
    return { ...k, derived, match: derived === k.viewingKey };
  });
  const ok = rows.every((r) => r.match);
  out({ derivation: "HD m/44'/2400'/0'/3/0 (wallet-sdk-hd) -> ZswapSecretKeys.fromSeed -> encryptionSecretKey -> bech32m shield-esk", vectors: rows, match: ok });
  if (!ok) process.exitCode = 1;
}

// ---- main -------------------------------------------------------------------------------------

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    from: { type: 'string' },
    to: { type: 'string' },
    token: { type: 'string' },
    amount: { type: 'string' },
    wallet: { type: 'string' },
    seed: { type: 'string' },
    all: { type: 'boolean' },
    'allow-other-midnight': { type: 'boolean' },
    'keep-on-failure': { type: 'boolean' },
  },
});

const commands = {
  up: cmdUp,
  down: cmdDown,
  status: cmdStatus,
  balances: cmdBalances,
  dust: cmdDust,
  transfer: cmdTransfer,
  fixtures: cmdFixtures,
  wallets: cmdWallets,
  'check-vk': cmdCheckVk,
};
const cmd = commands[positionals[0]];
if (!cmd) {
  log(`usage: node harness/cli.mjs <${Object.keys(commands).join('|')}> [options]`);
  process.exit(2);
}
try {
  await cmd(values);
  process.exit(process.exitCode ?? 0); // the wallet SDK keeps sockets/timers alive
} catch (e) {
  log(`ERROR: ${e.message}`);
  process.exit(1);
}
