#!/usr/bin/env node
// Self-test of check-fixtures.mjs before lane A's real fixtures exist: builds synthetic I-3
// fixtures from the indexer's 2.x test transactions (tests/fixtures/v9_tx_1_2_{2,3}.raw) and
// checks the counting rule (FAILURE, PARTIAL_SUCCESS, SUCCESS with segments null, duplicates,
// spent wallets not compared) and the exit codes.
//
// usage: node selftest-check-fixtures.mjs <binary>

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const binary = resolve(process.argv[2] ?? join(here, '..', 'target', 'release', 'midnight-esk-decrypt'));
const checker = join(here, 'check-fixtures.mjs');
const raw = (name) => readFileSync(join(here, '..', 'tests', 'fixtures', name)).toString('hex');
const TX_1_2_2 = raw('v9_tx_1_2_2.raw');
const TX_1_2_3 = raw('v9_tx_1_2_3.raw');

// `undeployed` viewing keys of seeds 00…01..03 (asserted in tests/decrypt.rs).
const KEY = {
  1: 'mn_shield-esk_undeployed1dlyj7u8juj68fd4psnkqhjxh32sec0q480vzswg8kd485e2kljcs9ete5h',
  2: 'mn_shield-esk_undeployed1w0dctw9zhe2ffqw4s5qks7rnl29wy5mhl957fv9nnhtxulent80q5t9mydg',
  3: 'mn_shield-esk_undeployed1wvd5v04ykt59gglxknsdxpwwkhhhj8d6h3ghpkgdhdsszap2p53qkzr6qn2',
};
const T0 = '0'.repeat(64);
const ok = { status: 'SUCCESS', segments: null };

const tmp = mkdtempSync(join(tmpdir(), 's00056-check-fixtures-'));
let failed = 0;

function writeSet(dirName, fixtures) {
  const dir = join(tmp, dirName);
  mkdirSync(dir);
  for (const f of fixtures) writeFileSync(join(dir, `${f.wallet}.json`), JSON.stringify(f));
  return dir;
}

function expectRun(label, dir, wantCode, mustContain = []) {
  const run = spawnSync(process.execPath, [checker, dir, binary], { encoding: 'utf8' });
  const out = run.stdout + run.stderr;
  const problems = [];
  if (run.status !== wantCode) problems.push(`exit ${run.status}, want ${wantCode}`);
  for (const needle of mustContain) if (!out.includes(needle)) problems.push(`output lacks ${JSON.stringify(needle)}`);
  for (const key of Object.values(KEY)) if (out.includes(key)) problems.push('output contains a viewing key');
  if (problems.length) {
    failed++;
    console.log(`FAIL ${label}: ${problems.join('; ')}\n${out}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

try {
  const good = writeSet('good', [
    // seed 01 gets 49999999999990 change in each fixture; tx_1_2_2 re-delivered -> counted once.
    { wallet: 'seed-01', seedHex: '00'.repeat(31) + '01', viewingKey: KEY[1], spentAnything: false,
      sdkBalances: { [T0]: '99999999999980' },
      transactions: [
        { hash: 'a', raw: TX_1_2_2, transactionResult: ok },
        { hash: 'b', raw: TX_1_2_3, transactionResult: { status: 'SUCCESS', segments: [{ id: 0, success: true }] } },
        { hash: 'a', raw: TX_1_2_2, transactionResult: ok },
      ] },
    // seed 02: tx_1_2_3 is not relevant (no coins).
    { wallet: 'seed-02', seedHex: '00'.repeat(31) + '02', viewingKey: KEY[2], spentAnything: false,
      sdkBalances: { [T0]: '10' },
      transactions: [
        { hash: 'a', raw: TX_1_2_2, transactionResult: ok },
        { hash: 'b', raw: TX_1_2_3, transactionResult: ok },
      ] },
    // seed 03: a FAILURE tx counts nothing; PARTIAL_SUCCESS still counts segment 0.
    { wallet: 'seed-03-failure', seedHex: '00'.repeat(31) + '03', viewingKey: KEY[3], spentAnything: false,
      sdkBalances: {},
      transactions: [{ hash: 'b', raw: TX_1_2_3, transactionResult: { status: 'FAILURE', segments: null } }] },
    { wallet: 'seed-03-partial', seedHex: '00'.repeat(31) + '03', viewingKey: KEY[3], spentAnything: false,
      sdkBalances: { [T0]: '10' },
      transactions: [{ hash: 'b', raw: TX_1_2_3, transactionResult: { status: 'PARTIAL_SUCCESS', segments: [{ id: 1, success: false }] } }] },
    // A spent wallet is listed but not compared (Q3).
    { wallet: 'seed-01-spent', seedHex: '00'.repeat(31) + '01', viewingKey: KEY[1], spentAnything: true,
      sdkBalances: { [T0]: '1' },
      transactions: [{ hash: 'a', raw: TX_1_2_2, transactionResult: ok }] },
  ]);
  expectRun('matching fixtures pass', good, 0, ['PASS: 4 never-spent wallet(s) compared', 'duplicate commitment', 'tx FAILURE', 'not compared (spent, Q3)']);

  const mismatch = writeSet('mismatch', [
    { wallet: 'seed-02', seedHex: '00'.repeat(31) + '02', viewingKey: KEY[2], spentAnything: false,
      sdkBalances: { [T0]: '11' }, transactions: [{ hash: 'a', raw: TX_1_2_2, transactionResult: ok }] },
  ]);
  expectRun('balance mismatch fails', mismatch, 1, ['MISMATCH', 'FAIL: 1 never-spent']);

  const badTx = writeSet('bad-tx', [
    { wallet: 'seed-02', seedHex: '00'.repeat(31) + '02', viewingKey: KEY[2], spentAnything: false,
      sdkBalances: {}, transactions: [{ hash: 'x', raw: 'deadbeef', transactionResult: ok }] },
  ]);
  expectRun('undecodable transaction fails', badTx, 1, ['ERROR decrypt x: invalid transaction']);

  const wrongNet = writeSet('wrong-net', [
    { wallet: 'devnet-key', seedHex: '00'.repeat(31) + '02', spentAnything: false, sdkBalances: {}, transactions: [],
      viewingKey: 'mn_shield-esk_devnet1w0dctw9zhe2ffqw4s5qks7rnl29wy5mhl957fv9nnhtxulent80q5dejklr' },
  ]);
  // The network id comes from the key's own HRP, so a devnet key validates as devnet (no txs -> 0 == 0).
  expectRun('network id taken from the key HRP', wrongNet, 0, ['PASS']);

  const empty = writeSet('empty', []);
  expectRun('empty fixture dir is a usage error', empty, 2, ['no *.json fixtures']);
} finally {
  if (!process.env.KEEP_TMP) rmSync(tmp, { recursive: true, force: true }); else console.log(`kept ${tmp}`);
}

console.log(failed === 0 ? 'SELFTEST PASS' : `SELFTEST FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
