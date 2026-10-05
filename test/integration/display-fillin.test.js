'use strict';
// AA 00059 P7 (owner, 00057 Q10): the token display follow-ups in the real service.
//   P7.1 a Metaplex metadata fill-in for a REAL SPL mint of the journey token registry, only when the
//        upstream has none; never the mint, its token accounts or balances; real metadata passes through.
//   P7.2 I-1 `image` (the Midnight half) and `splImage` (the real token).
//   P7.3 a generated token file (Night Market's tokens, twBTC with 8 decimals) loads through TOKEN_REGISTRY.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Keypair, PublicKey } = require('@solana/web3.js');
const spl = require('@solana/spl-token');
const { Metadata } = require('@metaplex-foundation/mpl-token-metadata');

const { startStack } = require('../helpers/stack');
const { waitFor, makeTempDir } = require('../helpers/service');
const { startMockUpstream } = require('../helpers/mock-upstream');
const { testViewingKey } = require('../helpers/keys');
const { MPL_TOKEN_METADATA, deriveKey, encodeMetaplexMetadata, metaplexPda } = require('../../src/tokens/accounts');
const { midnightTokenId } = require('../../src/tokens/midnight');

const ICONS = 'https://midnight-solana-token-icons.ac-edward.workers.dev';
const CX = 'ab'.repeat(32); // the Midnight half of X
const CY = 'cd'.repeat(32); // the Midnight half of Y
const X = Keypair.generate().publicKey.toBase58(); // real SPL mint, no metadata upstream
const Y = Keypair.generate().publicKey.toBase58(); // real SPL mint WITH metadata upstream
const OTHER = Keypair.generate().publicKey.toBase58(); // a mint the registry does not list
const pda = (m) => metaplexPda(new PublicKey(m)).toBase58();
const synthMint = (key) => deriveKey(`mint:${midnightTokenId('undeployed', key)}`).toBase58();
const T22 = spl.TOKEN_2022_PROGRAM_ID.toBase58();
const TOK = spl.TOKEN_PROGRAM_ID.toBase58();
const GENERATED = path.join(__dirname, '..', 'fixtures', 'tokens.undeployed.generated.json');

const entry = (o) => ({ bridgeContract: '12'.repeat(32), bridgeProgram: Keypair.generate().publicKey.toBase58(), bridgeApi: 'http://127.0.0.1:1', decimals: 6, ...o });
const journey = (genesis, o = {}) => ({
  midnightNetwork: 'undeployed',
  solanaGenesisHash: genesis,
  tokens: [
    entry({ colour: CX, splMint: X, name: 'X', symbol: 'X', image: `${ICONS}/x-midnight.png`, splImage: `${ICONS}/x.png`, ...o }),
    entry({ colour: CY, splMint: Y, name: 'Y', symbol: 'Y', image: `${ICONS}/y-midnight.png`, splImage: `${ICONS}/y.png` }),
  ],
});

