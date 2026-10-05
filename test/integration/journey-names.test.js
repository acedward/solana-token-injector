'use strict';
// AA 00059 P4 (T4.2-T4.5): the journey token registry (00057 I-1) in the real service: start-up
// refusals against the upstream, hot reload, I-4b names in both metadata layouts, and the injector's
// own registry for the colours I-1 does not list.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const spl = require('@solana/spl-token');

const { startStack } = require('../helpers/stack');
const { startService, waitFor, makeTempDir } = require('../helpers/service');
const { startMockUpstream } = require('../helpers/mock-upstream');
const { startMockIndexer } = require('../helpers/mock-indexer');
const { FAKE_DECRYPTOR } = require('../helpers/fake-map');
const { testViewingKey } = require('../helpers/keys');
const { deriveKey, metaplexPda } = require('../../src/tokens/accounts');
const { midnightTokenId } = require('../../src/tokens/midnight');

const X = 'ab'.repeat(32); // a bridged colour
const T0 = '0'.repeat(64); // named by tokens/tokens.undeployed.json
const UNKNOWN = 'cd'.repeat(32);
const mintOf = (key) => deriveKey(`mint:${midnightTokenId('undeployed', key)}`);
const splX = Keypair.generate().publicKey.toBase58();
const journey = (genesis, o = {}) => ({
  midnightNetwork: 'undeployed',
  solanaGenesisHash: genesis,
  tokens: [{ colour: X, splMint: splX, bridgeContract: '12'.repeat(32), bridgeProgram: Keypair.generate().publicKey.toBase58(), bridgeApi: 'http://127.0.0.1:1', name: 'Test X', symbol: 'X', decimals: 9, ...o }],
});

