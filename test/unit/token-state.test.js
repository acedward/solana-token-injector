'use strict';
// C.2: dynamic token state — Midnight specs, sums, clamp, defaults, swaps.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Keypair, PublicKey } = require('@solana/web3.js');
const spl = require('@solana/spl-token');
const { buildTokenState } = require('../../src/tokens/state');
const { createTokenManager } = require('../../src/tokens/manager');
const { midnightTokenSpecs, midnightTokenId, defaultTokenInfo } = require('../../src/tokens/midnight');
const { deriveKey } = require('../../src/tokens/accounts');
const { U64_MAX } = require('../../src/amounts');

const T0 = '0'.repeat(64);
const T1 = `${'0'.repeat(63)}1`;
const TX = `0a1b2c3d${'e'.repeat(56)}`;
const addr = () => Keypair.generate().publicKey.toBase58();
const reg = (solanaAddress, totals) => ({ solanaAddress, totals: new Map(Object.entries(totals)) });
const mintOf = (type, net = 'undeployed') => deriveKey(`mint:${midnightTokenId(net, type)}`).toBase58();
const ataOf = (type, owner) =>
  spl.getAssociatedTokenAddressSync(new PublicKey(mintOf(type)), new PublicKey(owner), false, spl.TOKEN_2022_PROGRAM_ID).toBase58();
const lookup = (t) => (t === T0 ? { name: 'Midnight Test Token', symbol: 'MNTT', decimals: 6 } : null);
const build = (registrations) =>
  buildTokenState(midnightTokenSpecs({ networkId: 'undeployed', registrations, lookup }), { publicUrl: 'http://127.0.0.1:1' });

test('two holders of one Midnight type: one Token-2022 mint, two token accounts, supply = sum', () => {
  const a = addr();
  const b = addr();
  const s = build([reg(a, { [T0]: 100n }), reg(b, { [T0]: 50n })]);
  const m = s.mints.get(mintOf(T0));
  assert.ok(m, 'mint exists');
  assert.equal(m.programId, spl.TOKEN_2022_PROGRAM_ID.toBase58());
  assert.equal(m.supply, 150n);
  assert.equal(m.name, 'Midnight Test Token');
  assert.equal(m.symbol, 'MNTT');
  assert.equal(s.tokenAccounts.get(ataOf(T0, a)).amount, 100n);
  assert.equal(s.tokenAccounts.get(ataOf(T0, b)).amount, 50n);
  assert.deepEqual(s.byOwner.get(a), [ataOf(T0, a)]);
  const parsedMint = s.accounts.get(mintOf(T0)).parsed.parsed.info;
  assert.equal(parsedMint.extensions[1].state.name, 'Midnight Test Token');
});

test('several keys on one address: amounts summed per token type (Q12)', () => {
  const a = addr();
  const s = build([reg(a, { [T0]: 100n, [T1]: 5n }), reg(a, { [T0]: 23n })]);
  assert.equal(s.tokenAccounts.get(ataOf(T0, a)).amount, 123n);
  assert.equal(s.tokenAccounts.get(ataOf(T1, a)).amount, 5n);
  assert.equal(s.byOwner.get(a).length, 2);
});

test('zero totals and empty registrations inject nothing', () => {
  const a = addr();
  const s = build([reg(a, { [T0]: 0n }), reg(addr(), {})]);
  assert.equal(s.mints.size, 0);
  assert.equal(s.byOwner.size, 0);
});

test('amount above u64::MAX is clamped and flagged (Q11)', () => {
  const a = addr();
  const b = addr();
  const huge = U64_MAX + 5n;
  const s = build([reg(a, { [T0]: huge }), reg(b, { [T0]: U64_MAX })]);
  const m = s.mints.get(mintOf(T0));
  assert.equal(s.tokenAccounts.get(ataOf(T0, a)).amount, U64_MAX);
  assert.equal(m.clamped, true);
  assert.equal(m.supply, U64_MAX, 'supply clamped too');
  assert.equal(m.holders.find((h) => h.owner === a).clamped, true);
  assert.equal(m.holders.find((h) => h.owner === b).clamped, false);
  const decoded = spl.unpackAccount(new PublicKey(ataOf(T0, a)), { data: s.accounts.get(ataOf(T0, a)).data, owner: spl.TOKEN_2022_PROGRAM_ID, lamports: 1, executable: false }, spl.TOKEN_2022_PROGRAM_ID);
  assert.equal(decoded.amount, U64_MAX);
});

