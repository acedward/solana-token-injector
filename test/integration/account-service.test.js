'use strict';
// AA 00059 P2 (T2.3, T2.5-T2.8): the account source inside the real service process (mock Solana
// upstream, mock indexer serving Night Market's own account states, fake decryptor for the
// viewing-key path). Registrations are written to accounts.json while the service is stopped (the
// registration API is P3's).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PublicKey, Keypair } = require('@solana/web3.js');
const spl = require('@solana/spl-token');

const { startStack } = require('../helpers/stack');
const { waitFor } = require('../helpers/service');
const { testViewingKey } = require('../helpers/keys');
const { AccountStore } = require('../../src/accounts/store');
const { deriveKey } = require('../../src/tokens/accounts');
const { midnightTokenId } = require('../../src/tokens/midnight');
const { U64_MAX } = require('../../src/amounts');
const { loadNightMarket } = require('../../src/accounts/bundle');
const keys = require('../helpers/nm-keys');
const { V, state, coin, deposit, spend, depositsAll } = require('../helpers/account-chain');

const A = keys.accountHex('A');
const X = V.colours.X;
const Y = V.colours.Y;
const ZERO = V.colours.ZERO;
const T22 = spl.TOKEN_2022_PROGRAM_ID.toBase58();
const wallet = new PublicKey(Buffer.from(keys.deviceKeyHex('A'), 'hex')).toBase58();
const mintOf = (key) => deriveKey(`mint:${midnightTokenId('undeployed', key)}`).toBase58();

let nm;
test.before(async () => {
  nm = await loadNightMarket();
});
const key = (label) => ({ secret: keys.encSecretHex(label), publicKey: nm.encPublicKeyOf(keys.encSecretHex(label)) });

async function amounts(svc, owner) {
  const r = await svc.rpc('getTokenAccountsByOwner', [owner, { programId: T22 }, { encoding: 'jsonParsed' }]);
  const out = {};
  for (const a of r.result.value) out[a.account.data.parsed.info.mint] = a.account.data.parsed.info.tokenAmount.amount;
  return out;
}

/** Writes an account registration into the stopped service's data dir. */
function writeAccount(stack, { ring = ['K1'], lastAmounts = null } = {}) {
  const store = new AccountStore(stack.config.dataDir).load();
  let res;
  for (const l of ring) res = store.upsert({ solanaAddress: wallet, accountAddress: A, networkId: 'undeployed', secret: key(l).secret, publicKey: key(l).publicKey });
  if (lastAmounts) {
    store.setAmounts(res.record.id, lastAmounts);
    store.save();
  }
  return res.record;
}

async function stackWithAccount(t, { stateName = 'ok-inbox', actions = depositsAll(A), ring = ['K1', 'K2'], lastAmounts = null, indexerDown = false } = {}) {
  const stack = await startStack({ midnightExtra: { accounts: { pollMs: 300 } } });
  t.after(() => stack.stop());
  stack.indexer.setContract(A, { state: state(stateName).state, actions, deployHeight: 5 });
  await stack.svc.kill();
  const record = writeAccount(stack, { ring, lastAmounts });
  if (indexerDown) stack.indexer.setDown(true);
  await stack.restart();
  return { stack, record };
}

test('T2.3/T2.6 the RPC lists the account\'s exact amounts; shielded and unshielded 00..00 are two mints', async (t) => {
  const { stack } = await stackWithAccount(t, { stateName: 'ok-inbox-unshielded', ring: ['K1', 'K2', 'K3'] });
  const want = {
    [mintOf(X)]: '501000000',
    [mintOf(Y)]: '7',
    [mintOf(ZERO)]: '42',
    [mintOf(`u:${ZERO}`)]: '5000000',
    [mintOf(`u:${X}`)]: '7',
  };
  const sorted = (o) => JSON.stringify(Object.entries(o).sort());
  await waitFor(async () => sorted(await amounts(stack.svc, wallet)) === sorted(want) || null, { what: 'account amounts', timeoutMs: 8000 }).catch(async (e) => {
    throw new Error(`${e.message}: ${JSON.stringify(await amounts(stack.svc, wallet))}`);
  });
  assert.notEqual(mintOf(ZERO), mintOf(`u:${ZERO}`));
  // The shielded id is 00056's for the same colour.
  assert.equal(mintOf(ZERO), deriveKey(`mint:midnight:undeployed:${ZERO}`).toBase58());
  const conn = new (require('@solana/web3.js').Connection)(stack.svc.url, 'confirmed');
  const md = await spl.getTokenMetadata(conn, new PublicKey(mintOf(`u:${ZERO}`)));
  assert.equal(md.name, `Midnight unshielded ${ZERO.slice(0, 8)}`);
  assert.equal(md.symbol, `MU${ZERO.slice(0, 4).toUpperCase()}`);
  const health = (await stack.svc.api('GET', '/health')).json;
  assert.equal(health.accounts.total, 1);
  assert.equal(health.accounts.synced, 1);
  // Every X coin spent: X is no longer listed (a zero amount is never an account).
  stack.indexer.addAction(A, spend(A, coin('c1').nullifierA, { height: 50, id: 500 }));
  stack.indexer.addAction(A, spend(A, coin('c3').nullifierA, { height: 51, id: 501 }));
  await waitFor(async () => (await amounts(stack.svc, wallet))[mintOf(X)] === undefined, { what: 'X gone', timeoutMs: 8000 });
  assert.equal((await amounts(stack.svc, wallet))[mintOf(`u:${X}`)], '7');
});