/** Starts the service against a mock upstream/indexer with a journey file; resolves {svc} or {exit}. */
async function tryStart({ upstream, file, deadlineMs = 1500 }) {
  const dir = makeTempDir('sti-journey-');
  const indexer = await startMockIndexer();
  try {
    const svc = await startService({
      dir,
      config: {
        upstream: upstream.url,
        dataDir: path.join(dir, 'data'),
        midnight: { networkId: 'undeployed', indexerHttp: indexer.httpUrl, indexerWs: indexer.wsUrl, decryptorBin: FAKE_DECRYPTOR, journeyRegistry: file, journeyCheckDeadlineMs: deadlineMs, accounts: { enabled: false } },
      },
      readyTimeoutMs: deadlineMs + 10000,
    });
    await svc.stop();
    return { started: true };
  } catch (e) {
    return { started: false, error: e.message };
  } finally {
    await indexer.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('T4.2 start-up against the upstream: genesis, missing mint, Token-2022 mint, other decimals, upstream down -> exit 1', async (t) => {
  const upstream = await startMockUpstream();
  t.after(() => upstream.close());
  const dir = makeTempDir('sti-journey-files-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, obj) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, JSON.stringify(obj));
    return f;
  };
  upstream.setMint(splX, { decimals: 9 });
  assert.deepEqual(await tryStart({ upstream, file: write('ok.json', journey(upstream.genesisHash())) }), { started: true });
  const cases = [
    ['another genesis hash', write('g.json', journey(Keypair.generate().publicKey.toBase58())), /startup error: .*upstream's genesis hash is/],
    ['a missing mint', write('m.json', journey(upstream.genesisHash(), { splMint: Keypair.generate().publicKey.toBase58() })), /does not exist on the upstream/],
    ['other decimals', write('d.json', journey(upstream.genesisHash(), { decimals: 6 })), /has 9 decimals on the upstream, the registry says 6/],
    ['another Midnight network', write('n.json', { ...journey(upstream.genesisHash()), midnightNetwork: 'stagenet' }), /config error: .*"midnightNetwork" is "stagenet"/],
  ];
  const t22 = Keypair.generate().publicKey.toBase58();
  upstream.setMint(t22, { decimals: 9, owner: spl.TOKEN_2022_PROGRAM_ID.toBase58() });
  cases.push(['a Token-2022 mint', write('t.json', journey(upstream.genesisHash(), { splMint: t22 })), /not the classic SPL Token program/]);
  for (const [name, file, re] of cases) {
    const r = await tryStart({ upstream, file });
    assert.equal(r.started, false, name);
    assert.match(r.error, /exited with 1/, name);
    assert.match(r.error, re, name);
  }
  upstream.setDown(true);
  const t0 = Date.now();
  const down = await tryStart({ upstream, file: path.join(dir, 'ok.json'), deadlineMs: 1500 });
  assert.equal(down.started, false);
  assert.match(down.error, /did not answer for 2 s|did not answer/);
  assert.ok(Date.now() - t0 >= 1400, 'it retried for the deadline');
});

async function journeyStack(t, { decimals = 9 } = {}) {
  const dir = makeTempDir('sti-journey-stack-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'journey-tokens.undeployed.json');
  // The genesis hash of the stack's mock upstream (a fixed value of the mock).
  const probe = await startMockUpstream();
  const genesis = probe.genesisHash();
  await probe.close();
  fs.writeFileSync(file, JSON.stringify(journey(genesis, { decimals })));
  const stack = await startStack({ midnightExtra: { journeyRegistry: file, accounts: { enabled: false } }, configExtra: { log: true }, beforeStart: (s) => s.upstream.setMint(splX, { decimals }) });
  t.after(() => stack.stop());
  return { stack, file, genesis };
}

test('T4.3-T4.5 names: I-4b in both metadata layouts; hot reload; the token registry and defaults for the rest', async (t) => {
  const { stack, file, genesis } = await journeyStack(t);
  const wallet = Keypair.generate().publicKey.toBase58();
  const vk = testViewingKey();
  assert.equal((await stack.register(wallet, vk)).status, 201);
  stack.tx(vk, [
    { segment: 0, outputIndex: 0, commitment: '01'.repeat(32), tokenType: X, value: '5000000000' },
    { segment: 0, outputIndex: 1, commitment: '02'.repeat(32), tokenType: T0, value: '7' },
    { segment: 0, outputIndex: 2, commitment: '03'.repeat(32), tokenType: UNKNOWN, value: '8' },
  ]);
  const conn = new Connection(stack.svc.url, 'confirmed');
  await waitFor(async () => (await conn.getTokenAccountsByOwner(new PublicKey(wallet), { programId: spl.TOKEN_2022_PROGRAM_ID })).value.length === 3, { what: 'three tokens', timeoutMs: 8000 });

  // T4.4: the bridged colour's synthetic mint, Token-2022 metadata and Metaplex v1, and its decimals.
  const md = await spl.getTokenMetadata(conn, mintOf(X));
  assert.equal(md.name, 'Test X (Midnight)');
  assert.equal(md.symbol, 'mnX');
  assert.equal((await spl.getMint(conn, mintOf(X), 'confirmed', spl.TOKEN_2022_PROGRAM_ID)).decimals, 9);
  const { Metadata } = require('@metaplex-foundation/mpl-token-metadata');
  const [meta] = Metadata.deserialize((await conn.getAccountInfo(metaplexPda(mintOf(X)))).data);
  assert.equal(meta.data.name.replace(/\0+$/, ''), 'Test X (Midnight)');
  assert.equal(meta.data.symbol.replace(/\0+$/, ''), 'mnX');
  const parsed = (await stack.svc.rpc('getTokenAccountsByOwner', [wallet, { mint: mintOf(X).toBase58() }, { encoding: 'jsonParsed' }])).result.value[0];
  assert.equal(parsed.account.data.parsed.info.tokenAmount.uiAmountString, '5');

  // T4.5: the injector's own registry still names 00..00; an unknown colour keeps the defaults.
  assert.equal((await spl.getTokenMetadata(conn, mintOf(T0))).name, 'Midnight Test Token');
  const unk = await spl.getTokenMetadata(conn, mintOf(UNKNOWN));
  assert.equal(unk.name, `Midnight ${UNKNOWN.slice(0, 8)}`);
  assert.equal(unk.symbol, `MN${UNKNOWN.slice(0, 4).toUpperCase()}`);

  // T4.3: an invalid edit (a duplicate colour) keeps the previous names, with a warning.
  const bad = journey(genesis);
  bad.tokens.push({ ...bad.tokens[0], splMint: Keypair.generate().publicKey.toBase58() });
  fs.writeFileSync(file, JSON.stringify(bad));
  await waitFor(() => stack.svc.output().includes('journey token registry reload failed, keeping the previous one'), { what: 'reload warning', timeoutMs: 5000 });
  assert.equal((await spl.getTokenMetadata(conn, mintOf(X))).name, 'Test X (Midnight)');
  // An edit that the upstream refuses (other decimals) is kept out too.
  fs.writeFileSync(file, JSON.stringify(journey(genesis, { decimals: 6 })));
  await waitFor(() => stack.svc.output().split('keeping the previous one').length > 2, { what: 'second reload warning', timeoutMs: 5000 });
  assert.equal((await spl.getMint(conn, mintOf(X), 'confirmed', spl.TOKEN_2022_PROGRAM_ID)).decimals, 9);
  // A valid edit changes the next answer without a restart.
  fs.writeFileSync(file, JSON.stringify(journey(genesis, { name: 'Renamed Token', symbol: 'RNT' })));
  await waitFor(async () => (await spl.getTokenMetadata(conn, mintOf(X))).name === 'Renamed Token (Midnight)', { what: 'renamed', timeoutMs: 5000 });
  assert.equal((await spl.getTokenMetadata(conn, mintOf(X))).symbol, 'mnRNT');
});