test('unknown token type gets the default name / symbol / decimals (I-5)', () => {
  assert.deepEqual(defaultTokenInfo(TX), { name: 'Midnight 0a1b2c3d', symbol: 'MN0A1B', decimals: 6 });
  const a = addr();
  const s = build([reg(a, { [TX]: 7n })]);
  const m = s.mints.get(mintOf(TX));
  assert.equal(m.name, 'Midnight 0a1b2c3d');
  assert.equal(m.symbol, 'MN0A1B');
  assert.equal(m.decimals, 6);
  assert.equal(m.id, `midnight:undeployed:${TX}`);
  assert.ok(s.metadataJson.has(m.id), 'metadata JSON served for the token');
});

test('a spec that cannot be encoded is skipped, the others stay', () => {
  const warnings = [];
  const a = addr();
  const s = buildTokenState(
    [
      { id: 'bad', name: 'x'.repeat(40), symbol: 'BAD', decimals: 0, program: 'token', holders: [[a, 1n]] },
      { id: 'good', name: 'Good', symbol: 'GOOD', decimals: 0, program: 'token', holders: [[a, 2n]] },
    ],
    { publicUrl: 'http://x', onError: (spec, err) => warnings.push(`${spec.id}: ${err.message}`) },
  );
  assert.equal(s.mints.size, 1);
  assert.equal(s.byOwner.get(a).length, 1, 'no half-added accounts from the bad token');
  assert.match(warnings[0], /^bad: name/);
});

test('manager: debounced rebuild swaps the state atomically', async () => {
  const a = addr();
  let regs = [reg(a, { [T0]: 1n })];
  const m = createTokenManager({
    publicUrl: 'http://x',
    midnightSpecs: () => midnightTokenSpecs({ networkId: 'undeployed', registrations: regs, lookup }),
    debounceMs: 30,
  });
  const before = m.getState();
  const v0 = m.getVersion();
  assert.equal(before.tokenAccounts.get(ataOf(T0, a)).amount, 1n);
  regs = [reg(a, { [T0]: 2n })];
  m.invalidate();
  regs = [reg(a, { [T0]: 3n })];
  m.invalidate(); // coalesced with the first
  assert.equal(m.getState(), before, 'old state until the debounce fires');
  await m.settled();
  assert.equal(m.getVersion(), v0 + 1, 'one rebuild for two invalidations');
  assert.equal(m.getState().tokenAccounts.get(ataOf(T0, a)).amount, 3n);
  assert.equal(before.tokenAccounts.get(ataOf(T0, a)).amount, 1n, 'old state object untouched');
  m.stop();
});

test('manager: static and Midnight tokens side by side', () => {
  const a = addr();
  const m = createTokenManager({
    publicUrl: 'http://x',
    staticSpecs: [{ id: 'NIGHT', name: 'Night', symbol: 'NIGHT', decimals: 6, program: 'token', holders: [[a, 5n]] }],
    midnightSpecs: () => midnightTokenSpecs({ networkId: 'undeployed', registrations: [reg(a, { [T0]: 9n })], lookup }),
  });
  const s = m.getState();
  assert.equal(s.mints.size, 2);
  assert.equal(s.byOwner.get(a).length, 2);
  m.stop();
});

test('P7.1 fill-ins: a Metaplex account apart from the synthetic accounts, name/symbol cut to the Metaplex limits, JSON with the image', () => {
  const { buildTokenState } = require('../../src/tokens/state');
  const { metaplexPda, MPL_TOKEN_METADATA } = require('../../src/tokens/accounts');
  const { PublicKey, Keypair } = require('@solana/web3.js');
  const { Metadata } = require('@metaplex-foundation/mpl-token-metadata');
  const mint = Keypair.generate().publicKey.toBase58();
  const s = buildTokenState([], { publicUrl: 'http://127.0.0.1:1', fillIns: [{ mint, name: 'A very long token name that exceeds thirty-two bytes', symbol: 'SYMBOL12345', image: 'https://i/x.png' }] });
  const pda = metaplexPda(new PublicKey(mint)).toBase58();
  assert.equal(s.accounts.size, 0, 'no synthetic account for a real mint');
  assert.equal(s.mints.size, 0);
  const acct = s.fillIns.get(pda);
  assert.equal(acct.owner, MPL_TOKEN_METADATA.toBase58());
  const [meta] = Metadata.deserialize(acct.data);
  assert.equal(Buffer.byteLength(meta.data.name.replace(/\0+$/, '')), 32);
  assert.equal(meta.data.symbol.replace(/\0+$/, ''), 'SYMBOL1234');
  assert.equal(s.metadataJson.get(`spl:${mint}`).image, 'https://i/x.png');
  assert.equal(meta.data.uri.replace(/\0+$/, ''), `http://127.0.0.1:1/token-metadata/${encodeURIComponent(`spl:${mint}`)}.json`);
});
