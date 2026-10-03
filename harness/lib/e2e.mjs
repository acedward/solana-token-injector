// 00056 end-to-end gates E1-E7 and E9 (E8 = teardown, checked by the CLI after `down`).
//
// Runs against a stack brought up with `up --with-service`: a local Midnight 2.x network, a native
// solana-test-validator and the service container. Every wait is on the service's own RPC/API answers
// with a timeout (<= 60 s); the watcher's `synced` badge is never a precondition (lane A: indexer
// progress events cannot prove a new key has caught up).

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_DIR, compose, run, serviceContainer, waitService } from './stack.mjs';
import { sdkBalances, shieldedAddressObjOf, shieldedTransfer, viewingKeyOf } from './wallets.mjs';
import {
  TOKEN_PROGRAM, TOKEN_2022_PROGRAM, apiDelete, apiHealth, apiList, apiRegister, base58, injectedAmounts, midnightMint,
  mintMetadata, newSolanaKeypair, rpcRaw, tokenAccounts,
} from './service.mjs';

const WAIT_MS = 60_000; // every wait on the service: <= 60 s
const E2_LIMIT_MS = 30_000; // spec US2-2 / SC-103: a new coin appears within 30 s
const TRANSFER_TOKEN = '00'.repeat(31) + '01';
const TRANSFER_AMOUNT = 1234567n;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sortObj = (o) => Object.fromEntries(Object.entries(o ?? {}).sort(([a], [b]) => a.localeCompare(b)));
const same = (a, b) => JSON.stringify(sortObj(a)) === JSON.stringify(sortObj(b));
const maskSlot = (text) => text.replace(/"slot":\d+/g, '"slot":<slot>');

/** Poll `fn` until it returns a truthy `ok`; returns { ok, value, ms }. */
async function pollUntil(fn, { timeoutMs = WAIT_MS, intervalMs = 500 } = {}) {
  const t0 = Date.now();
  let value;
  for (;;) {
    try {
      value = await fn();
      if (value?.ok) return { ok: true, value, ms: Date.now() - t0 };
    } catch (e) {
      value = { ok: false, error: e.message };
    }
    if (Date.now() - t0 >= timeoutMs) return { ok: false, value, ms: Date.now() - t0 };
    await sleep(intervalMs);
  }
}

function containerInfo(project) {
  const id = serviceContainer(project);
  if (!id) return null;
  const r = run('docker', ['inspect', id, '--format', '{{.State.StartedAt}} {{.RestartCount}} {{.State.Status}}'], { allowFail: true });
  const [startedAt, restartCount, status] = r.stdout.trim().split(' ');
  return { id: id.slice(0, 12), startedAt, restartCount: Number(restartCount), status };
}

function chromePath() {
  const candidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'google-chrome',
    'chromium',
  ].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  return null;
}

/**
 * Headless Chrome screenshot of `url` into `file` (temporary profile, removed afterwards).
 * On this host headless Chrome writes the PNG within ~1 s but does not exit (observed 2026-10-03,
 * P2 run 1), so: spawn it asynchronously (a spawnSync would block the event loop for the whole
 * wait and leave stale keep-alive sockets behind), wait until the file exists with a stable size,
 * then kill Chrome's process group.
 */
