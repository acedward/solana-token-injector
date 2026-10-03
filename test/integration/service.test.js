'use strict';
// C.10 / gate C1: the service end to end without Docker or a network —
// spawned service + mock Solana upstream + mock Midnight indexer + fake
// decryptor. Scenarios = spec US2 1-7 (+ US4 static tokens alongside).

const test = require('node:test');
const assert = require('node:assert/strict');
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const spl = require('@solana/spl-token');
const { startStack } = require('../helpers/stack');
const { waitFor } = require('../helpers/service');
const { testViewingKey } = require('../helpers/keys');
const { deriveKey, metaplexPda } = require('../../src/tokens/accounts');
const { midnightTokenId } = require('../../src/tokens/midnight');

const T0 = '0'.repeat(64);
const T1 = `${'0'.repeat(63)}1`;
const T2 = `${'0'.repeat(63)}2`;
const MINT_AMOUNT = 50000000000000n; // genesis generator MINT_AMOUNT
const hex = (n) => n.toString(16).padStart(64, '0');
let seq = 0;
const coin = (tokenType, value, segment = 0) => ({ segment, outputIndex: seq % 4, commitment: hex(++seq), tokenType, value: String(value) });
const mintOf = (type) => deriveKey(`mint:${midnightTokenId('undeployed', type)}`);
const T22 = spl.TOKEN_2022_PROGRAM_ID.toBase58();
const TOK = spl.TOKEN_PROGRAM_ID.toBase58();