async function setup(t, { env, tokenRegistry } = {}) {
  const dir = makeTempDir('aa00059-display-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const probe = await startMockUpstream();
  const genesis = probe.genesisHash();
  await probe.close();
  const file = path.join(dir, 'journey-tokens.undeployed.json');
  fs.writeFileSync(file, JSON.stringify(journey(genesis)));
  // Y's real metadata on the upstream ("Real Y" by a real authority).
  const realY = encodeMetaplexMetadata({ authority: Keypair.generate().publicKey, mint: new PublicKey(Y), name: 'Real Y', symbol: 'RY', uri: 'https://example.org/y.json' });
  const stack = await startStack({
    midnightExtra: { journeyRegistry: file, accounts: { enabled: false }, ...(tokenRegistry ? { tokenRegistry } : {}) },
    configExtra: { log: true },
    env,
    beforeStart: ({ upstream }) => {
      upstream.setMint(X, { decimals: 6 });
      upstream.setMint(Y, { decimals: 6 });
      upstream.setAccount(pda(Y), { owner: MPL_TOKEN_METADATA.toBase58(), data: realY });
    },
  });
  t.after(() => stack.stop());
  return { stack, file, genesis };
}

/** The same JSON-RPC body through the injector and straight to the mock upstream: the raw texts. */
async function both(stack, method, params, id = 7) {
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  const go = async (url) => (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).text();
  return { injector: await go(stack.svc.url), upstream: await go(stack.upstream.url) };
}

test('P7.1 a registry mint without upstream metadata gets a filled-in Metaplex account; everything else is untouched', async (t) => {
  const { stack } = await setup(t);
  // X: no metadata upstream -> the synthetic metadata account (name/symbol from I-1, uri -> JSON with splImage).
  const x = await both(stack, 'getAccountInfo', [pda(X), { encoding: 'base64' }]);
  assert.equal(JSON.parse(x.upstream).result.value, null);
  const xv = JSON.parse(x.injector).result.value;
  assert.equal(xv.owner, MPL_TOKEN_METADATA.toBase58());
  const [meta] = Metadata.deserialize(Buffer.from(xv.data[0], 'base64'));
  assert.equal(meta.mint.toBase58(), X);
  assert.equal(meta.data.name.replace(/\0+$/, ''), 'X');
  assert.equal(meta.data.symbol.replace(/\0+$/, ''), 'X');
  const uri = meta.data.uri.replace(/\0+$/, '');
  assert.equal(uri, `${stack.svc.url}/token-metadata/${encodeURIComponent(`spl:${X}`)}.json`);
  const json = await (await fetch(uri)).json();
  assert.equal(json.name, 'X');
  assert.equal(json.image, `${ICONS}/x.png`);
  // Y: real metadata upstream -> the upstream's answer, byte for byte.
  const y = await both(stack, 'getAccountInfo', [pda(Y), { encoding: 'base64' }]);
  assert.equal(y.injector, y.upstream);
  assert.notEqual(JSON.parse(y.upstream).result.value, null);
  // A mint the registry does not list: untouched.
  const o = await both(stack, 'getAccountInfo', [pda(OTHER), { encoding: 'base64' }]);
  assert.equal(o.injector, o.upstream);
  // The mints, token accounts and balances: untouched.
  const owner = Keypair.generate().publicKey.toBase58();
  for (const [m, p] of [
    ['getAccountInfo', [X, { encoding: 'jsonParsed' }]],
    ['getAccountInfo', [Y, { encoding: 'base64' }]],
    ['getTokenAccountsByOwner', [owner, { programId: TOK }, { encoding: 'jsonParsed' }]],
    ['getTokenAccountsByOwner', [owner, { mint: X }, { encoding: 'jsonParsed' }]],
    ['getBalance', [owner]],
    ['getMultipleAccounts', [[pda(Y), X], { encoding: 'base64' }]],
  ]) {
    const r = await both(stack, m, p);
    assert.equal(r.injector, r.upstream, `${m} ${JSON.stringify(p).slice(0, 60)}`);
  }
  // getMultipleAccounts with the fill-in among them: only its null slot is filled.
  const many = await both(stack, 'getMultipleAccounts', [[pda(X), pda(Y), X, pda(OTHER)], { encoding: 'base64' }]);
  const up = JSON.parse(many.upstream).result.value;
  const got = JSON.parse(many.injector).result.value;
  assert.equal(up[0], null);
  assert.equal(got[0].owner, MPL_TOKEN_METADATA.toBase58());
  assert.deepEqual(got.slice(1), up.slice(1));
  // A batch with the fill-in: filled there too.
  const batch = JSON.parse(await (await fetch(stack.svc.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [pda(X), { encoding: 'base64' }] }, { jsonrpc: '2.0', id: 2, method: 'getAccountInfo', params: [pda(Y), { encoding: 'base64' }] }]) })).text());
  assert.equal(batch.find((r) => r.id === 1).result.value.owner, MPL_TOKEN_METADATA.toBase58());
  assert.deepEqual(batch.find((r) => r.id === 2).result.value, JSON.parse(y.upstream).result.value);
  // No synthetic Token-2022 account was created for the real mints.
  assert.deepEqual(JSON.parse((await both(stack, 'getTokenAccountsByOwner', [owner, { programId: T22 }, { encoding: 'jsonParsed' }])).injector).result.value, []);
});