async function screenshot(url, file, { width = 1440, height = 2200, timeoutMs = 60_000 } = {}) {
  const chrome = chromePath();
  if (!chrome) throw new Error('no Chrome/Chromium found for the screenshot (set CHROME_BIN)');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 's00056-chrome-'));
  fs.rmSync(file, { force: true });
  const t0 = Date.now();
  const child = spawn(
    chrome,
    [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${profile}`, `--window-size=${width},${height}`, '--virtual-time-budget=6000',
      `--screenshot=${file}`, url,
    ],
    { stdio: 'ignore', detached: true },
  );
  let exited = false;
  child.on('exit', () => (exited = true));
  child.on('error', () => (exited = true));
  try {
    let last = -1;
    for (;;) {
      await sleep(250);
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (size > 0 && size === last) break;
      last = size;
      if (exited && size === 0) throw new Error('headless Chrome exited without writing the screenshot');
      if (Date.now() - t0 > timeoutMs) throw new Error(`no screenshot after ${timeoutMs / 1000} s`);
    }
    return { chrome, width, height, bytes: fs.statSync(file).size, ms: Date.now() - t0, exitedByItself: exited };
  } finally {
    if (!exited) {
      try {
        process.kill(-child.pid, 'SIGKILL'); // Chrome and its helper processes
      } catch {}
      for (let i = 0; i < 20 && !exited; i++) await sleep(100);
    }
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

/** Run a command, return { status, stdout, stderr } (never throws). */
const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 60_000, ...opts });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error?.message };
};

export async function runGates(state, { log, report, screenshotDir, artifactsDir }) {
  const svc = state.urls.service;
  const sol = state.urls.solanaRpc;
  const net = state.networkId;
  const W = Object.fromEntries(state.wallets.map((w) => [w.name, w]));
  const registryFile = path.join(REPO_DIR, 'tokens', `tokens.${net}.json`);
  const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8')).tokens;

  const types = new Set(Object.keys(registry));
  for (const w of state.wallets) for (const t of Object.keys(w.sdkBalances ?? {})) types.add(t);
  const mintToType = new Map([...types].map((t) => [midnightMint(net, t), t]));
  const typeToMint = new Map([...mintToType].map(([m, t]) => [t, m]));
  const injected = (addr) => injectedAmounts(svc, addr, mintToType);

  const gates = [];
  report.gates = gates;
  const gate = async (id, title, fn, { informative = false } = {}) => {
    const t0 = Date.now();
    const g = { id, title, status: 'FAIL', informative };
    gates.push(g);
    log(`\n[e2e] ${id} ${title}`);
    try {
      const res = await fn(g);
      g.status = informative ? 'INFO' : res === false ? 'FAIL' : 'PASS';
      if (informative) g.matches = res !== false;
    } catch (e) {
      g.status = informative ? 'INFO' : 'FAIL';
      g.error = e.message;
    }
    g.seconds = Math.round((Date.now() - t0) / 100) / 10;
    log(`[e2e] ${id} ${g.status}${g.error ? `: ${g.error}` : ''} (${g.seconds} s)`);
    return g;
  };

  // ---- registration (precondition of E1-E7) ------------------------------------------------
  report.registrations = [];
  const t0Reg = Date.now();
  for (const w of state.wallets) {
    const kp = newSolanaKeypair();
    const r = await apiRegister(svc, kp.address, w.viewingKey);
    if (r.status !== 201) throw new Error(`registration of ${w.name} answered HTTP ${r.status}: ${r.text}`);
    w.solana = { address: kp.address, secretKeyBase58: kp.secretKeyBase58, registrationId: r.json.id };
    report.registrations.push({ wallet: w.name, solanaAddress: kp.address, id: r.json.id, http: r.status, viewingKeyMasked: r.json.viewingKeyMasked });
    log(`[e2e] registered ${w.name}: ${kp.address} (HTTP 201, id ${r.json.id}, key ${r.json.viewingKeyMasked})`);
  }

  // ---- E3 invalid registrations -------------------------------------------------------------
  await gate('E3', 'invalid Solana address / malformed key / wrong-network key -> 400, nothing stored', async (g) => {
    const before = await apiList(svc);
    const g2 = W['genesis-2'];
    const good = newSolanaKeypair().address;
    const cases = [
      { case: 'invalid Solana address (not base58)', solanaAddress: 'not-a-solana-address!', viewingKey: g2.viewingKey },
      { case: 'invalid Solana address (31 bytes)', solanaAddress: base58(new Uint8Array(31).fill(7)), viewingKey: g2.viewingKey },
      { case: 'malformed viewing key (bad bech32m checksum)', solanaAddress: good, viewingKey: g2.viewingKey.slice(0, -1) + (g2.viewingKey.endsWith('q') ? 'p' : 'q') },
      { case: 'malformed viewing key (garbage)', solanaAddress: good, viewingKey: 'mn_shield-esk_undeployed1notakey' },
      { case: 'wrong-network viewing key (preview)', solanaAddress: good, viewingKey: viewingKeyOf(g2.seedHex, 'preview') },
      { case: 'shielded address instead of the viewing key', solanaAddress: good, viewingKey: g2.shieldedAddress },
    ];
    g.cases = [];
    for (const c of cases) {
      const r = await apiRegister(svc, c.solanaAddress, c.viewingKey);
      const leaked = r.text.includes(c.viewingKey) && c.viewingKey.length > 40;
      g.cases.push({ case: c.case, http: r.status, error: r.json?.error ?? r.text.slice(0, 200), keyEchoed: leaked });
    }
    const after = await apiList(svc);
    g.countBefore = before.length;
    g.countAfter = after.length;
    g.sameIds = JSON.stringify(before.map((x) => x.id).sort()) === JSON.stringify(after.map((x) => x.id).sort());
    g.goodAddressStored = after.some((x) => x.solanaAddress === good);
    // US2-4: the same pair twice is one registration.
    const again = await apiRegister(svc, g2.solana.address, g2.viewingKey);
    const afterAgain = await apiList(svc);
    g.idempotent = { http: again.status, sameId: again.json?.id === g2.solana.registrationId, count: afterAgain.length };
    return (
      g.cases.every((c) => c.http === 400 && c.error && !c.keyEchoed) &&
      g.sameIds && !g.goodAddressStored &&
      again.status === 200 && g.idempotent.sameId && afterAgain.length === before.length
    );
  });

  // ---- E1 injected amounts == SDK balances (never-spent wallets) ----------------------------
  await gate('E1', 'per never-spent wallet and token type: injected amount == wallet SDK balance; name/symbol from the registry', async (g) => {
    const expected = Object.fromEntries(state.wallets.map((w) => [w.name, sortObj(w.sdkBalances)]));
    g.expected = expected;
    g.perWallet = {};
    const res = await pollUntil(async () => {
      const got = {};
      for (const w of state.wallets) got[w.name] = await injected(w.solana.address);
      for (const w of state.wallets) {
        if (!g.perWallet[w.name] && same(got[w.name], expected[w.name]) && Object.keys(expected[w.name]).length) {
          g.perWallet[w.name] = { matchedAfterMs: Date.now() - t0Reg };
        }
      }
      return { ok: state.wallets.every((w) => same(got[w.name], expected[w.name])), got };
    });
    g.injected = res.value?.got;
    g.waitedMs = res.ms;
    if (!res.ok) throw new Error(`amounts did not match within ${WAIT_MS / 1000} s: ${JSON.stringify(res.value)}`);
    // Token-2022 metadata (name/symbol/decimals) of each injected mint, from the service's RPC.
    g.mints = {};
    let metaOk = true;
    for (const t of new Set(state.wallets.flatMap((w) => Object.keys(w.sdkBalances ?? {})))) {
      const mint = typeToMint.get(t);
      const md = await mintMetadata(svc, mint);
      const want = registry[t];
      const ok = md.programOwner === TOKEN_2022_PROGRAM && md.name === want?.name && md.symbol === want?.symbol && md.decimals === want?.decimals;
      g.mints[t] = { mint, ...md, registry: want ? { name: want.name, symbol: want.symbol, decimals: want.decimals } : null, ok };
      metaOk &&= ok;
    }
    // Classic Token program: no Midnight tokens there (Token-2022 only, Q6).
    g.classicTokenAccounts = {};
    for (const w of state.wallets) g.classicTokenAccounts[w.name] = (await tokenAccounts(svc, w.solana.address, TOKEN_PROGRAM)).length;
    // The page's data (API) shows the same amounts.
    const list = await apiList(svc);
    g.api = {};
    let apiOk = true;
    for (const w of state.wallets) {
      const row = list.find((x) => x.id === w.solana.registrationId);
      const amounts = Object.fromEntries((row?.tokens ?? []).map((t) => [t.tokenType, t.amount]));
      const ok = same(amounts, expected[w.name]);
      g.api[w.name] = { status: row?.status, amounts, ok };
      apiOk &&= ok;
    }
    return metaOk && apiOk && Object.values(g.classicTokenAccounts).every((n) => n === 0);
  });

  // ---- E5 unregistered address untouched -----------------------------------------------------
  await gate('E5', "unregistered address: getTokenAccountsByOwner byte-identical to the validator's own answer", async (g) => {
    const addr = newSolanaKeypair().address;
    g.address = addr;
    g.programs = {};
    let ok = true;
    for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
      const params = [addr, { programId }, { encoding: 'jsonParsed' }];
      const attempts = [];
      for (let i = 0; i < 10; i++) {
        const [a, b] = await Promise.all([rpcRaw(svc, 'getTokenAccountsByOwner', params), rpcRaw(sol, 'getTokenAccountsByOwner', params)]);
        attempts.push({ exact: a.text === b.text, maskedEqual: maskSlot(a.text) === maskSlot(b.text) });
        if (a.text === b.text) {
          g.programs[programId] = { attempts: attempts.length, exactBytes: true, sample: a.text.slice(0, 200) };
          break;
        }
      }
      if (!g.programs[programId]) g.programs[programId] = { attempts: attempts.length, exactBytes: false, maskedEqual: attempts.every((x) => x.maskedEqual) };
      ok &&= g.programs[programId].exactBytes && attempts.every((x) => x.maskedEqual);
    }
    return ok;
  });

  // ---- E6 spl-token CLI ------------------------------------------------------------------------
  await gate('E6', 'spl-token accounts --owner <registered> lists the mints; spl-token display shows the Token-2022 name/symbol', async (g) => {
    const w = W['genesis-2'];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's00056-spl-'));
    try {
      // A throwaway CLI config + keypair so the user's ~/.config/solana is never read.
      const kp = newSolanaKeypair();
      fs.writeFileSync(path.join(dir, 'payer.json'), JSON.stringify(kp.secretKey));
      fs.writeFileSync(path.join(dir, 'cli.yml'), `json_rpc_url: "${svc}"\nwebsocket_url: "${state.urls.serviceWs}"\nkeypair_path: ${path.join(dir, 'payer.json')}\naddress_labels:\n  "11111111111111111111111111111111": System Program\ncommitment: confirmed\n`);
      const base = ['-C', path.join(dir, 'cli.yml'), '--url', svc];
      g.owner = w.solana.address;
      const want = sortObj(w.sdkBalances);
      const listing = {};
      for (const variant of [[], ['--program-2022']]) {
        const r = sh('spl-token', [...base, 'accounts', '--owner', w.solana.address, ...variant, '--output', 'json']);
        const key = variant.length ? 'accounts --program-2022' : 'accounts';
        let parsed = null;
        try {
          parsed = JSON.parse(r.stdout);
        } catch {}
        const accts = parsed?.accounts ?? [];
        const amounts = Object.fromEntries(accts.filter((a) => mintToType.has(a.mint)).map((a) => [mintToType.get(a.mint), a.tokenAmount?.amount]));
        listing[key] = { exit: r.status, accounts: accts.length, amounts, matchesSdk: same(amounts, want), stderr: r.stderr.slice(0, 300) };
      }
      g.accounts = listing;
      g.display = {};
      let displayOk = true;
      for (const t of Object.keys(want)) {
        const mint = typeToMint.get(t);
        const r = sh('spl-token', [...base, 'display', mint, '--output', 'json']);
        let parsed = null;
        try {
          parsed = JSON.parse(r.stdout);
        } catch {}
        const text = r.stdout;
        const ok = r.status === 0 && text.includes(registry[t].name) && text.includes(registry[t].symbol) && text.includes(TOKEN_2022_PROGRAM);
        g.display[t] = { mint, exit: r.status, ok, programId: parsed?.programId ?? null, extensions: parsed?.extensions ?? null, stderr: r.stderr.slice(0, 300) };
        displayOk &&= ok;
      }
      // Human-readable form too (evidence).
      const human = sh('spl-token', [...base, 'accounts', '--owner', w.solana.address, '--program-2022']);
      g.accountsText = human.stdout;
      const disp = sh('spl-token', [...base, 'display', typeToMint.get(Object.keys(want)[0])]);
      g.displayText = disp.stdout;
      return Object.values(listing).some((l) => l.exit === 0 && l.matchesSdk) && listing['accounts --program-2022'].matchesSdk && displayOk;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---- E2 a new shielded transfer appears within 30 s, no restart --------------------------------
  const g1 = W['genesis-1'];
  const fresh = W['fresh-1'];
  const g1Before = await injected(g1.solana.address);
  await gate('E2', `shielded transfer genesis-1 -> fresh-1 (${TRANSFER_AMOUNT} of 00..01): injected == transferred within 30 s, no restart`, async (g) => {
    const before = containerInfo(state.project);
    g.containerBefore = before;
    g.freshBefore = await injected(fresh.solana.address);
    const tStart = Date.now();
    let tSubmit = null;
    let tOracle = null;
    let servicePoll = null;
    // Oracle: the wallet SDK's view of fresh-1 (started before the transfer, resolves when it sees the coin).
    const oracle = sdkBalances(fresh.seedHex, state.urls, {
      timeoutMs: 300_000,
      until: (b) => BigInt(b[TRANSFER_TOKEN] ?? '0') >= TRANSFER_AMOUNT,
    }).then((b) => {
      tOracle = Date.now();
      return b;
    });
    const transfer = shieldedTransfer({
      fromSeedHex: g1.seedHex,
      toAddressObj: shieldedAddressObjOf(fresh.seedHex),
      tokenHex: TRANSFER_TOKEN,
      amount: TRANSFER_AMOUNT,
      urls: state.urls,
      log,
      onSubmitted: () => {
        tSubmit = Date.now();
        servicePoll = pollUntil(async () => {
          const got = await injected(fresh.solana.address);
          return { ok: got[TRANSFER_TOKEN] === TRANSFER_AMOUNT.toString(), got };
        }, { timeoutMs: WAIT_MS, intervalMs: 250 }).then((r) => ({ ...r, at: Date.now() }));
      },
    });
    const tx = await transfer;
    g.txId = tx.txId;
    if (!servicePoll) throw new Error('transfer returned without submitting');
    const sp = await servicePoll;
    const sdk = await oracle;
    g.oracleFresh = sdk;
    g.freshAfter = sp.value?.got;
    g.ms = {
      submitAfterStart: tSubmit - tStart,
      serviceAfterSubmit: sp.at - tSubmit,
      oracleAfterSubmit: tOracle - tSubmit,
      serviceAfterOracle: sp.at - tOracle,
    };
    const after = containerInfo(state.project);
    g.containerAfter = after;
    g.noRestart = after.startedAt === before.startedAt && after.restartCount === before.restartCount;
    if (!sp.ok) throw new Error(`fresh-1's injected amount did not reach ${TRANSFER_AMOUNT} within ${WAIT_MS / 1000} s of submission: ${JSON.stringify(sp.value)}`);
    return (
      same(sp.value.got, { [TRANSFER_TOKEN]: TRANSFER_AMOUNT.toString() }) &&
      sdk[TRANSFER_TOKEN] === TRANSFER_AMOUNT.toString() &&
      g.ms.serviceAfterOracle <= E2_LIMIT_MS &&
      g.noRestart
    );
  });

  // ---- E9 (informative) the sender's total after its spend (Q3) ---------------------------------
  await gate('E9', "genesis-1's injected total after its transfer = previous total + its change coin (Q3 limitation)", async (g) => {
    const sdkAfter = await sdkBalances(g1.seedHex, state.urls);
    const change = BigInt(sdkAfter[TRANSFER_TOKEN] ?? '0');
    const expected = (BigInt(g1Before[TRANSFER_TOKEN] ?? '0') + change).toString();
    g.previousInjected = g1Before[TRANSFER_TOKEN];
    g.sdkAfter = sdkAfter;
    g.changeCoin = change.toString();
    g.expectedInjected = expected;
    const res = await pollUntil(async () => {
      const got = await injected(g1.solana.address);
      return { ok: got[TRANSFER_TOKEN] === expected, got };
    });
    g.injectedAfter = res.value?.got;
    g.waitedMs = res.ms;
    g.overReportsBy = (BigInt(res.value?.got?.[TRANSFER_TOKEN] ?? '0') - change).toString();
    return res.ok;
  }, { informative: true });

  // ---- page screenshot (P3), with all four registrations and their amounts -------------------------
  if (screenshotDir) {
    await gate('P3-shot', 'web page screenshot + GET /api/registrations', async (g) => {
      fs.mkdirSync(screenshotDir, { recursive: true });
      // Not a gate on `synced`: wait up to 60 s for the badges to settle, then shoot regardless.
      const settle = await pollUntil(async () => {
        const list = await apiList(svc);
        return { ok: list.every((r) => r.status === 'synced'), statuses: list.map((r) => r.status) };
      });
      g.statusesAtShot = settle.value?.statuses;
      g.shot = await screenshot(`${svc}/`, path.join(screenshotDir, 'page.png'));
      fs.writeFileSync(path.join(screenshotDir, 'api-registrations.json'), JSON.stringify(await apiList(svc), null, 2) + '\n');
      fs.writeFileSync(path.join(screenshotDir, 'health.json'), JSON.stringify(await apiHealth(svc), null, 2) + '\n');
      const page = await fetch(`${svc}/`);
      fs.writeFileSync(path.join(screenshotDir, 'get-root.html'), await page.text());
      return true;
    }, { informative: false });
  }

  // ---- E4 delete -> tokens gone on the next call ---------------------------------------------------
  await gate('E4', "DELETE a registration -> that address's injected tokens disappear on the next call", async (g) => {
    const w = W['genesis-3'];
    g.wallet = w.name;
    g.before = await injected(w.solana.address);
    const d = await apiDelete(svc, w.solana.registrationId);
    g.deleteHttp = d.status;
    const params = [w.solana.address, { programId: TOKEN_2022_PROGRAM }, { encoding: 'jsonParsed' }];
    const [a, b] = await Promise.all([rpcRaw(svc, 'getTokenAccountsByOwner', params), rpcRaw(sol, 'getTokenAccountsByOwner', params)]); // the very next call
    g.after = await injected(w.solana.address);
    g.nextCallValue = a.json.result?.value;
    g.sameAsValidator = maskSlot(a.text) === maskSlot(b.text);
    const list = await apiList(svc);
    g.stillListed = list.some((x) => x.id === w.solana.registrationId);
    g.othersUnchanged = same(await injected(W['genesis-2'].solana.address), W['genesis-2'].sdkBalances);
    w.deleted = true;
    return Object.keys(g.before).length > 0 && d.status === 204 && a.json.result?.value?.length === 0 && g.sameAsValidator && !g.stillListed && g.othersUnchanged;
  });

  // ---- E7 restart -> registrations persist, totals rebuild -------------------------------------------
  await gate('E7', 'restart the service container -> registrations persist, totals rebuild', async (g) => {
    const live = state.wallets.filter((w) => !w.deleted);
    const idsBefore = (await apiList(svc)).map((x) => x.id).sort();
    const amountsBefore = {};
    for (const w of live) amountsBefore[w.name] = await injected(w.solana.address);
    g.idsBefore = idsBefore;
    g.amountsBefore = amountsBefore;
    g.containerBefore = containerInfo(state.project);
    const t0 = Date.now();
    compose(state.project, ['restart', 'service'], { profile: 'service', quiet: true });
    await waitService(svc, log, { timeoutMs: WAIT_MS });
    g.healthyAfterMs = Date.now() - t0;
    g.containerAfter = containerInfo(state.project);
    g.restarted = g.containerAfter.startedAt !== g.containerBefore.startedAt;
    g.idsAfter = (await apiList(svc)).map((x) => x.id).sort();
    const res = await pollUntil(async () => {
      const got = {};
      for (const w of live) got[w.name] = await injected(w.solana.address);
      return { ok: live.every((w) => same(got[w.name], amountsBefore[w.name])), got };
    });
    g.amountsAfter = res.value?.got;
    g.rebuiltAfterMs = Date.now() - t0;
    return g.restarted && JSON.stringify(g.idsAfter) === JSON.stringify(idsBefore) && res.ok;
  });

  // ---- X1 (FR-104) no full viewing key in the service's logs ---------------------------------------
  await gate('X1', 'FR-104: the service log never contains a full viewing key', async (g) => {
    const id = serviceContainer(state.project);
    const r = run('docker', ['logs', id], { allowFail: true });
    const text = `${r.stdout}${r.stderr}`;
    if (artifactsDir) fs.writeFileSync(path.join(artifactsDir, `service-${state.project}.log`), text);
    g.logLines = text.split('\n').length;
    g.keysFound = state.wallets.filter((w) => text.includes(w.viewingKey)).map((w) => w.name);
    g.freshSeedFound = text.includes(W['fresh-1'].seedHex);
    return g.logLines > 1 && g.keysFound.length === 0 && !g.freshSeedFound;
  });

  return gates;
}