test('registration service end to end (US2 1-7, US4)', async (t) => {
  const staticHolder = Keypair.generate().publicKey.toBase58();
  const stack = await startStack({
    tokens: [{ name: 'Night', symbol: 'NIGHT', decimals: 6, balances: { [staticHolder]: '42' } }],
  });
  t.after(() => stack.stop());
  const svc = () => stack.svc;
  const conn = () => new Connection(svc().url, 'confirmed');

  const alice = Keypair.generate().publicKey.toBase58(); // genesis-like wallet
  const bob = Keypair.generate().publicKey.toBase58(); // fresh wallet, receives later
  const stranger = Keypair.generate().publicKey.toBase58(); // never registered
  const kAlice = testViewingKey();
  const kAlice2 = testViewingKey();
  const kBob = testViewingKey();

  // Alice's key already holds the genesis coins: 5 x MINT_AMOUNT of 00..00, 1 x of 00..01 and 00..02.
  stack.tx(kAlice, [...Array.from({ length: 5 }, () => coin(T0, MINT_AMOUNT)), coin(T1, MINT_AMOUNT), coin(T2, MINT_AMOUNT)]);

  // amounts per mint for an owner, from a jsonParsed Token-2022 query
  async function amounts(owner) {
    const r = await svc().rpc('getTokenAccountsByOwner', [owner, { programId: T22 }, { encoding: 'jsonParsed' }]);
    const out = {};
    for (const a of r.result.value) out[a.account.data.parsed.info.mint] = a.account.data.parsed.info.tokenAmount.amount;
    return out;
  }
  const regOf = async (id) => (await svc().api('GET', `/api/registrations/${id}`)).json;

  let aliceId;
  await t.test('US2-1 register -> RPC shows one Token-2022 token per type with the exact amount and registry names', async () => {
    const r = await stack.register(alice, kAlice);
    assert.equal(r.status, 201);
    aliceId = r.json.id;
    await waitFor(async () => (await amounts(alice))[mintOf(T0).toBase58()] === String(5n * MINT_AMOUNT), { what: 'alice amounts', timeoutMs: 5000 });
    assert.deepEqual(await amounts(alice), {
      [mintOf(T0).toBase58()]: String(5n * MINT_AMOUNT),
      [mintOf(T1).toBase58()]: String(MINT_AMOUNT),
      [mintOf(T2).toBase58()]: String(MINT_AMOUNT),
    });
    // base64 encoding decodes with spl-token as Token-2022 accounts owned by alice
    const b = await conn().getTokenAccountsByOwner(new PublicKey(alice), { programId: spl.TOKEN_2022_PROGRAM_ID });
    assert.equal(b.value.length, 3);
    for (const { pubkey, account } of b.value) {
      const acc = spl.unpackAccount(pubkey, account, spl.TOKEN_2022_PROGRAM_ID);
      assert.equal(acc.owner.toBase58(), alice);
      assert.deepEqual(spl.getExtensionTypes(acc.tlvData), [spl.ExtensionType.ImmutableOwner]);
    }
    // Token-2022 on-mint metadata + Metaplex PDA carry the registry names
    const md = await spl.getTokenMetadata(conn(), mintOf(T0));
    assert.equal(md.name, 'Midnight Test Token');
    assert.equal(md.symbol, 'MNTT');
    assert.equal((await spl.getMint(conn(), mintOf(T1), 'confirmed', spl.TOKEN_2022_PROGRAM_ID)).decimals, 6);
    const { Metadata } = require('@metaplex-foundation/mpl-token-metadata');
    const [meta] = Metadata.deserialize((await conn().getAccountInfo(metaplexPda(mintOf(T2)))).data);
    assert.equal(meta.data.name.replace(/\0+$/, ''), 'Midnight Alt Token 2');
    // the Token-program query for alice is untouched (Midnight tokens are Token-2022)
    const tok = await svc().rpc('getTokenAccountsByOwner', [alice, { programId: TOK }, { encoding: 'jsonParsed' }]);
    assert.deepEqual(tok.result.value, []);
    // filter by a Midnight mint is answered locally; supply = sum of holders
    const byMint = await svc().rpc('getTokenAccountsByOwner', [alice, { mint: mintOf(T1).toBase58() }, { encoding: 'jsonParsed' }]);
    assert.equal(byMint.result.value.length, 1);
    assert.equal((await svc().rpc('getTokenSupply', [mintOf(T0).toBase58()])).result.value.amount, String(5n * MINT_AMOUNT));
    // the table (API) shows the same amounts
    const v = await regOf(aliceId);
    assert.deepEqual(v.tokens.map((x) => [x.symbol, x.amount]), [['MNTT', String(5n * MINT_AMOUNT)], ['MNA1', String(MINT_AMOUNT)], ['MNA2', String(MINT_AMOUNT)]]);
    assert.equal(v.status, 'synced');
  });

  let bobId;
  await t.test('US2-2 a new shielded transfer appears without a restart', async () => {
    bobId = (await stack.register(bob, kBob)).json.id;
    await waitFor(async () => (await regOf(bobId)).status === 'synced', { what: 'bob synced' });
    assert.deepEqual(await amounts(bob), {}, 'nothing received yet');
    stack.tx(kBob, [coin(T0, 1234567)]);
    await waitFor(async () => (await amounts(bob))[mintOf(T0).toBase58()] === '1234567', { what: 'bob amount', timeoutMs: 5000 });
    assert.equal((await regOf(bobId)).tokens[0].uiAmountString, '1.234567');
  });

  await t.test('FAILURE and failed fallible segments are not counted; a fully successful fallible segment is (Q19)', async () => {
    stack.tx(kBob, [coin(T0, 1000)], { status: 'FAILURE' });
    stack.tx(kBob, [coin(T0, 10), coin(T0, 20, 1), coin(T0, 40, 2)], { status: 'PARTIAL_SUCCESS', segments: [{ id: 1, success: false }, { id: 2, success: true }] });
    stack.tx(kBob, [coin(T0, 5, 1)], { status: 'SUCCESS', segments: null });
    await waitFor(async () => (await amounts(bob))[mintOf(T0).toBase58()] === String(1234567 + 10 + 40 + 5), { what: 'bob after partial', timeoutMs: 5000 });
  });

  await t.test('duplicate delivery is not double-counted', async () => {
    const ev = stack.tx(kBob, [coin(T0, 100)]);
    const want = String(1234567 + 10 + 40 + 5 + 100);
    await waitFor(async () => (await amounts(bob))[mintOf(T0).toBase58()] === want, { what: 'bob +100' });
    stack.indexer.redeliver(kBob, ev);
    stack.indexer.redeliver(kBob, ev);
    stack.tx(kBob, []); // a later event proves the duplicates were processed
    await new Promise((r) => setTimeout(r, 400));
    assert.equal((await amounts(bob))[mintOf(T0).toBase58()], want);
  });

  await t.test('US2-3 invalid inputs -> 400 and nothing stored', async () => {
    const before = (await stack.list()).length;
    for (const body of [{ solanaAddress: 'abc', viewingKey: kBob }, { solanaAddress: bob, viewingKey: 'mn_shield-esk_undeployed1zzzz' }, { solanaAddress: bob, viewingKey: testViewingKey('preprod') }]) {
      const r = await svc().api('POST', '/api/registrations', body);
      assert.equal(r.status, 400);
      assert.ok(r.json.error.length > 10, 'human message');
    }
    assert.equal((await stack.list()).length, before);
  });

  await t.test('US2-4 same pair twice = one row; two keys on one address are summed', async () => {
    const again = await stack.register(alice, kAlice);
    assert.equal(again.status, 200);
    assert.equal(again.json.id, aliceId);
    stack.tx(kAlice2, [coin(T0, 7), coin(T1, 3)]);
    const r = await stack.register(alice, kAlice2);
    assert.equal(r.status, 201);
    await waitFor(async () => (await amounts(alice))[mintOf(T0).toBase58()] === String(5n * MINT_AMOUNT + 7n), { what: 'sum over keys' });
    assert.equal((await amounts(alice))[mintOf(T1).toBase58()], String(MINT_AMOUNT + 3n));
    assert.equal((await stack.list()).filter((x) => x.solanaAddress === alice).length, 2);
  });

  await t.test('US2-6 an unregistered address gets the upstream answer byte for byte', async () => {
    for (const programId of [TOK, T22]) {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'getTokenAccountsByOwner', params: [stranger, { programId }, { encoding: 'jsonParsed' }] });
      const post = async (url) => (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).text();
      assert.equal(await post(svc().url), await post(stack.upstream.url));
    }
  });

  await t.test('US4 static config tokens keep working next to Midnight tokens', async () => {
    const r = await svc().rpc('getTokenAccountsByOwner', [staticHolder, { programId: TOK }, { encoding: 'jsonParsed' }]);
    assert.equal(r.result.value[0].account.data.parsed.info.tokenAmount.uiAmountString, '42');
  });

  await t.test('GET /api/registrations never contains a full viewing key', async () => {
    const text = (await svc().api('GET', '/api/registrations')).text;
    for (const k of [kAlice, kAlice2, kBob]) assert.ok(!text.includes(k));
    assert.ok(text.includes(`${kAlice.slice(0, 16)}…${kAlice.slice(-6)}`));
  });

  await t.test('US2-7 indexer down -> error status, last amounts served, reconnect restores', async () => {
    const before = await amounts(bob);
    stack.indexer.setDown(true);
    await waitFor(async () => (await regOf(bobId)).status === 'error', { what: 'error status' });
    assert.ok((await regOf(bobId)).error);
    assert.deepEqual(await amounts(bob), before, 'RPC keeps the last known amounts');
    const h = (await svc().api('GET', '/health')).json;
    assert.equal(h.ok, false);
    assert.equal(h.indexer.ok, false);
    assert.ok(h.registrations.error >= 1);
    stack.indexer.setDown(false);
    stack.tx(kBob, [coin(T0, 1)]); // arrived during the outage
    await waitFor(async () => (await regOf(bobId)).status === 'synced', { what: 'synced again', timeoutMs: 8000 });
    await waitFor(async () => BigInt((await amounts(bob))[mintOf(T0).toBase58()]) === BigInt(before[mintOf(T0).toBase58()]) + 1n, { what: 'outage tx counted' });
  });

  await t.test('US2-5 delete -> that registration\'s tokens disappear on the next call', async () => {
    const del = await svc().api('DELETE', `/api/registrations/${bobId}`);
    assert.equal(del.status, 204);
    assert.deepEqual(await amounts(bob), {}, 'next RPC call, no wait');
    assert.equal((await svc().rpc('getTokenAccountBalance', [spl.getAssociatedTokenAddressSync(mintOf(T0), new PublicKey(bob), false, spl.TOKEN_2022_PROGRAM_ID).toBase58()])).error.code, -32601, 'falls through to upstream');
  });

  await t.test('restart: registrations persist, totals rebuild from the indexer', async () => {
    const want = await amounts(alice);
    const ids = (await stack.list()).map((r) => r.id).sort();
    const connectsBefore = stack.indexer.calls.connect;
    await stack.restart();
    assert.deepEqual((await stack.list()).map((r) => r.id).sort(), ids);
    await waitFor(async () => JSON.stringify(await amounts(alice)) === JSON.stringify(want), { what: 'totals rebuilt', timeoutMs: 8000 });
    assert.ok(stack.indexer.calls.connect > connectsBefore, 'new indexer sessions after the restart');
    await waitFor(async () => (await stack.list()).every((r) => r.status === 'synced'), { what: 'all synced' });
  });
});