test('T2.5 persistence: a restart with the indexer down serves the persisted amounts, status error', async (t) => {
  const { stack } = await stackWithAccount(t);
  await waitFor(async () => (await amounts(stack.svc, wallet))[mintOf(X)] === '501000000', { what: 'first amounts', timeoutMs: 8000 });
  // The amounts are saved (debounced 1 s) into accounts.json.
  const file = path.join(stack.config.dataDir, 'accounts.json');
  await waitFor(() => JSON.parse(fs.readFileSync(file, 'utf8')).accounts[0].lastAmounts?.shielded?.[X] === '501000000', { what: 'persisted amounts', timeoutMs: 5000 });
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  stack.indexer.setDown(true);
  await stack.restart();
  await waitFor(async () => (await stack.svc.api('GET', '/health')).json.accounts.error === 1, { what: 'status error', timeoutMs: 5000 });
  assert.deepEqual(await amounts(stack.svc, wallet), { [mintOf(X)]: '501000000', [mintOf(Y)]: '7' });
  stack.indexer.setDown(false);
  await waitFor(async () => (await stack.svc.api('GET', '/health')).json.accounts.synced === 1, { what: 'synced again', timeoutMs: 8000 });
});

test('T2.6 a viewing key and an account of the same wallet and colour sum; the u64 clamp holds; zero is not listed', async (t) => {
  const { stack } = await stackWithAccount(t, { ring: ['K1'] });
  const vk = testViewingKey();
  const r = await stack.register(wallet, vk);
  assert.equal(r.status, 201);
  stack.tx(vk, [{ segment: 0, outputIndex: 0, commitment: 'aa'.repeat(32), tokenType: X, value: '1000' }]);
  await waitFor(async () => (await amounts(stack.svc, wallet))[mintOf(X)] === '500001000', { what: 'summed X', timeoutMs: 8000 });
  // Above u64 in sum: clamped to u64::MAX.
  stack.tx(vk, [{ segment: 0, outputIndex: 1, commitment: 'bb'.repeat(32), tokenType: Y, value: String(U64_MAX) }]);
  await waitFor(async () => (await amounts(stack.svc, wallet))[mintOf(Y)] === String(U64_MAX), { what: 'clamped Y', timeoutMs: 8000 });
  // The account's c1 and c2 are spent: X falls to the viewing key's 1000; Y keeps the viewing key's clamp.
  stack.indexer.addAction(A, spend(A, coin('c1').nullifierA, { height: 40, id: 400 }));
  stack.indexer.addAction(A, spend(A, coin('c2').nullifierA, { height: 41, id: 401 }));
  await waitFor(async () => (await amounts(stack.svc, wallet))[mintOf(X)] === '1000', { what: 'X after the spend', timeoutMs: 8000 });
  // An account with nothing left lists no token: a wallet with only the account's spent coins.
  const view = (await stack.svc.api('GET', '/health')).json.accounts;
  assert.equal(view.synced, 1);
});

test('T2.7 regression: registrations.json bytes are unchanged while the account source runs and restarts', async (t) => {
  const { stack } = await stackWithAccount(t);
  const vk = testViewingKey();
  const other = Keypair.generate().publicKey.toBase58();
  assert.equal((await stack.register(other, vk)).status, 201);
  const file = path.join(stack.config.dataDir, 'registrations.json');
  const before = fs.readFileSync(file);
  await waitFor(async () => (await amounts(stack.svc, wallet))[mintOf(X)] === '501000000', { what: 'account amounts', timeoutMs: 8000 });
  await new Promise((r) => setTimeout(r, 1500));
  await stack.restart();
  await waitFor(async () => (await amounts(stack.svc, wallet))[mintOf(X)] === '501000000', { what: 'account amounts after restart', timeoutMs: 8000 });
  assert.ok(fs.readFileSync(file).equals(before));
  // The viewing-key API is unchanged: its list shows only the viewing-key registration.
  const list = (await stack.svc.api('GET', '/api/registrations')).json;
  assert.equal(list.length, 1);
  assert.equal(list[0].solanaAddress, other);
});

test('T2.8 latency: a new leaf shows in getTokenAccountsByOwner within pollMs + 1 s', async (t) => {
  // Only c1's leaf is on chain at first; c2's note is unconfirmed.
  const { stack } = await stackWithAccount(t, { actions: [deposit(A, coin('c1'), { mtIndex: 0, height: 10, id: 100 })] });
  await waitFor(async () => (await amounts(stack.svc, wallet))[mintOf(X)] === '500000000', { what: 'c1', timeoutMs: 8000 });
  assert.equal((await amounts(stack.svc, wallet))[mintOf(Y)], undefined);
  const t0 = Date.now();
  stack.indexer.addAction(A, deposit(A, coin('c2'), { mtIndex: 1, height: 11, id: 101 }));
  await waitFor(async () => (await amounts(stack.svc, wallet))[mintOf(Y)] === '7', { what: 'c2 in the RPC', timeoutMs: 1300, intervalMs: 25 });
  const ms = Date.now() - t0;
  assert.ok(ms <= 300 + 1000, `${ms} ms`);
});