test('P7.1 when the upstream gains real metadata it wins; a registry edit re-points the filled-in icon', async (t) => {
  const { stack, file, genesis } = await setup(t);
  // A valid edit: X's SPL icon changes; the served JSON follows without a restart.
  fs.writeFileSync(file, JSON.stringify(journey(genesis, { splImage: `${ICONS}/midnight.png` })));
  const uri = `${stack.svc.url}/token-metadata/${encodeURIComponent(`spl:${X}`)}.json`;
  await waitFor(async () => (await (await fetch(uri)).json()).image === `${ICONS}/midnight.png`, { what: 'new splImage', timeoutMs: 5000 });
  // Real metadata appears upstream for X: the injector passes it through, byte for byte.
  const realX = encodeMetaplexMetadata({ authority: Keypair.generate().publicKey, mint: new PublicKey(X), name: 'Real X', symbol: 'RX', uri: 'https://example.org/x.json' });
  stack.upstream.setAccount(pda(X), { owner: MPL_TOKEN_METADATA.toBase58(), data: realX });
  const x = await both(stack, 'getAccountInfo', [pda(X), { encoding: 'base64' }]);
  assert.equal(x.injector, x.upstream);
});

test('P7.2 the Midnight half shows the I-1 image when the token registry gives none; the registry image wins otherwise', async (t) => {
  const { stack } = await setup(t);
  const owner = Keypair.generate().publicKey.toBase58();
  const vk = testViewingKey();
  assert.equal((await stack.register(owner, vk)).status, 201);
  stack.tx(vk, [{ segment: 0, outputIndex: 0, commitment: '01'.repeat(32), tokenType: CX, value: '5000000' }]);
  await waitFor(async () => (await (await fetch(`${stack.svc.url}/token-metadata/${encodeURIComponent(midnightTokenId('undeployed', CX))}.json`)).json().catch(() => null))?.name === 'X (Midnight)', { what: 'X (Midnight) metadata', timeoutMs: 8000 });
  const j = await (await fetch(`${stack.svc.url}/token-metadata/${encodeURIComponent(midnightTokenId('undeployed', CX))}.json`)).json();
  assert.equal(j.image, `${ICONS}/x-midnight.png`);
  assert.equal(j.symbol, 'mnX');
  assert.ok(synthMint(CX));
});

test('P7.3 a generated token file (Night Market tokens, twBTC 8 decimals, icons) loads through TOKEN_REGISTRY: 10,000,000 twBTC base units show as 0.1', async (t) => {
  const { stack } = await setup(t, { env: { TOKEN_REGISTRY: GENERATED } });
  const reg = JSON.parse(fs.readFileSync(GENERATED, 'utf8'));
  const twbtc = Object.entries(reg.tokens).find(([, v]) => v.symbol === 'twBTC')[0];
  const twusdc = Object.entries(reg.tokens).find(([, v]) => v.symbol === 'twUSDC')[0];
  const owner = Keypair.generate().publicKey.toBase58();
  const vk = testViewingKey();
  assert.equal((await stack.register(owner, vk)).status, 201);
  stack.tx(vk, [
    { segment: 0, outputIndex: 0, commitment: '02'.repeat(32), tokenType: twbtc, value: '10000000' },
    { segment: 0, outputIndex: 1, commitment: '03'.repeat(32), tokenType: twusdc, value: '1000000000' },
  ]);
  const accounts = async () => (await stack.svc.rpc('getTokenAccountsByOwner', [owner, { programId: T22 }, { encoding: 'jsonParsed' }])).result.value;
  await waitFor(async () => (await accounts()).length === 2, { what: 'two tokens', timeoutMs: 8000 });
  const byMint = Object.fromEntries((await accounts()).map((a) => [a.account.data.parsed.info.mint, a.account.data.parsed.info.tokenAmount]));
  assert.deepEqual({ amount: byMint[synthMint(twbtc)].amount, decimals: byMint[synthMint(twbtc)].decimals, ui: byMint[synthMint(twbtc)].uiAmountString }, { amount: '10000000', decimals: 8, ui: '0.1' });
  assert.equal(byMint[synthMint(twusdc)].uiAmountString, '1000');
  const meta = await (await fetch(`${stack.svc.url}/token-metadata/${encodeURIComponent(midnightTokenId('undeployed', twbtc))}.json`)).json();
  assert.equal(meta.name, 'twBTC (Midnight)');
  assert.equal(meta.image, `${ICONS}/twbtc.png`);
});
