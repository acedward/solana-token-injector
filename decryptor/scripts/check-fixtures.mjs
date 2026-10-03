#!/usr/bin/env node
// Gate B2: decrypt every transaction of every wallet fixture (interface I-3) with
// midnight-esk-decrypt (protocol I-1), total the received coins per token type with the
// counting rule, and compare with the wallet SDK's balances for wallets that never spent.
//
// usage: node check-fixtures.mjs <fixtures dir> <binary> [--network <id>] [--json <out file>]
//
// Counting rule (plans/00056-solana-token-injector-questions.md Q19, mirrors the indexer:
// indexer-api/src/infra/api/v4/transaction.rs:536-560 sends `segments: null` for SUCCESS):
//   status FAILURE          -> nothing counts
//   segment 0 (guaranteed)  -> counts for SUCCESS and PARTIAL_SUCCESS
//   fallible segment s      -> SUCCESS: counts (unless listed with success:false);
//                              PARTIAL_SUCCESS: counts only if listed with success:true
//   the same commitment is counted once (re-delivered transactions)
//
// Exit codes: 0 all never-spent wallets match; 1 mismatch or decrypt error; 2 usage/input error.
// Never prints a viewing key.

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error('usage: node check-fixtures.mjs <fixtures dir> <binary> [--network <id>] [--json <out file>]');
  process.exit(2);
}

const args = process.argv.slice(2);
const positional = [];
let networkOverride = null;
let jsonOut = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--network') networkOverride = args[++i] ?? usage('--network needs a value');
  else if (args[i] === '--json') jsonOut = args[++i] ?? usage('--json needs a value');
  else positional.push(args[i]);
}
if (positional.length !== 2) usage();
const [fixturesDir, binary] = positional.map((p) => resolve(p));

/** Long-lived decryptor child; responses come back in request order. */
class Decryptor {
  constructor(bin) {
    this.child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = [];
    this.stderr = '';
    this.child.stderr.on('data', (d) => { this.stderr += d; });
    this.child.on('exit', (code, signal) => {
      for (const p of this.pending.splice(0)) p.reject(new Error(`decryptor exited (code ${code}, signal ${signal})`));
    });
    this.child.on('error', (error) => {
      for (const p of this.pending.splice(0)) p.reject(error);
    });
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      const p = this.pending.shift();
      if (!p) return;
      let response;
      try { response = JSON.parse(line); } catch (e) { return p.reject(new Error(`bad response line: ${e.message}`)); }
      if (response.id !== p.id) return p.reject(new Error(`response id ${response.id} != request id ${p.id}`));
      p.resolve(response);
    });
    this.next = 0;
  }
  request(body) {
    const id = `c${this.next++}`;
    return new Promise((resolve, reject) => {
      this.pending.push({ id, resolve, reject });
      this.child.stdin.write(JSON.stringify({ id, ...body }) + '\n');
    });
  }
  close() {
    this.child.stdin.end();
    return new Promise((resolve) => this.child.on('close', resolve));
  }
}

/** Network id from the key's HRP: `mn_shield-esk` = mainnet, `mn_shield-esk_<id>` otherwise. */
function networkOf(viewingKey) {
  const hrp = viewingKey.slice(0, viewingKey.lastIndexOf('1'));
  if (hrp === 'mn_shield-esk') return 'mainnet';
  if (hrp.startsWith('mn_shield-esk_')) return hrp.slice('mn_shield-esk_'.length);
  return null;
}

/** Counting rule (see header). Returns [counts, reason-if-not]. */
function segmentCounts(transactionResult, segment) {
  const status = transactionResult?.status;
  const segments = Array.isArray(transactionResult?.segments) ? transactionResult.segments : null;
  const listed = segments?.find((s) => s.id === segment);
  if (status === 'FAILURE') return [false, 'tx FAILURE'];
  if (status !== 'SUCCESS' && status !== 'PARTIAL_SUCCESS') return [false, `unknown status ${status}`];
  if (segment === 0) return [true, null];
  if (status === 'SUCCESS') return listed && listed.success === false ? [false, `segment ${segment} failed`] : [true, null];
  return listed?.success === true ? [true, null] : [false, `segment ${segment} not successful`];
}

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function padL(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }

async function main() {
  let files;
  try {
    files = readdirSync(fixturesDir).filter((f) => f.endsWith('.json')).sort();
  } catch (e) {
    usage(`cannot read fixtures dir: ${e.message}`);
  }
  if (files.length === 0) usage(`no *.json fixtures in ${fixturesDir}`);

  const decryptor = new Decryptor(binary);
  const version = await decryptor.request({ op: 'version' });
  console.log(`decryptor ${version.version} (ledger ${version.ledger}); fixtures ${fixturesDir}`);

  const report = { fixturesDir, decryptor: version, wallets: [] };
  let failures = 0;
  const rows = [];

  for (const file of files) {
    const fixture = JSON.parse(readFileSync(join(fixturesDir, file), 'utf8'));
    const name = fixture.wallet ?? basename(file, '.json');
    const networkId = networkOverride ?? fixture.networkId ?? networkOf(fixture.viewingKey ?? '');
    const wallet = {
      wallet: name, file, networkId, spentAnything: fixture.spentAnything === true,
      transactions: (fixture.transactions ?? []).length, coins: [], skipped: [], errors: [],
      totals: {}, sdkBalances: fixture.sdkBalances ?? {}, verdict: null,
    };

    const key = await decryptor.request({ op: 'validateKey', networkId, viewingKey: fixture.viewingKey });
    if (!key.ok) {
      wallet.errors.push(`validateKey: ${key.error}`);
    } else {
      const seen = new Set();
      const totals = new Map();
      for (const tx of fixture.transactions ?? []) {
        const response = await decryptor.request({ op: 'decrypt', networkId, viewingKey: fixture.viewingKey, raw: tx.raw });
        if (!response.ok) {
          wallet.errors.push(`decrypt ${tx.hash}: ${response.error}`);
          continue;
        }
        for (const coin of response.coins) {
          const record = { hash: tx.hash, status: tx.transactionResult?.status, ...coin };
          const [counts, reason] = segmentCounts(tx.transactionResult, coin.segment);
          if (!counts) { wallet.skipped.push({ ...record, reason }); continue; }
          if (seen.has(coin.commitment)) { wallet.skipped.push({ ...record, reason: 'duplicate commitment' }); continue; }
          seen.add(coin.commitment);
          wallet.coins.push(record);
          totals.set(coin.tokenType, (totals.get(coin.tokenType) ?? 0n) + BigInt(coin.value));
        }
      }
      wallet.totals = Object.fromEntries([...totals].map(([t, v]) => [t, v.toString()]));
    }

    const types = [...new Set([...Object.keys(wallet.totals), ...Object.keys(wallet.sdkBalances)])].sort();
    let matches = wallet.errors.length === 0;
    for (const type of types) {
      const decrypted = BigInt(wallet.totals[type] ?? 0);
      const sdk = BigInt(wallet.sdkBalances[type] ?? 0);
      if (decrypted !== sdk) matches = false;
      rows.push([name, wallet.spentAnything ? 'yes' : 'no', type, decrypted.toString(), sdk.toString(),
        wallet.spentAnything ? 'not compared (spent, Q3)' : decrypted === sdk ? 'MATCH' : 'MISMATCH']);
    }
    if (types.length === 0) rows.push([name, wallet.spentAnything ? 'yes' : 'no', '(none)', '0', '0', wallet.spentAnything ? 'not compared (spent, Q3)' : 'MATCH']);

    wallet.verdict = wallet.errors.length ? 'ERROR' : wallet.spentAnything ? 'NOT_COMPARED' : matches ? 'MATCH' : 'MISMATCH';
    if (wallet.verdict === 'ERROR' || wallet.verdict === 'MISMATCH') failures++;
    report.wallets.push(wallet);
  }

  await decryptor.close();
  if (decryptor.stderr.trim()) console.error(`decryptor stderr:\n${decryptor.stderr}`);

  const header = ['wallet', 'spent', 'tokenType', 'decrypted', 'sdkBalance', 'result'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const fmt = (r) => r.map((c, i) => (i === 3 || i === 4 ? padL(c, widths[i]) : pad(c, widths[i]))).join('  ');
  console.log(fmt(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(fmt(r));
  console.log('');
  for (const w of report.wallets) {
    console.log(`${w.wallet}: ${w.transactions} txs, ${w.coins.length} coins counted, ${w.skipped.length} skipped, verdict ${w.verdict}`);
    for (const s of w.skipped) console.log(`  skipped ${s.hash} seg ${s.segment} out ${s.outputIndex} ${s.tokenType} ${s.value}: ${s.reason}`);
    for (const e of w.errors) console.log(`  ERROR ${e}`);
  }

  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2) + '\n');

  const compared = report.wallets.filter((w) => !w.spentAnything).length;
  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${compared} never-spent wallet(s) compared, ${failures} failing wallet(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exit(2);
});
